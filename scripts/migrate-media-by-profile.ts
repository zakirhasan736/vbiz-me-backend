/**
 * Upload one profile's media to AWS S3 and rewrite DB rows.
 * Expects absolute source URLs (run `yarn migrate:media-urls` first if needed).
 *
 * Usage:
 *   yarn migrate:media:profile -- --profileId=<cuid|legacyId|slug>
 *   yarn migrate:media:profile -- --all
 *   MEDIA_MIGRATE_CONCURRENCY=8 yarn migrate:media:profile -- --all
 *
 * Per profile migrates:
 * - Attachments (intro, home/bg, gallery, services, posts/certs, etc.)
 * - Profile.avatar + owning User.avatar
 * - Service.imageUrl, Portfolio.imageUrl, Post.featuredImage
 *
 * Same rules as the global migrator:
 * - Skip YouTube/external types and rows already on S3
 * - Only rewrite DB url → S3 on successful upload
 * - Leave legacy URL unchanged on failure / missing file
 * - Safe to re-run (idempotent)
 *
 * `--all` processes profiles one after another (finish user N before N+1).
 * Do NOT run two copies of this command at once — concurrency is in-process only.
 */
import fs from 'fs'
import path from 'path'
import config from '../src/configs/config'
import logger from '../src/utils/logger'
import {
  encodeUrlPath,
  isAbsoluteMediaUrl,
  isAlreadyOnS3,
  isExternalLinkType,
  legacySourceUrlCandidates,
} from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 400
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.MEDIA_MIGRATE_CONCURRENCY) || 6))
const PROGRESS_EVERY = 25

type FailRow = {
  kind: string
  id: string
  profileId?: string
  source?: string
  error: string
  tried?: string[]
}

type Counters = { ok: number; skip: number; fail: number; missing: number; done: number; total: number }

type Summary = { ok: number; skip: number; fail: number; missing: number; total: number }

type ProfileRow = {
  id: string
  legacyId: number | null
  slug: string | null
  name: string
  avatar: string | null
  userId: string | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function emptySummary(): Summary {
  return { ok: 0, skip: 0, fail: 0, missing: 0, total: 0 }
}

function mergeSummary(into: Summary, from: Summary) {
  into.ok += from.ok
  into.skip += from.skip
  into.fail += from.fail
  into.missing += from.missing
  into.total += from.total
}

function parseArgs(argv: string[]) {
  let profileId: string | undefined
  let all = false
  for (const arg of argv) {
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg.startsWith('--profileId=')) {
      profileId = arg.slice('--profileId='.length).trim()
      continue
    }
    if (arg === '--profileId') {
      // support `--profileId xxx` form
      const idx = argv.indexOf(arg)
      const next = argv[idx + 1]
      if (next && !next.startsWith('--')) profileId = next.trim()
    }
  }
  return { profileId, all }
}

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

async function fetchOk(url: string): Promise<boolean> {
  try {
    const encoded = encodeUrlPath(url)
    const get = await fetch(encoded, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': 'vbizme-media-migrator/1.0',
        Accept: '*/*',
        Referer: `${(config.MEDIA_BASE_URL || 'https://app.vbizme.com').replace(/\/$/, '')}/`,
      },
      redirect: 'follow',
    })
    if (get.ok || get.status === 206) {
      const ct = get.headers.get('content-type') || ''
      return !ct.includes('text/html')
    }
    return false
  } catch {
    return false
  }
}

async function pickWorkingSource(candidates: string[]): Promise<{ source: string | null; tried: string[] }> {
  const tried: string[] = []
  for (const candidate of candidates) {
    if (!isAbsoluteMediaUrl(candidate)) continue
    const encoded = encodeUrlPath(candidate)
    if (tried.includes(encoded)) continue
    tried.push(encoded)
    if (await fetchOk(encoded)) return { source: encoded, tried }
  }
  return { source: null, tried }
}

async function uploadWithRetries(
  source: string,
  options?: { folder?: string }
): Promise<Awaited<ReturnType<typeof s3Utils.uploadFromUrl>>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await s3Utils.uploadFromUrl(source, options)
    } catch (err) {
      lastErr = err
      logger.warn(`Upload attempt ${attempt}/${MAX_ATTEMPTS} failed for ${source}`)
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt)
    }
  }
  throw lastErr
}

function bump(counters: Counters, key: keyof Omit<Counters, 'done' | 'total'>, failures: FailRow[]) {
  counters[key] += 1
  counters.done += 1
  if (counters.done % PROGRESS_EVERY === 0 || counters.done === counters.total) {
    logger.info(
      `Progress ${counters.done}/${counters.total} (ok=${counters.ok} skip=${counters.skip} missing=${counters.missing} fail=${counters.fail} report=${failures.length})`
    )
  }
}

function summaryFrom(counters: Counters): Summary {
  return {
    ok: counters.ok,
    skip: counters.skip,
    fail: counters.fail,
    missing: counters.missing,
    total: counters.total,
  }
}

async function resolveProfile(profileIdArg: string): Promise<ProfileRow | null> {
  const byId = await prisma.profile.findUnique({
    where: { id: profileIdArg },
    select: { id: true, legacyId: true, slug: true, name: true, avatar: true, userId: true },
  })
  if (byId) return byId

  if (/^\d+$/.test(profileIdArg)) {
    const byLegacy = await prisma.profile.findFirst({
      where: { legacyId: Number(profileIdArg) },
      select: { id: true, legacyId: true, slug: true, name: true, avatar: true, userId: true },
    })
    if (byLegacy) return byLegacy
  }

  return prisma.profile.findFirst({
    where: { slug: profileIdArg },
    select: { id: true, legacyId: true, slug: true, name: true, avatar: true, userId: true },
  })
}

async function listAllProfiles(): Promise<ProfileRow[]> {
  return prisma.profile.findMany({
    orderBy: [{ legacyId: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, legacyId: true, slug: true, name: true, avatar: true, userId: true },
  })
}

async function migrateAttachmentsForProfile(profile: ProfileRow, failures: FailRow[]): Promise<Summary> {
  const rows = await prisma.attachment.findMany({
    where: { profileId: profile.id },
    include: {
      attachmentType: true,
      profile: { select: { legacyId: true, slug: true } },
    },
  })

  const counters: Counters = { ok: 0, skip: 0, fail: 0, missing: 0, done: 0, total: rows.length }
  logger.info(`[${profile.id}] Attachments: ${rows.length} rows, concurrency=${CONCURRENCY}`)

  await mapPool(rows, CONCURRENCY, async (row) => {
    if (isExternalLinkType(row.attachmentType?.legacyId)) {
      bump(counters, 'skip', failures)
      return
    }
    if (isAlreadyOnS3(row.url)) {
      bump(counters, 'skip', failures)
      return
    }

    const candidates = legacySourceUrlCandidates(
      {
        url: row.url,
        docName: row.docName,
        attachmentTypeLegacyId: row.attachmentType?.legacyId ?? null,
        attachmentTypeName: row.attachmentType?.name ?? null,
        profileLegacyId: row.profile?.legacyId ?? profile.legacyId,
        profileSlug: row.profile?.slug ?? profile.slug,
      },
      { mode: 'fast' }
    )

    const { source, tried } = await pickWorkingSource(candidates)
    if (!source) {
      failures.push({
        kind: 'attachment.missing',
        id: row.id,
        profileId: profile.id,
        source: row.url || row.docName || undefined,
        error: 'File not found on legacy host (404 for all candidate paths)',
        tried: tried.slice(0, 8),
      })
      logger.warn(`[attachment] MISSING ${row.id} doc=${row.docName} (tried ${tried.length} URLs)`)
      bump(counters, 'missing', failures)
      return
    }

    if (row.url !== source && !isAlreadyOnS3(row.url)) {
      await prisma.attachment.update({
        where: { id: row.id },
        data: { url: source },
      })
    }

    try {
      const uploaded = await uploadWithRetries(source)
      await prisma.attachment.update({
        where: { id: row.id },
        data: {
          url: uploaded.url,
          publicId: uploaded.publicId,
          resourceType: uploaded.resourceType,
          format: uploaded.format,
          bytes: uploaded.bytes,
          extension: uploaded.format || row.extension,
        },
      })
      logger.info(`[attachment] ${row.id} -> ${uploaded.url}`)
      bump(counters, 'ok', failures)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ kind: 'attachment', id: row.id, profileId: profile.id, source, error: message, tried })
      logger.error(`[attachment] FAILED ${row.id} (${source})`, err)
      bump(counters, 'fail', failures)
    }
  })

  return summaryFrom(counters)
}

async function migrateAvatarsForProfile(profile: ProfileRow, failures: FailRow[]): Promise<Summary> {
  const counters: Counters = { ok: 0, skip: 0, fail: 0, missing: 0, done: 0, total: 0 }

  // Owning user avatar
  if (profile.userId) {
    const user = await prisma.user.findUnique({ where: { id: profile.userId } })
    if (user?.avatar) {
      counters.total += 1
      if (isAlreadyOnS3(user.avatar)) {
        bump(counters, 'skip', failures)
      } else if (!isAbsoluteMediaUrl(user.avatar)) {
        bump(counters, 'skip', failures)
      } else {
        const source = encodeUrlPath(user.avatar)
        if (!(await fetchOk(source))) {
          failures.push({
            kind: 'user.avatar.missing',
            id: user.id,
            profileId: profile.id,
            source,
            error: 'File not found on legacy host',
          })
          bump(counters, 'missing', failures)
        } else {
          try {
            const uploaded = await uploadWithRetries(source, {
              folder: `${config.S3.KEY_PREFIX}/avatars`,
            })
            await prisma.user.update({ where: { id: user.id }, data: { avatar: uploaded.url } })
            bump(counters, 'ok', failures)
          } catch (err) {
            failures.push({
              kind: 'user.avatar',
              id: user.id,
              profileId: profile.id,
              source,
              error: err instanceof Error ? err.message : String(err),
            })
            logger.error(`[user.avatar] FAILED ${user.id}`, err)
            bump(counters, 'fail', failures)
          }
        }
      }
    }
  }

  // Profile avatar
  if (profile.avatar) {
    counters.total += 1
    if (isAlreadyOnS3(profile.avatar)) {
      bump(counters, 'skip', failures)
    } else {
      const candidates = legacySourceUrlCandidates(
        {
          url: profile.avatar,
          docName: profile.avatar,
          attachmentTypeLegacyId: 13,
          attachmentTypeName: 'Profile Picture',
          profileLegacyId: profile.legacyId,
          profileSlug: profile.slug,
        },
        { mode: 'fast' }
      )
      const { source, tried } = await pickWorkingSource(candidates)
      if (!source) {
        failures.push({
          kind: 'profile.avatar.missing',
          id: profile.id,
          profileId: profile.id,
          source: profile.avatar || undefined,
          error: 'File not found on legacy host',
          tried: tried.slice(0, 8),
        })
        bump(counters, 'missing', failures)
      } else {
        if (profile.avatar !== source && !isAlreadyOnS3(profile.avatar)) {
          await prisma.profile.update({ where: { id: profile.id }, data: { avatar: source } })
        }
        try {
          const uploaded = await uploadWithRetries(source, {
            folder: `${config.S3.KEY_PREFIX}/profiles`,
          })
          await prisma.profile.update({ where: { id: profile.id }, data: { avatar: uploaded.url } })
          profile.avatar = uploaded.url
          bump(counters, 'ok', failures)
        } catch (err) {
          failures.push({
            kind: 'profile.avatar',
            id: profile.id,
            profileId: profile.id,
            source,
            error: err instanceof Error ? err.message : String(err),
          })
          logger.error(`[profile.avatar] FAILED ${profile.id}`, err)
          bump(counters, 'fail', failures)
        }
      }
    }
  }

  logger.info(`[${profile.id}] Avatars: ${counters.total} rows`)
  return summaryFrom(counters)
}

type SimpleImageRow = { id: string; url: string | null; kind: 'service' | 'portfolio' | 'post' }

async function migrateRelatedImagesForProfile(profile: ProfileRow, failures: FailRow[]): Promise<Summary> {
  const [services, portfolios, posts] = await Promise.all([
    prisma.service.findMany({
      where: { profileId: profile.id, imageUrl: { not: null } },
      select: { id: true, imageUrl: true },
    }),
    prisma.portfolio.findMany({
      where: { profileId: profile.id, imageUrl: { not: null } },
      select: { id: true, imageUrl: true },
    }),
    prisma.post.findMany({
      where: { profileId: profile.id, featuredImage: { not: null } },
      select: { id: true, featuredImage: true },
    }),
  ])

  const rows: SimpleImageRow[] = [
    ...services.map((s) => ({ id: s.id, url: s.imageUrl, kind: 'service' as const })),
    ...portfolios.map((p) => ({ id: p.id, url: p.imageUrl, kind: 'portfolio' as const })),
    ...posts.map((p) => ({ id: p.id, url: p.featuredImage, kind: 'post' as const })),
  ]

  const counters: Counters = { ok: 0, skip: 0, fail: 0, missing: 0, done: 0, total: rows.length }
  logger.info(`[${profile.id}] Related images: ${rows.length} rows, concurrency=${CONCURRENCY}`)

  const folderByKind: Record<SimpleImageRow['kind'], string> = {
    service: `${config.S3.KEY_PREFIX}/services`,
    portfolio: `${config.S3.KEY_PREFIX}/portfolios`,
    post: `${config.S3.KEY_PREFIX}/posts`,
  }

  const typeHintByKind: Record<SimpleImageRow['kind'], { legacyId: number; name: string }> = {
    service: { legacyId: 6, name: 'Services' },
    portfolio: { legacyId: 5, name: 'Portfolio' },
    post: { legacyId: 7, name: 'Featured Image' },
  }

  await mapPool(rows, CONCURRENCY, async (row) => {
    if (isAlreadyOnS3(row.url)) {
      bump(counters, 'skip', failures)
      return
    }
    if (!row.url) {
      bump(counters, 'skip', failures)
      return
    }

    const hint = typeHintByKind[row.kind]
    const candidates = isAbsoluteMediaUrl(row.url)
      ? [row.url]
      : legacySourceUrlCandidates(
          {
            url: row.url,
            docName: row.url,
            attachmentTypeLegacyId: hint.legacyId,
            attachmentTypeName: hint.name,
            profileLegacyId: profile.legacyId,
            profileSlug: profile.slug,
          },
          { mode: 'fast' }
        )

    const { source, tried } = await pickWorkingSource(candidates)
    if (!source) {
      failures.push({
        kind: `${row.kind}.image.missing`,
        id: row.id,
        profileId: profile.id,
        source: row.url,
        error: 'File not found on legacy host',
        tried: tried.slice(0, 8),
      })
      bump(counters, 'missing', failures)
      return
    }

    try {
      const uploaded = await uploadWithRetries(source, { folder: folderByKind[row.kind] })
      if (row.kind === 'service') {
        await prisma.service.update({ where: { id: row.id }, data: { imageUrl: uploaded.url } })
      } else if (row.kind === 'portfolio') {
        await prisma.portfolio.update({ where: { id: row.id }, data: { imageUrl: uploaded.url } })
      } else {
        await prisma.post.update({ where: { id: row.id }, data: { featuredImage: uploaded.url } })
      }
      logger.info(`[${row.kind}.image] ${row.id} -> ${uploaded.url}`)
      bump(counters, 'ok', failures)
    } catch (err) {
      failures.push({
        kind: `${row.kind}.image`,
        id: row.id,
        profileId: profile.id,
        source,
        error: err instanceof Error ? err.message : String(err),
        tried,
      })
      logger.error(`[${row.kind}.image] FAILED ${row.id}`, err)
      bump(counters, 'fail', failures)
    }
  })

  return summaryFrom(counters)
}

async function migrateOneProfile(profile: ProfileRow, failures: FailRow[]): Promise<Summary> {
  const total = emptySummary()

  const attachmentCount = await prisma.attachment.count({ where: { profileId: profile.id } })
  const serviceCount = await prisma.service.count({
    where: { profileId: profile.id, imageUrl: { not: null } },
  })
  const portfolioCount = await prisma.portfolio.count({
    where: { profileId: profile.id, imageUrl: { not: null } },
  })
  const postCount = await prisma.post.count({
    where: { profileId: profile.id, featuredImage: { not: null } },
  })

  logger.info(
    `── Profile ${profile.id} | legacyId=${profile.legacyId ?? 'n/a'} | slug=${profile.slug ?? 'n/a'} | name=${profile.name}`
  )
  logger.info(
    `   media counts: attachments=${attachmentCount} profileAvatar=${profile.avatar ? 1 : 0} hasUser=${Boolean(profile.userId)} services=${serviceCount} portfolios=${portfolioCount} posts=${postCount}`
  )

  mergeSummary(total, await migrateAttachmentsForProfile(profile, failures))
  mergeSummary(total, await migrateAvatarsForProfile(profile, failures))
  mergeSummary(total, await migrateRelatedImagesForProfile(profile, failures))

  logger.info(
    `── Done profile ${profile.id}: ok=${total.ok} skip=${total.skip} missing=${total.missing} fail=${total.fail} total=${total.total}`
  )
  return total
}

function writeFailureReport(failures: FailRow[]) {
  if (!failures.length) return null
  const outDir = path.join(process.cwd(), 'scripts', 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `media-migrate-by-profile-failures-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(failures, null, 2), 'utf8')
  return outPath
}

function printUsage() {
  logger.error('Usage:')
  logger.error('  yarn migrate:media:profile -- --profileId=<cuid|legacyId|slug>')
  logger.error('  yarn migrate:media:profile -- --all')
}

async function main() {
  const { profileId, all } = parseArgs(process.argv.slice(2))

  if ((profileId && all) || (!profileId && !all)) {
    printUsage()
    process.exitCode = 1
    return
  }

  s3Utils.ensureConfigured()
  const failures: FailRow[] = []
  const grand = emptySummary()

  let profiles: ProfileRow[]
  if (all) {
    profiles = await listAllProfiles()
    logger.info(`Migrating media for ${profiles.length} profiles sequentially (concurrency=${CONCURRENCY})…`)
  } else {
    const profile = await resolveProfile(profileId!)
    if (!profile) {
      logger.error(`Profile not found for --profileId=${profileId}`)
      process.exitCode = 1
      return
    }
    profiles = [profile]
    logger.info(`Migrating media for 1 profile (concurrency=${CONCURRENCY})…`)
  }

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i]
    logger.info(`[${i + 1}/${profiles.length}] Starting profile ${profile.id}`)
    const summary = await migrateOneProfile(profile, failures)
    mergeSummary(grand, summary)
  }

  logger.info(
    `Grand total: ok=${grand.ok} skip=${grand.skip} missing=${grand.missing} fail=${grand.fail} total=${grand.total} profiles=${profiles.length}`
  )

  const report = writeFailureReport(failures)
  if (report) {
    const missing = failures.filter((f) => f.kind.endsWith('.missing')).length
    const hard = failures.length - missing
    logger.error(
      `Wrote failure report: ${report} (${failures.length} issues: ${missing} missing on host, ${hard} upload errors)`
    )
    if (hard > 0) process.exitCode = 1
  } else {
    logger.info('All profile media migrated (or skipped) with no failures.')
  }
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
