/**
 * Pull public tab media from the live Laravel API, upload to our S3, rewrite new DB URLs.
 *
 * Laravel (read-only):
 *   GET https://app.vbizme.com/api/v/{slug}
 *   GET /post-types?profile_id={legacyId}
 *   GET /dynamic-section/{tabName}?profile_id={legacyId}
 *
 * Then for each items[].featured_image / items[].attachments[].url
 * (and profile/intro/background media): download → S3 → update matching
 * Profile/Post/Service/Portfolio/Attachment by slug + legacyId.
 *
 * Usage:
 *   yarn sync:laravel-media -- --slug=william-rodriguez
 *   yarn sync:laravel-media -- --slug=william-rodriguez --dry-run
 *   yarn sync:laravel-media -- --all --resume
 */
import fs from 'fs'
import path from 'path'
import config from '../src/configs/config'
import logger from '../src/utils/logger'
import {
  encodeUrlPath,
  isAbsoluteMediaUrl,
  isAlreadyOnS3,
  legacySourceUrlCandidates,
  mediaFilename,
} from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

const LARAVEL_API = (process.env.LARAVEL_API_BASE || 'https://app.vbizme.com/api').replace(/\/$/, '')
const NODE_PUBLIC_API = (process.env.NODE_PUBLIC_API_BASE || 'https://api.vbizme.com/api/v1/public').replace(/\/$/, '')
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.MEDIA_MIGRATE_CONCURRENCY) || 3))
const USER_AGENT =
  process.env.VBIZME_USER_AGENT || 'Mozilla/5.0 (compatible; vbizme-laravel-tab-sync/1.1; +https://vbiz.me)'

const EXTRA_TABS = [
  'Why Choose Us',
  'Mission Statement',
  'blog',
  'services',
  'gallery',
  'video',
  'Videos',
  '2D Video Explainer',
  'Certificates Licenses',
  'Certifications/Licenses',
  'Faq',
  'Reviews',
  'Video Links',
  'About Me',
]

const SKIP_HOST = /youtube\.com|youtu\.be|vimeo\.com|facebook\.com|instagram\.com|tiktok\.com/i

type MediaHit = {
  section: string
  itemLegacyId: number | null
  itemId: string | null
  attachmentLegacyId: number | null
  attachmentTypeLegacyId: number | null
  kind: 'profile' | 'post' | 'service' | 'portfolio' | 'attachment'
  field: string
  url: string
}

type SyncResult = {
  slug: string
  status: 'complete' | 'laravel_not_found' | 'db_not_found' | 'incomplete' | 'dry_run'
  laravelId?: number
  tabs: number
  media: number
  uploaded: number
  skipped: number
  failed: number
  errors: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv: string[]) {
  let slug: string | undefined = process.env.npm_config_slug || process.env.VBIZME_SYNC_SLUG
  let all = argv.includes('--all') || process.env.npm_config_all === 'true' || process.env.VBIZME_SYNC_ALL === '1'
  let dryRun = argv.includes('--dry-run') || process.env.npm_config_dry_run === 'true'
  let resume = argv.includes('--resume') || process.env.npm_config_resume === 'true'
  let slugsFile: string | undefined = process.env.npm_config_slugsfile || process.env.VBIZME_SLUGS_FILE
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--resume') resume = true
    else if (arg.startsWith('--slug=')) slug = arg.slice('--slug='.length).trim()
    else if (arg === '--slug') slug = argv[++i]?.trim()
    else if (arg.startsWith('--slugsFile=')) slugsFile = arg.slice('--slugsFile='.length).trim()
    else if (arg === '--slugsFile') slugsFile = argv[++i]?.trim()
  }
  return { slug, all, dryRun, resume, slugsFile }
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code?: string }).code || '')
    if (code === 'P1000') {
      const url = process.env.DATABASE_URL || ''
      let host = '(unknown)'
      try {
        host = new URL(url.replace(/^postgresql:\/\//, 'http://')).host
      } catch {
        host = url.split('@')[1]?.split('/')[0] || host
      }
      return (
        `Database login failed (Prisma P1000). Postgres rejected user "vbizme_app" at ${host}. ` +
        `Fix DATABASE_URL in .env (user/password/host) so it matches the same database your API uses, then rerun yarn.`
      )
    }
  }
  if (err instanceof Error) return err.stack || err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

async function laravelGet(apiPath: string): Promise<{ status: number; json: unknown; url: string }> {
  const url = apiPath.startsWith('http') ? apiPath : `${LARAVEL_API}${apiPath}`
  let lastStatus = 0
  let json: unknown = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, Referer: 'https://app.vbizme.com/' },
      redirect: 'follow',
    })
    lastStatus = response.status
    const text = await response.text()
    try {
      json = JSON.parse(text)
    } catch {
      json = { _non_json: true, text: text.slice(0, 200) }
    }
    if (response.status === 429 && attempt < 4) {
      await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250))
      continue
    }
    return { status: lastStatus, json, url }
  }
  return { status: lastStatus, json, url }
}

function numericId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function envelope(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null
  const row = json as Record<string, unknown>
  if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
    return row.data as Record<string, unknown>
  }
  return row
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function pushUrl(
  hits: MediaHit[],
  hit: Omit<MediaHit, 'attachmentTypeLegacyId'> & { attachmentTypeLegacyId?: number | null }
) {
  if (!hit.url || !isAbsoluteMediaUrl(hit.url)) return
  if (SKIP_HOST.test(hit.url)) return
  hits.push({ ...hit, attachmentTypeLegacyId: hit.attachmentTypeLegacyId ?? null })
}

function fileKey(url: string): string {
  const name = mediaFilename(url, null) || url
  return name.trim().toLowerCase()
}

async function fetchOk(url: string): Promise<boolean> {
  try {
    const encoded = encodeUrlPath(url)
    const get = await fetch(encoded, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Referer: 'https://app.vbizme.com/',
      },
      redirect: 'follow',
    })
    if (!(get.ok || get.status === 206)) return false
    const ct = get.headers.get('content-type') || ''
    return !ct.includes('text/html')
  } catch {
    return false
  }
}

async function resolveWorkingUrl(
  urls: string[],
  laravelId: number | null,
  typeLegacyId?: number | null,
  profileSlug?: string
): Promise<string | null> {
  const candidates: string[] = []
  for (const url of urls) {
    for (const c of legacySourceUrlCandidates(
      {
        url,
        docName: mediaFilename(url, null),
        attachmentTypeLegacyId: typeLegacyId ?? null,
        profileLegacyId: laravelId ?? undefined,
        profileSlug,
      },
      { mode: 'exhaustive' }
    )) {
      if (!candidates.includes(c)) candidates.push(c)
    }
  }
  for (const candidate of candidates) {
    if (await fetchOk(candidate)) return encodeUrlPath(candidate)
  }
  return null
}

function collectFeaturedAndAttachments(
  section: string,
  item: Record<string, unknown>,
  kind: MediaHit['kind']
): MediaHit[] {
  const hits: MediaHit[] = []
  const itemLegacyId = numericId(item.id)
  const itemId = itemLegacyId == null && typeof item.id === 'string' ? item.id : null
  const featured = item.featured_image
  if (typeof featured === 'string') {
    pushUrl(hits, {
      section,
      itemLegacyId,
      itemId,
      attachmentLegacyId: null,
      kind,
      field: 'featured_image',
      url: featured,
    })
  } else if (Array.isArray(featured)) {
    for (const entry of featured) {
      const rec = asRecord(entry)
      const url = typeof rec?.url === 'string' ? rec.url : typeof entry === 'string' ? entry : ''
      const attId = numericId(rec?.id)
      pushUrl(hits, {
        section,
        itemLegacyId,
        itemId,
        attachmentLegacyId: attId,
        kind: rec?.id ? 'attachment' : kind,
        field: 'featured_image',
        url,
      })
    }
  } else if (asRecord(featured)?.url) {
    pushUrl(hits, {
      section,
      itemLegacyId,
      itemId,
      attachmentLegacyId: numericId(asRecord(featured)?.id),
      kind,
      field: 'featured_image',
      url: String(asRecord(featured)?.url),
    })
  }
  const attachments = item.attachments
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      const rec = asRecord(att)
      if (!rec || typeof rec.url !== 'string') continue
      const attId = numericId(rec.id)
      const typeId = numericId(rec.attachment_type_id)
      pushUrl(hits, {
        section,
        itemLegacyId,
        itemId,
        attachmentLegacyId: attId,
        attachmentTypeLegacyId: typeId ?? 8,
        kind: 'attachment',
        field: 'attachments',
        url: rec.url,
      })
    }
  }
  return hits
}

function collectProfileMedia(card: Record<string, unknown>): MediaHit[] {
  const hits: MediaHit[] = []
  for (const field of ['profile_media', 'intro_video', 'background_media', 'background_audio'] as const) {
    const block = asRecord(card[field])
    if (!block) continue
    for (const key of ['url', 'video_url', 'fallback_url']) {
      if (typeof block[key] === 'string') {
        pushUrl(hits, {
          section: 'profile',
          itemLegacyId: null,
          itemId: null,
          attachmentLegacyId: null,
          kind: 'profile',
          field: `${field}.${key}`,
          url: block[key] as string,
        })
      }
    }
    const regular = asRecord(block.regular_video)
    if (typeof regular?.url === 'string') {
      pushUrl(hits, {
        section: 'profile',
        itemLegacyId: null,
        itemId: null,
        attachmentLegacyId: null,
        kind: 'profile',
        field: `${field}.regular_video.url`,
        url: regular.url,
      })
    }
  }
  return hits
}

function sectionKind(name: string): MediaHit['kind'] {
  if (/^services$/i.test(name) || /^additional services$/i.test(name)) return 'service'
  if (/^gallery$/i.test(name) || /^portfolio$/i.test(name)) return 'portfolio'
  return 'post'
}

function s3Folder(kind: MediaHit['kind'], section: string): string {
  const prefix = config.S3.KEY_PREFIX || 'vbizme'
  if (kind === 'service' || /^services$/i.test(section)) return `${prefix}/services`
  if (kind === 'portfolio' || /gallery|portfolio/i.test(section)) return `${prefix}/portfolios`
  if (kind === 'profile') return `${prefix}/profiles`
  return `${prefix}/posts`
}

async function rewriteRow(hit: MediaHit, profileId: string, newUrl: string) {
  if (hit.attachmentLegacyId != null) {
    const att = await prisma.attachment.findFirst({
      where: { legacyId: hit.attachmentLegacyId, profileId },
    })
    if (att) {
      await prisma.attachment.update({ where: { id: att.id }, data: { url: newUrl } })
    }
  }
  if (hit.kind === 'attachment' && hit.itemId) {
    await prisma.attachment.updateMany({ where: { id: hit.itemId, profileId }, data: { url: newUrl } })
  }
  if (hit.kind === 'service' && (hit.itemLegacyId != null || hit.itemId)) {
    const row = hit.itemId
      ? await prisma.service.findFirst({ where: { id: hit.itemId, profileId } })
      : await prisma.service.findFirst({ where: { legacyId: hit.itemLegacyId!, profileId } })
    if (row) await prisma.service.update({ where: { id: row.id }, data: { imageUrl: newUrl } })
  }
  if (hit.kind === 'portfolio' && (hit.itemLegacyId != null || hit.itemId)) {
    const row = hit.itemId
      ? await prisma.portfolio.findFirst({ where: { id: hit.itemId, profileId } })
      : await prisma.portfolio.findFirst({ where: { legacyId: hit.itemLegacyId!, profileId } })
    if (row) await prisma.portfolio.update({ where: { id: row.id }, data: { imageUrl: newUrl } })
  }
  if ((hit.kind === 'post' || hit.field === 'featured_image') && (hit.itemLegacyId != null || hit.itemId)) {
    const row = hit.itemId
      ? await prisma.post.findFirst({ where: { id: hit.itemId, profileId } })
      : await prisma.post.findFirst({ where: { legacyId: hit.itemLegacyId!, profileId } })
    if (row) await prisma.post.update({ where: { id: row.id }, data: { featuredImage: newUrl } })
  }
  if (hit.kind === 'profile' && /profile_media|avatar/i.test(hit.field) && !/fallback/i.test(hit.field)) {
    await prisma.profile.update({ where: { id: profileId }, data: { avatar: newUrl } })
  }
  if (hit.url && hit.url !== newUrl) {
    await prisma.attachment.updateMany({ where: { profileId, url: hit.url }, data: { url: newUrl } })
    await prisma.post.updateMany({ where: { profileId, featuredImage: hit.url }, data: { featuredImage: newUrl } })
    await prisma.service.updateMany({ where: { profileId, imageUrl: hit.url }, data: { imageUrl: newUrl } })
    await prisma.portfolio.updateMany({ where: { profileId, imageUrl: hit.url }, data: { imageUrl: newUrl } })
  }
}

function summarizeJson(json: unknown): string {
  const rec = asRecord(json)
  if (!rec) return String(json ?? '').slice(0, 160)
  if (rec._non_json) return String(rec.text || 'non-json body').slice(0, 160)
  if (typeof rec.message === 'string') return rec.message.slice(0, 160)
  try {
    return JSON.stringify(rec).slice(0, 160)
  } catch {
    return 'unreadable json'
  }
}

async function collectFromDatabase(profileId: string, avatar?: string | null): Promise<MediaHit[]> {
  const hits: MediaHit[] = []
  if (avatar) {
    pushUrl(hits, {
      section: 'profile',
      itemLegacyId: null,
      itemId: profileId,
      attachmentLegacyId: null,
      kind: 'profile',
      field: 'avatar',
      url: avatar,
    })
  }
  const attachments = await prisma.attachment.findMany({
    where: { profileId },
    select: {
      id: true,
      url: true,
      legacyId: true,
      attachmentType: { select: { legacyId: true } },
    },
  })
  for (const att of attachments) {
    if (!att.url) continue
    pushUrl(hits, {
      section: 'db-attachment',
      itemLegacyId: null,
      itemId: att.id,
      attachmentLegacyId: att.legacyId,
      attachmentTypeLegacyId: att.attachmentType?.legacyId ?? 8,
      kind: 'attachment',
      field: 'url',
      url: att.url,
    })
  }
  const posts = await prisma.post.findMany({
    where: { profileId, featuredImage: { not: null } },
    select: { id: true, featuredImage: true, legacyId: true },
  })
  for (const post of posts) {
    if (!post.featuredImage) continue
    pushUrl(hits, {
      section: 'db-post',
      itemLegacyId: post.legacyId,
      itemId: post.id,
      attachmentLegacyId: null,
      kind: 'post',
      field: 'featured_image',
      url: post.featuredImage,
    })
  }
  const services = await prisma.service.findMany({
    where: { profileId, imageUrl: { not: null } },
    select: { id: true, imageUrl: true, legacyId: true },
  })
  for (const service of services) {
    if (!service.imageUrl) continue
    pushUrl(hits, {
      section: 'db-service',
      itemLegacyId: service.legacyId,
      itemId: service.id,
      attachmentLegacyId: null,
      kind: 'service',
      field: 'imageUrl',
      url: service.imageUrl,
    })
  }
  const portfolios = await prisma.portfolio.findMany({
    where: { profileId, imageUrl: { not: null } },
    select: { id: true, imageUrl: true, legacyId: true },
  })
  for (const portfolio of portfolios) {
    if (!portfolio.imageUrl) continue
    pushUrl(hits, {
      section: 'db-portfolio',
      itemLegacyId: portfolio.legacyId,
      itemId: portfolio.id,
      attachmentLegacyId: null,
      kind: 'portfolio',
      field: 'imageUrl',
      url: portfolio.imageUrl,
    })
  }
  return hits
}

async function collectLaravelTabs(laravelId: number, errors: string[]): Promise<{ hits: MediaHit[]; tabsOk: number }> {
  const hits: MediaHit[] = []
  await sleep(120)
  const tabsRes = await laravelGet(`/post-types?profile_id=${laravelId}`)
  const tabsData = envelope(tabsRes.json) || {}
  const postTypes = Array.isArray(tabsData.post_types) ? tabsData.post_types : []
  const names = new Map<string, 'nav' | 'extra'>()
  for (const row of postTypes) {
    const rec = asRecord(row)
    const name = String(rec?.name || rec?.title || '')
    if (name.trim() && !/^home$/i.test(name) && !/^cards$/i.test(name) && !/^public cards$/i.test(name)) {
      names.set(name, 'nav')
    }
  }
  for (const extra of EXTRA_TABS) {
    if (![...names.keys()].some((n) => n.trim().toLowerCase() === extra.toLowerCase())) {
      names.set(extra, 'extra')
    }
  }

  let tabsOk = 0
  for (const [name, source] of names) {
    await sleep(120)
    const encoded = encodeURIComponent(name)
    const sec = await laravelGet(`/dynamic-section/${encoded}?profile_id=${laravelId}`)
    const data = envelope(sec.json)
    const items = Array.isArray(data?.items) ? data.items : []
    if (sec.status !== 200) {
      if (source === 'nav') errors.push(`tab ${name}: HTTP ${sec.status}`)
      continue
    }
    tabsOk += 1
    const kind = sectionKind(name)
    for (const raw of items) {
      const item = asRecord(raw)
      if (!item) continue
      hits.push(...collectFeaturedAndAttachments(name, item, kind))
    }
  }
  return { hits, tabsOk }
}

async function syncSlug(slug: string, dryRun: boolean): Promise<SyncResult> {
  const errors: string[] = []
  const dbProfile = await prisma.profile.findFirst({
    where: {
      OR: [{ slug: { equals: slug.trim(), mode: 'insensitive' } }],
    },
    select: { id: true, slug: true, legacyId: true, avatar: true },
  })

  const cardRes = await laravelGet(`/v/${encodeURIComponent(slug)}`)
  const card = envelope(cardRes.json)
  const laravelProfile = asRecord(card?.profile)
  let laravelId = numericId(laravelProfile?.id) ?? dbProfile?.legacyId ?? null
  logger.info(
    `  laravel /v/${slug} HTTP ${cardRes.status} numericId=${numericId(laravelProfile?.id) ?? 'none'} dbLegacyId=${dbProfile?.legacyId ?? 'none'}`
  )
  if (!laravelId && cardRes.status !== 200) {
    errors.push(`Laravel /v/${slug} HTTP ${cardRes.status}: ${summarizeJson(cardRes.json)}`)
  } else if (!numericId(laravelProfile?.id) && laravelId) {
    errors.push(`Laravel /v/${slug} had no numeric id (HTTP ${cardRes.status}); using DB legacyId=${laravelId}`)
  }

  if (!dbProfile) {
    return {
      slug,
      status: 'db_not_found',
      laravelId: laravelId ?? undefined,
      tabs: 0,
      media: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: [`No new-backend profile for slug=${slug}${laravelId ? ` legacyId=${laravelId}` : ''}`],
    }
  }

  const hits: MediaHit[] = []
  if (card) hits.push(...collectProfileMedia(card))
  const cardSlug = dbProfile.slug ?? slug

  try {
    const nodeCard = await laravelGet(`${NODE_PUBLIC_API}/v/${encodeURIComponent(cardSlug)}`)
    const nodeData = envelope(nodeCard.json)
    if (nodeData) hits.push(...collectProfileMedia(nodeData))
  } catch (err) {
    errors.push(`Node public /v/: ${err instanceof Error ? err.message : String(err)}`)
  }

  let tabsOk = 0
  if (laravelId != null) {
    const fromTabs = await collectLaravelTabs(laravelId, errors)
    hits.push(...fromTabs.hits)
    tabsOk = fromTabs.tabsOk
  }

  hits.push(...(await collectFromDatabase(dbProfile.id, dbProfile.avatar)))

  if (!hits.length && laravelId == null) {
    return {
      slug,
      status: 'laravel_not_found',
      tabs: 0,
      media: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: errors.length ? errors : ['No Laravel profile id and no DB media URLs'],
    }
  }

  const uniqueByFile = new Map<string, MediaHit[]>()
  for (const hit of hits) {
    const key = fileKey(hit.url)
    const list = uniqueByFile.get(key) || []
    list.push(hit)
    uniqueByFile.set(key, list)
  }

  let uploaded = 0
  let skipped = 0
  let failed = 0

  const entries = [...uniqueByFile.entries()]
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(async ([key, related]) => {
        const urls = [...new Set(related.map((h) => h.url))]
        if (urls.every((u) => isAlreadyOnS3(u))) {
          skipped += related.length
          const s3Url = urls.find((u) => isAlreadyOnS3(u)) || urls[0]
          for (const hit of related) await rewriteRow(hit, dbProfile.id, s3Url)
          return
        }
        if (dryRun) {
          logger.info(`[dry-run] ${slug} ${related[0].section} ${key}`)
          uploaded += related.length
          return
        }
        const typeId = related.find((h) => h.attachmentTypeLegacyId != null)?.attachmentTypeLegacyId
        const working = await resolveWorkingUrl(urls, laravelId, typeId ?? undefined, cardSlug)
        if (!working) {
          failed += related.length
          errors.push(`${related[0].section} ${urls[0]}: SOURCE_MISSING after folder fallbacks`)
          logger.error(`[fail] ${slug} no working URL for ${key} (tried posts/featuredImages/...)`)
          return
        }
        try {
          const folder = s3Folder(related[0].kind, related[0].section)
          const uploadedFile = await s3Utils.uploadFromUrl(working, { folder })
          for (const hit of related) {
            await rewriteRow(hit, dbProfile.id, uploadedFile.url)
          }
          uploaded += related.length
          logger.info(`[ok] ${slug} ${related[0].section} ${key} -> ${uploadedFile.url}`)
        } catch (err) {
          failed += related.length
          const message = err instanceof Error ? err.message : String(err)
          errors.push(`${related[0].section} ${working}: ${message}`)
          logger.error(`[fail] ${slug} ${working}`, err)
        }
      })
    )
  }

  const status = dryRun ? 'dry_run' : failed ? 'incomplete' : 'complete'
  return {
    slug,
    status,
    laravelId: laravelId ?? undefined,
    tabs: tabsOk,
    media: hits.length,
    uploaded,
    skipped,
    failed,
    errors,
  }
}

function loadSlugs(filePath?: string): string[] {
  const candidates = [
    filePath,
    process.env.VBIZME_SLUGS_FILE,
    path.resolve(process.cwd(), 'scripts/public-slugs.txt'),
    'E:/2026-07-07/Orderly-affairs-backend-1/migration/slugs.txt',
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs
        .readFileSync(candidate, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    }
  }
  throw new Error('No slugs file found. Pass --slugsFile= or --slug=')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.slug && !args.all) {
    logger.error('Usage: yarn sync:laravel-media -- --slug=william-rodriguez')
    logger.error('       yarn sync:laravel-media -- --all --resume')
    process.exitCode = 1
    return
  }
  s3Utils.ensureConfigured()
  const slugs = args.slug ? [args.slug] : loadSlugs(args.slugsFile)
  const doneFile = path.join(process.cwd(), 'scripts', 'reports', 'laravel-tab-sync-done.json')
  let done = new Set<string>()
  if (args.resume && fs.existsSync(doneFile)) {
    done = new Set(JSON.parse(fs.readFileSync(doneFile, 'utf8')) as string[])
  }
  const results: SyncResult[] = []
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]
    if (args.resume && done.has(slug)) {
      logger.info(`[${i + 1}/${slugs.length}] ${slug} skipped (resume)`)
      continue
    }
    logger.info(`\n[${i + 1}/${slugs.length}] ${slug} — Laravel tabs → S3 → DB URL rewrite`)
    const result = await syncSlug(slug, args.dryRun)
    results.push(result)
    logger.info(
      `  status=${result.status} tabs=${result.tabs} media=${result.media} uploaded=${result.uploaded} skipped=${result.skipped} failed=${result.failed}`
    )
    if (result.errors.length) logger.warn(`  errors: ${result.errors.slice(0, 5).join(' | ')}`)
    if (!args.dryRun && result.status === 'complete') done.add(slug)
    fs.mkdirSync(path.dirname(doneFile), { recursive: true })
    fs.writeFileSync(doneFile, JSON.stringify([...done], null, 2))
  }
  const reportPath = path.join(process.cwd(), 'scripts', 'reports', `laravel-tab-sync-${Date.now()}.json`)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2))
  logger.info(`Report: ${reportPath}`)
}

main()
  .catch((err) => {
    logger.error(formatError(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
