/**
 * Resumable Review media/link repair.
 *
 * Defaults to a global DRY_RUN. The only entity relationship is:
 * Review.legacyServiceId -> Laravel services.id / Service attachmentable_id.
 */
import mysql, { Connection, RowDataPacket } from 'mysql2/promise'
import path from 'path'
import { Prisma } from '../generated/prisma/client'
import config from '../src/configs/config'
import { encodeUrlPath, isAlreadyOnS3 } from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'
import {
  assertMutationAllowed,
  authoritativeCandidates,
  clearUnprovenImage,
  existingS3Plan,
  extractReviewUrl,
  ImageCandidate,
  isAbsoluteDestination,
  isLegitimatePageUrl,
  LaravelAttachment,
  parseRepairArgs,
  ReviewAttachment,
  selectPrimaryImage,
  SERVICE_ATTACHABLE_TYPE,
} from './repairReviewMedia.helpers'

const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE) || 40)
const MYSQL_CHUNK = 400
const MICHAELANGELO_SLUG = 'michaelangelo-casanova-2'
const HIGHLIGHT_SERVICE_IDS = new Set([956, 1081])

type ReviewRow = {
  id: string
  legacyServiceId: number | null
  profileId: string
  author: string | null
  imageUrl: string | null
  reviewUrl: string | null
  profile: { slug: string | null; legacyId: number | null }
}

type LegacyService = Record<string, unknown> & { id: number }

type Outcome = 'REPAIRED' | 'ALREADY_S3' | 'NO_SOURCE' | 'SKIPPED' | 'FAILED' | 'AMBIGUOUS'
const counts: Record<Outcome, number> = {
  REPAIRED: 0,
  ALREADY_S3: 0,
  NO_SOURCE: 0,
  SKIPPED: 0,
  FAILED: 0,
  AMBIGUOUS: 0,
}

function log(status: Outcome, review: ReviewRow, message: string) {
  counts[status] += 1
  console.log(
    `[${status}] review=${review.id} author=${JSON.stringify(review.author)} legacyServiceId=${review.legacyServiceId ?? 'null'} ${message}`
  )
}

function chunks<T>(values: T[], size = MYSQL_CHUNK): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function mediaBase(): string {
  return (config.MEDIA_BASE_URL || 'https://app.vbizme.com').replace(/\/$/, '')
}

function sanitizeFilename(value: string): string {
  let raw = value
  try {
    raw = new URL(value).pathname
  } catch {
    // The value is already a filename/path.
  }
  const base = path.basename(raw.replace(/\\/g, '/'))
  const ext = path.extname(base).toLowerCase()
  const stem = path
    .basename(base, path.extname(base))
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem || 'image'}${ext || '.jpg'}`
}

function s3Key(reviewId: string, filename: string): string {
  const prefix = (config.S3.KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')
  return `${prefix}/reviews/${reviewId}/${sanitizeFilename(filename)}`
}

function isUsableS3(value?: string | null): boolean {
  return Boolean(value?.trim() && isAbsoluteDestination(value) && isAlreadyOnS3(value.trim()))
}

function extension(filename: string): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase() || 'jpg'
}

function mimeType(filename: string, contentType?: string | null): string {
  const header = contentType?.split(';')[0]?.trim()
  if (header?.startsWith('image/')) return header
  const byExtension: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
  }
  return byExtension[extension(filename)] || 'application/octet-stream'
}

async function assertRequiredSchema() {
  const [column] = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Review'
        AND column_name = 'legacyServiceId'
    ) AS present
  `
  if (!column?.present) {
    throw new Error(
      'Review.legacyServiceId is missing. Deploy migration 20260818233000_review_legacy_service_id before running.'
    )
  }
}

async function openLaravel(): Promise<Connection | null> {
  if (!config.LARAVEL_MYSQL_URL) {
    console.warn('LARAVEL_MYSQL_URL is not set; Laravel Service rows and attachments are unavailable')
    return null
  }
  return mysql.createConnection(config.LARAVEL_MYSQL_URL)
}

async function loadLaravelBatch(connection: Connection | null, ids: number[]) {
  const attachments: LaravelAttachment[] = []
  const services: LegacyService[] = []
  if (!connection || !ids.length) return { attachments, services }
  for (const part of chunks([...new Set(ids)])) {
    const placeholders = part.map(() => '?').join(',')
    const [attachmentRows] = await connection.query<RowDataPacket[]>(
      `SELECT id, doc_name, attachmentable_id, attachmentable_type, attachment_type_id, created_at
       FROM attachments
       WHERE attachmentable_id IN (${placeholders})
       ORDER BY attachmentable_id ASC, id ASC, created_at ASC`,
      part
    )
    for (const row of attachmentRows) {
      const normalized = {
        id: Number(row.id),
        doc_name: String(row.doc_name || ''),
        attachmentable_id: Number(row.attachmentable_id),
        attachmentable_type: String(row.attachmentable_type || ''),
        attachment_type_id: row.attachment_type_id == null ? null : Number(row.attachment_type_id),
        created_at: row.created_at ?? null,
      }
      if (
        normalized.attachmentable_type.replace(/\\\\/g, '\\') === SERVICE_ATTACHABLE_TYPE &&
        part.includes(normalized.attachmentable_id)
      ) {
        attachments.push(normalized)
      }
    }
    const [serviceRows] = await connection.query<RowDataPacket[]>(
      `SELECT * FROM services WHERE id IN (${placeholders}) ORDER BY id ASC`,
      part
    )
    services.push(...serviceRows.map((row) => ({ ...row, id: Number(row.id) })))
  }
  return { attachments, services }
}

async function loadPgAttachments(serviceIds: number[], laravelAttachmentIds: number[]): Promise<ReviewAttachment[]> {
  if (!serviceIds.length && !laravelAttachmentIds.length) return []
  return prisma.attachment.findMany({
    where: {
      OR: [
        ...(serviceIds.length ? [{ attachableId: { in: serviceIds.map(String) } }] : []),
        ...(laravelAttachmentIds.length ? [{ legacyId: { in: laravelAttachmentIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { attachmentType: { select: { legacyId: true } } },
  })
}

function sourceUrls(candidate: ImageCandidate, profileLegacyId: number | null): string[] {
  const urls: string[] = []
  const add = (value?: string | null) => {
    const url = value?.trim()
    if (url && /^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url)
  }
  add(candidate.pg?.url)
  add(candidate.laravel?.doc_name)
  const docName = candidate.laravel?.doc_name || candidate.pg?.docName || candidate.filename
  if (profileLegacyId != null && docName && !/^https?:\/\//i.test(docName)) {
    const filename = path.basename(docName.replace(/\\/g, '/'))
    const folders: string[] = []
    if (candidate.typeId === 7) folders.push('featuredImages')
    if (candidate.typeId === 6) folders.push('services')
    const metadata = `${candidate.pg?.url || ''} ${candidate.pg?.docName || ''}`.toLowerCase()
    if (metadata.includes('/service')) folders.push('services', 'service')
    if (metadata.includes('/post')) folders.push('posts')
    for (const folder of [...new Set(folders)]) {
      add(`${mediaBase()}/storage/ecard/${folder}/${profileLegacyId}/${filename}`)
    }
  }
  return urls
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const candidates = [url]
  try {
    const encoded = encodeUrlPath(url)
    if (encoded !== url) candidates.push(encoded)
  } catch {
    // Try the original.
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { 'User-Agent': 'vbizme-review-repair/1.0', Accept: 'image/*', Referer: `${mediaBase()}/` },
        redirect: 'follow',
      })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.startsWith('image/')) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length) return { buffer, contentType }
    } catch {
      // Continue through authoritative source candidates.
    }
  }
  return null
}

async function persist(opts: {
  dryRun: boolean
  review: ReviewRow
  candidate: ImageCandidate | null
  imageUrl?: string | null
  publicId?: string
  bytes?: number
  contentType?: string
  reviewUrl?: string | null
}) {
  if (opts.dryRun) return
  assertMutationAllowed(opts.dryRun, 'Review/Attachment transaction')
  await prisma.$transaction(async (tx) => {
    if (opts.candidate && opts.imageUrl && opts.publicId) {
      const filename = sanitizeFilename(opts.candidate.filename)
      const data = {
        attachableType: SERVICE_ATTACHABLE_TYPE,
        attachableId: String(opts.review.legacyServiceId),
        profileId: opts.review.profileId,
        docName: opts.candidate.pg?.docName || opts.candidate.laravel?.doc_name || filename,
        url: opts.imageUrl,
        publicId: opts.publicId,
        resourceType: 'image',
        format: extension(filename),
        extension: extension(filename),
        mimeType: opts.contentType || mimeType(filename),
        bytes: opts.bytes ?? opts.candidate.pg?.bytes ?? 0,
      }
      if (opts.candidate.pg) {
        await tx.attachment.update({ where: { id: opts.candidate.pg.id }, data })
      } else if (opts.candidate.laravel) {
        await tx.attachment.upsert({
          where: { legacyId: opts.candidate.laravel.id },
          create: { legacyId: opts.candidate.laravel.id, ...data },
          update: data,
        })
      }
    }
    const current = await tx.review.findUnique({
      where: { id: opts.review.id },
      select: { imageUrl: true, reviewUrl: true },
    })
    const reviewData: { imageUrl?: string | null; reviewUrl?: string | null } = {}
    if (opts.imageUrl !== undefined && current?.imageUrl !== opts.imageUrl) reviewData.imageUrl = opts.imageUrl
    if (opts.reviewUrl !== undefined && current?.reviewUrl !== opts.reviewUrl) reviewData.reviewUrl = opts.reviewUrl
    if (Object.keys(reviewData).length) {
      await tx.review.update({ where: { id: opts.review.id }, data: reviewData })
    }
  })
}

async function repairReview(
  dryRun: boolean,
  review: ReviewRow,
  pgAttachments: ReviewAttachment[],
  laravelAttachments: LaravelAttachment[],
  service: LegacyService | undefined
) {
  if (review.legacyServiceId == null) {
    log('SKIPPED', review, 'no legacyServiceId; no relationship inferred')
    return
  }
  const serviceReviewUrl = extractReviewUrl(service || {})
  const reviewUrl = isLegitimatePageUrl(review.reviewUrl)
    ? undefined
    : serviceReviewUrl || (review.reviewUrl?.trim() ? null : undefined)
  const candidates = authoritativeCandidates(pgAttachments, laravelAttachments, review.legacyServiceId)
  const selected = selectPrimaryImage(candidates)
  if (candidates.length > 1) {
    log(
      'AMBIGUOUS',
      review,
      `${candidates.length} exact image attachments; selected ${selected?.key || 'none'} by type 7 > 6 > legacy/created order`
    )
  }

  if (!selected) {
    const imageUrl = clearUnprovenImage(review.imageUrl)
    if (imageUrl !== undefined || reviewUrl !== undefined) {
      await persist({ dryRun, review, candidate: null, imageUrl, reviewUrl })
    }
    log(
      'NO_SOURCE',
      review,
      `no legitimate exact image; image=${imageUrl === null ? `${dryRun ? 'would be ' : ''}cleared to NULL` : 'already NULL'}; reviewUrl=${
        reviewUrl === null
          ? `${dryRun ? 'would be ' : ''}cleared to NULL`
          : reviewUrl
            ? `${dryRun ? 'would be ' : ''}recovered`
            : 'preserved/none'
      }`
    )
    return
  }

  const existing = existingS3Plan(selected.pg?.url, selected.pg?.publicId, isUsableS3)
  if (!existing.shouldUpload && existing.url && existing.publicId) {
    await persist({
      dryRun,
      review,
      candidate: selected,
      imageUrl: existing.url,
      publicId: existing.publicId,
      contentType: selected.pg?.mimeType || mimeType(selected.filename),
      reviewUrl,
    })
    log(
      'ALREADY_S3',
      review,
      `${dryRun ? 'would reuse' : 'reused'} own attachment ${selected.key} key=${existing.publicId}; reviewUrl=${reviewUrl ? 'recovered' : 'preserved/none'}`
    )
    return
  }

  const sources = sourceUrls(selected, review.profile.legacyId)
  let source: { url: string; file: { buffer: Buffer; contentType: string } } | null = null
  for (const url of sources) {
    const file = await fetchImage(url)
    if (file) {
      source = { url, file }
      break
    }
  }
  if (!source) {
    const imageUrl = clearUnprovenImage(review.imageUrl)
    if (imageUrl !== undefined || reviewUrl !== undefined) {
      await persist({ dryRun, review, candidate: null, imageUrl, reviewUrl })
    }
    log(
      'NO_SOURCE',
      review,
      `selected=${selected.key}; source candidates=${sources.length}; image=${
        imageUrl === null ? `${dryRun ? 'would be ' : ''}cleared to NULL` : 'already NULL'
      }; reviewUrl=${
        reviewUrl === null
          ? `${dryRun ? 'would be ' : ''}cleared to NULL`
          : reviewUrl
            ? `${dryRun ? 'would be ' : ''}recovered`
            : 'preserved/none'
      }`
    )
    return
  }

  const key = s3Key(review.id, selected.filename)
  const plannedUrl = s3Utils.publicUrlForKey(key)
  if (!isAbsoluteDestination(plannedUrl)) throw new Error(`Refusing filename-only destination: ${plannedUrl}`)
  if (dryRun) {
    log(
      'REPAIRED',
      review,
      `DRY_RUN would upload ${source.url} -> ${plannedUrl}, persist selected=${selected.key}, reviewUrl=${reviewUrl || 'unchanged'}`
    )
    return
  }
  assertMutationAllowed(dryRun, 'S3 upload')
  const uploaded = await s3Utils.uploadBuffer(source.file.buffer, {
    key,
    filename: sanitizeFilename(selected.filename),
    contentType: source.file.contentType,
    resourceType: 'image',
  })
  if (!(await s3Utils.headObject(uploaded.publicId))) {
    throw new Error(`HeadObject verification failed for ${uploaded.publicId}`)
  }
  await persist({
    dryRun,
    review,
    candidate: selected,
    imageUrl: uploaded.url,
    publicId: uploaded.publicId,
    bytes: uploaded.bytes,
    contentType: source.file.contentType,
    reviewUrl,
  })
  log('REPAIRED', review, `uploaded ${source.url} -> ${uploaded.url}; selected=${selected.key}`)
}

async function processBatches(dryRun: boolean, profileId?: string) {
  const laravel = await openLaravel()
  let cursor: string | undefined
  let processed = 0
  try {
    while (true) {
      const batch: ReviewRow[] = await prisma.review.findMany({
        where: profileId ? { profileId } : {},
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { profile: { select: { slug: true, legacyId: true } } },
      })
      if (!batch.length) break
      const serviceIds = batch.map((row) => row.legacyServiceId).filter((id): id is number => id != null)
      const legacy = await loadLaravelBatch(laravel, serviceIds)
      const pgAttachments = await loadPgAttachments(
        serviceIds,
        legacy.attachments.map((row) => row.id)
      )
      const serviceMap = new Map(legacy.services.map((row) => [row.id, row]))
      const attachmentMap = new Map<number, LaravelAttachment[]>()
      for (const row of legacy.attachments) {
        const rows = attachmentMap.get(row.attachmentable_id) || []
        rows.push(row)
        attachmentMap.set(row.attachmentable_id, rows)
      }
      for (const review of batch) {
        try {
          const serviceId = review.legacyServiceId
          await repairReview(
            dryRun,
            review,
            pgAttachments,
            serviceId == null ? [] : attachmentMap.get(serviceId) || [],
            serviceId == null ? undefined : serviceMap.get(serviceId)
          )
        } catch (error) {
          log('FAILED', review, error instanceof Error ? error.message : String(error))
        }
      }
      processed += batch.length
      cursor = batch.at(-1)!.id
      console.log(`Review batch complete: ${processed}`)
    }
  } finally {
    await laravel?.end()
  }
}

async function printValidation(profileId?: string) {
  const scope = profileId ? Prisma.sql`WHERE "profileId" = ${profileId}` : Prisma.empty
  const [countsRow] = await prisma.$queryRaw<
    Array<{ total_reviews: number; with_image: number; with_review_url: number }>
  >`
    SELECT COUNT(*)::int AS total_reviews,
      COUNT(NULLIF(BTRIM("imageUrl"), ''))::int AS with_image,
      COUNT(NULLIF(BTRIM("reviewUrl"), ''))::int AS with_review_url
    FROM "Review" ${scope}
  `
  const badImageScope = profileId ? Prisma.sql`AND "profileId" = ${profileId}` : Prisma.empty
  const badImages = await prisma.$queryRaw<Array<{ id: string; legacyServiceId: number | null; imageUrl: string }>>`
    SELECT id, "legacyServiceId", "imageUrl"
    FROM "Review"
    WHERE NULLIF(BTRIM("imageUrl"), '') IS NOT NULL
      AND "imageUrl" !~* '^https?://'
      ${badImageScope}
    ORDER BY id
  `
  console.log('Review SQL counts', countsRow)
  console.log('Review non-http imageUrl rows', badImages)
}

async function printMichaelangeloReport() {
  const profile = await prisma.profile.findFirst({ where: { slug: MICHAELANGELO_SLUG }, select: { id: true } })
  console.log(`Michaelangelo report slug=${MICHAELANGELO_SLUG}`)
  if (!profile) {
    console.log('Michaelangelo profile not found')
    return
  }
  const reviews: ReviewRow[] = await prisma.review.findMany({
    where: { profileId: profile.id },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { profile: { select: { slug: true, legacyId: true } } },
  })
  const serviceIds = reviews.map((row) => row.legacyServiceId).filter((id): id is number => id != null)
  const connection = await openLaravel()
  try {
    const legacy = await loadLaravelBatch(connection, serviceIds)
    const pg = await loadPgAttachments(
      serviceIds,
      legacy.attachments.map((row) => row.id)
    )
    for (const review of reviews) {
      const serviceId = review.legacyServiceId
      const laravelRows =
        serviceId == null ? [] : legacy.attachments.filter((row) => row.attachmentable_id === serviceId)
      const candidates = serviceId == null ? [] : authoritativeCandidates(pg, laravelRows, serviceId)
      const selected = selectPrimaryImage(candidates)
      const service = serviceId == null ? undefined : legacy.services.find((row) => row.id === serviceId)
      console.log('Michaelangelo Review', {
        id: review.id,
        author: review.author,
        legacyServiceId: serviceId,
        highlighted: serviceId != null && HIGHLIGHT_SERVICE_IDS.has(serviceId),
        exactMatchingImageCount: candidates.length,
        sourcePresent: Boolean(selected),
        ownSelectedAttachment: selected?.key || null,
        selectedAttachmentS3: isUsableS3(selected?.pg?.url),
        imageUrl: review.imageUrl,
        reviewUrl: review.reviewUrl,
        recoverableReviewUrl: extractReviewUrl(service || {}),
        manufactured: false,
      })
    }
    console.log(`Michaelangelo review count=${reviews.length}; expected=10`)
  } finally {
    await connection?.end()
  }
}

async function main() {
  const { dryRun, slug } = parseRepairArgs(process.argv.slice(2), process.env.DRY_RUN ?? 'true')
  console.log(`repairReviewMedia dryRun=${dryRun} slug=${slug || '(all profiles)'} batch=${BATCH_SIZE}`)
  await assertRequiredSchema()
  const profile = slug ? await prisma.profile.findFirst({ where: { slug }, select: { id: true, slug: true } }) : null
  if (slug && !profile) throw new Error(`Profile not found for slug=${slug}`)
  await processBatches(dryRun, profile?.id)
  console.log('Repair status counts', counts)
  await printValidation(profile?.id)
  await printMichaelangeloReport()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
