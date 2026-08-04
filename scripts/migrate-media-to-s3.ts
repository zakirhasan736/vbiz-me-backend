/**
 * Upload existing attachment/avatar URLs to AWS S3 and rewrite DB rows.
 * Expects absolute source URLs (run `yarn migrate:media-urls` first if needed).
 *
 * Usage:
 *   yarn migrate:media
 *   MEDIA_MIGRATE_CONCURRENCY=8 yarn migrate:media
 *
 * Same rules as before:
 * - Skip YouTube/external types and rows already on S3
 * - Only rewrite DB url → S3 on successful upload
 * - Leave legacy URL unchanged on failure / missing file
 * - Safe to re-run (idempotent)
 *
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

type FailRow = { kind: string; id: string; source?: string; error: string; tried?: string[] }

type Counters = { ok: number; skip: number; fail: number; missing: number; done: number; total: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
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

async function migrateAttachments(failures: FailRow[]) {
  const rows = await prisma.attachment.findMany({
    include: {
      attachmentType: true,
      profile: { select: { legacyId: true, slug: true } },
    },
  })

  const counters: Counters = { ok: 0, skip: 0, fail: 0, missing: 0, done: 0, total: rows.length }
  logger.info(`Attachments: ${rows.length} rows, concurrency=${CONCURRENCY}`)

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
        profileLegacyId: row.profile?.legacyId ?? null,
        profileSlug: row.profile?.slug ?? null,
      },
      { mode: 'fast' }
    )

    const { source, tried } = await pickWorkingSource(candidates)
    if (!source) {
      failures.push({
        kind: 'attachment.missing',
        id: row.id,
        source: row.url || row.docName || undefined,
        error: 'File not found on legacy host (404 for all candidate paths)',
        tried: tried.slice(0, 8),
      })
      logger.warn(`[attachment] MISSING ${row.id} doc=${row.docName} (tried ${tried.length} URLs)`)
      bump(counters, 'missing', failures)
      return
    }

    // Persist a working absolute legacy URL before S3 rewrite (helps re-runs / debugging)
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
      failures.push({ kind: 'attachment', id: row.id, source, error: message, tried })
      logger.error(`[attachment] FAILED ${row.id} (${source})`, err)
      bump(counters, 'fail', failures)
    }
  })

  return {
    ok: counters.ok,
    skip: counters.skip,
    fail: counters.fail,
    missing: counters.missing,
    total: rows.length,
  }
}

async function migrateAvatars(failures: FailRow[]) {
  const users = await prisma.user.findMany({ where: { avatar: { not: null } } })
  const profiles = await prisma.profile.findMany({ where: { avatar: { not: null } } })
  const counters: Counters = {
    ok: 0,
    skip: 0,
    fail: 0,
    missing: 0,
    done: 0,
    total: users.length + profiles.length,
  }
  logger.info(`Avatars: ${counters.total} rows, concurrency=${CONCURRENCY}`)

  await mapPool(users, CONCURRENCY, async (user) => {
    if (isAlreadyOnS3(user.avatar)) {
      bump(counters, 'skip', failures)
      return
    }
    if (!user.avatar || !isAbsoluteMediaUrl(user.avatar)) {
      bump(counters, 'skip', failures)
      return
    }
    const source = encodeUrlPath(user.avatar)
    if (!(await fetchOk(source))) {
      failures.push({
        kind: 'user.avatar.missing',
        id: user.id,
        source,
        error: 'File not found on legacy host',
      })
      bump(counters, 'missing', failures)
      return
    }
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
        source,
        error: err instanceof Error ? err.message : String(err),
      })
      logger.error(`[user.avatar] FAILED ${user.id}`, err)
      bump(counters, 'fail', failures)
    }
  })

  await mapPool(profiles, CONCURRENCY, async (profile) => {
    if (isAlreadyOnS3(profile.avatar)) {
      bump(counters, 'skip', failures)
      return
    }

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
        source: profile.avatar || undefined,
        error: 'File not found on legacy host',
        tried: tried.slice(0, 8),
      })
      bump(counters, 'missing', failures)
      return
    }

    if (profile.avatar !== source && !isAlreadyOnS3(profile.avatar)) {
      await prisma.profile.update({ where: { id: profile.id }, data: { avatar: source } })
    }

    try {
      const uploaded = await uploadWithRetries(source, {
        folder: `${config.S3.KEY_PREFIX}/profiles`,
      })
      await prisma.profile.update({ where: { id: profile.id }, data: { avatar: uploaded.url } })
      bump(counters, 'ok', failures)
    } catch (err) {
      failures.push({
        kind: 'profile.avatar',
        id: profile.id,
        source,
        error: err instanceof Error ? err.message : String(err),
      })
      logger.error(`[profile.avatar] FAILED ${profile.id}`, err)
      bump(counters, 'fail', failures)
    }
  })

  return {
    ok: counters.ok,
    skip: counters.skip,
    fail: counters.fail,
    missing: counters.missing,
    total: users.length + profiles.length,
  }
}

function writeFailureReport(failures: FailRow[]) {
  if (!failures.length) return null
  const outDir = path.join(process.cwd(), 'scripts', 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `media-migrate-failures-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(failures, null, 2), 'utf8')
  return outPath
}

async function main() {
  s3Utils.ensureConfigured()
  const failures: FailRow[] = []

  logger.info(`Migrating attachments to S3 (concurrency=${CONCURRENCY})…`)
  const a = await migrateAttachments(failures)
  logger.info('Attachments:', a)

  logger.info('Migrating avatars to S3…')
  const b = await migrateAvatars(failures)
  logger.info('Avatars:', b)

  const report = writeFailureReport(failures)
  if (report) {
    const missing = failures.filter((f) => f.kind.endsWith('.missing')).length
    const hard = failures.length - missing
    logger.error(
      `Wrote failure report: ${report} (${failures.length} issues: ${missing} missing on host, ${hard} upload errors)`
    )
    if (hard > 0) process.exitCode = 1
  } else {
    logger.info('All media migrated (or skipped) with no failures.')
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
