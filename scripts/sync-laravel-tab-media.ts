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
import { isAbsoluteMediaUrl, isAlreadyOnS3 } from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

const LARAVEL_API = (process.env.LARAVEL_API_BASE || 'https://app.vbizme.com/api').replace(/\/$/, '')
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.MEDIA_MIGRATE_CONCURRENCY) || 3))
const USER_AGENT = 'vbizme-laravel-tab-sync/1.0'

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
  attachmentLegacyId: number | null
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

async function laravelGet(apiPath: string): Promise<{ status: number; json: unknown }> {
  const url = apiPath.startsWith('http') ? apiPath : `${LARAVEL_API}${apiPath}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
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

function pushUrl(hits: MediaHit[], hit: MediaHit) {
  if (!hit.url || !isAbsoluteMediaUrl(hit.url)) return
  if (SKIP_HOST.test(hit.url)) return
  hits.push(hit)
}

function collectFeaturedAndAttachments(
  section: string,
  item: Record<string, unknown>,
  kind: MediaHit['kind']
): MediaHit[] {
  const hits: MediaHit[] = []
  const itemId = Number(item.id)
  const itemLegacyId = Number.isFinite(itemId) ? itemId : null
  const featured = item.featured_image
  if (typeof featured === 'string') {
    pushUrl(hits, { section, itemLegacyId, attachmentLegacyId: null, kind, field: 'featured_image', url: featured })
  } else if (Array.isArray(featured)) {
    for (const entry of featured) {
      const rec = asRecord(entry)
      const url = typeof rec?.url === 'string' ? rec.url : typeof entry === 'string' ? entry : ''
      const attId = Number(rec?.id)
      pushUrl(hits, {
        section,
        itemLegacyId,
        attachmentLegacyId: Number.isFinite(attId) ? attId : null,
        kind: rec?.id ? 'attachment' : kind,
        field: 'featured_image',
        url,
      })
    }
  } else if (asRecord(featured)?.url) {
    pushUrl(hits, {
      section,
      itemLegacyId,
      attachmentLegacyId: Number(asRecord(featured)?.id) || null,
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
      const attId = Number(rec.id)
      pushUrl(hits, {
        section,
        itemLegacyId,
        attachmentLegacyId: Number.isFinite(attId) ? attId : null,
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
  if (hit.kind === 'service' && hit.itemLegacyId != null) {
    const row = await prisma.service.findFirst({ where: { legacyId: hit.itemLegacyId, profileId } })
    if (row) await prisma.service.update({ where: { id: row.id }, data: { imageUrl: newUrl } })
  }
  if (hit.kind === 'portfolio' && hit.itemLegacyId != null) {
    const row = await prisma.portfolio.findFirst({ where: { legacyId: hit.itemLegacyId, profileId } })
    if (row) await prisma.portfolio.update({ where: { id: row.id }, data: { imageUrl: newUrl } })
  }
  if ((hit.kind === 'post' || hit.field === 'featured_image') && hit.itemLegacyId != null) {
    const row = await prisma.post.findFirst({ where: { legacyId: hit.itemLegacyId, profileId } })
    if (row) await prisma.post.update({ where: { id: row.id }, data: { featuredImage: newUrl } })
  }
  if (hit.kind === 'profile' && /profile_media/i.test(hit.field) && !/fallback/i.test(hit.field)) {
    await prisma.profile.update({ where: { id: profileId }, data: { avatar: newUrl } })
  }
}

async function syncSlug(slug: string, dryRun: boolean): Promise<SyncResult> {
  const errors: string[] = []
  const cardRes = await laravelGet(`/v/${encodeURIComponent(slug)}`)
  if (cardRes.status === 404) {
    return {
      slug,
      status: 'laravel_not_found',
      tabs: 0,
      media: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: ['Laravel 404'],
    }
  }
  const card = envelope(cardRes.json)
  const laravelProfile = asRecord(card?.profile)
  const laravelId = Number(laravelProfile?.id)
  if (!card || !Number.isFinite(laravelId)) {
    return {
      slug,
      status: 'laravel_not_found',
      tabs: 0,
      media: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: ['No Laravel profile id'],
    }
  }

  const dbProfile = await prisma.profile.findFirst({
    where: { OR: [{ slug }, { legacyId: laravelId }] },
    select: { id: true, slug: true, legacyId: true, avatar: true },
  })
  if (!dbProfile) {
    return {
      slug,
      status: 'db_not_found',
      laravelId,
      tabs: 0,
      media: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      errors: [`No new-backend profile for slug=${slug} legacyId=${laravelId}`],
    }
  }

  await sleep(120)
  const tabsRes = await laravelGet(`/post-types?profile_id=${laravelId}`)
  const tabsData = envelope(tabsRes.json) || {}
  const postTypes = Array.isArray(tabsData.post_types) ? tabsData.post_types : []
  const names = new Set<string>()
  for (const row of postTypes) {
    const rec = asRecord(row)
    const name = String(rec?.name || rec?.title || '')
    if (name.trim() && !/^home$/i.test(name) && !/^cards$/i.test(name) && !/^public cards$/i.test(name)) {
      names.add(name)
    }
  }
  for (const extra of EXTRA_TABS) {
    if (![...names].some((n) => n.trim().toLowerCase() === extra.toLowerCase())) names.add(extra)
  }

  const hits: MediaHit[] = collectProfileMedia(card)
  let tabsOk = 0
  for (const name of names) {
    await sleep(120)
    const encoded = encodeURIComponent(name)
    const sec = await laravelGet(`/dynamic-section/${encoded}?profile_id=${laravelId}`)
    const data = envelope(sec.json)
    const items = Array.isArray(data?.items) ? data.items : []
    if (sec.status !== 200) {
      errors.push(`tab ${name}: HTTP ${sec.status}`)
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

  const uniqueByUrl = new Map<string, MediaHit[]>()
  for (const hit of hits) {
    const list = uniqueByUrl.get(hit.url) || []
    list.push(hit)
    uniqueByUrl.set(hit.url, list)
  }

  let uploaded = 0
  let skipped = 0
  let failed = 0
  const urlMap = new Map<string, string>()

  const entries = [...uniqueByUrl.entries()]
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map(async ([sourceUrl, related]) => {
        if (isAlreadyOnS3(sourceUrl)) {
          skipped += related.length
          urlMap.set(sourceUrl, sourceUrl)
          return
        }
        if (dryRun) {
          logger.info(`[dry-run] ${slug} ${related[0].section} ${sourceUrl}`)
          uploaded += related.length
          return
        }
        try {
          const folder = s3Folder(related[0].kind, related[0].section)
          const uploadedFile = await s3Utils.uploadFromUrl(sourceUrl, { folder })
          urlMap.set(sourceUrl, uploadedFile.url)
          for (const hit of related) {
            await rewriteRow(hit, dbProfile.id, uploadedFile.url)
          }
          uploaded += related.length
          logger.info(`[ok] ${slug} ${related[0].section} -> ${uploadedFile.url}`)
        } catch (err) {
          failed += related.length
          const message = err instanceof Error ? err.message : String(err)
          errors.push(`${related[0].section} ${sourceUrl}: ${message}`)
          logger.error(`[fail] ${slug} ${sourceUrl}`, err)
        }
      })
    )
  }

  const status = dryRun ? 'dry_run' : failed ? 'incomplete' : 'complete'
  return {
    slug,
    status,
    laravelId,
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
