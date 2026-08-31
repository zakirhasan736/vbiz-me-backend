/**
 * One-time, resumable Review media + external URL repair.
 *
 * Safety:
 * - Defaults to DRY_RUN=true.
 * - --slug=<slug> limits processing to one Profile.
 * - No --slug processes all Review rows.
 * - Never invents reviewer images or external review URLs.
 *
 * Mapping authority:
 *   legacy attachments.attachmentable_id -> Review.legacyServiceId
 * where legacy attachments.attachmentable_type = 'App\\Models\\Service'.
 *
 * Attachment.legacyId is ONLY used after the legacy Service relationship has
 * identified the correct legacy attachment, so we can locate that attachment's
 * migrated PostgreSQL row. It is never used as the Service/entity ID.
 */

import mysql, { Connection, RowDataPacket } from 'mysql2/promise'
import path from 'path'
import config from '../src/configs/config'
import { encodeUrlPath, isAlreadyOnS3 } from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'
import {
  assertMutationAllowed,
  existingS3Plan,
  isImageFilename,
  isValidDestination,
  keyFromS3Url,
  parseRepairArgs,
} from './repairClientPortfolioMedia.helpers'

const SERVICE_TYPE = 'App\\Models\\Service'
const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE) || 40)
const MYSQL_IN_CHUNK = 400
const MICHAELANGELO_SLUG = 'michaelangelo-casanova-2'
const MICHAELANGELO_KNOWN_MEDIA_IDS = new Set([956, 1081])

const REVIEW_URL_KEYS = new Set([
  'url',
  'review_url',
  'reviewurl',
  'link',
  'external_url',
  'externalurl',
  'source_url',
  'sourceurl',
  'google_review_url',
  'googlereviewurl',
  'facebook_url',
  'facebookurl',
  'yelp_url',
  'yelpurl',
  'button_url',
  'buttonurl',
])

// Legacy attachment_type_id -> established Laravel storage folder.
const FOLDER_BY_TYPE_ID: Record<number, string> = {
  6: 'services',
  7: 'featuredImages',
}

type Status =
  | 'SUCCESS'
  | 'ALREADY_S3'
  | 'SOURCE_NOT_FOUND'
  | 'UPLOAD_FAILED'
  | 'DB_UPDATE_FAILED'
  | 'AMBIGUOUS_ATTACHMENT'
  | 'FALLBACK_IMAGE'
  | 'NO_IMAGE'
  | 'REVIEW_URL_FOUND'
  | 'NO_REVIEW_URL'
  | 'SKIPPED'

type LegacyAttachment = {
  id: number
  doc_name: string | null
  attachmentable_id: number | string
  attachmentable_type: string
  attachment_type_id: number | null
  created_at: Date | string | null
}

type LegacyService = Record<string, unknown> & { id: number | string }

type LegacyMeta = Record<string, unknown> & {
  __serviceId?: number
  __table?: string
}

type PgAttachment = {
  id: string
  legacyId: number | null
  attachableType: string
  attachableId: string
  profileId: string | null
  docName: string | null
  url: string | null
  publicId: string | null
  resourceType: string | null
  format: string | null
  extension: string | null
  mimeType: string | null
  bytes: number | null
  createdAt: Date
  attachmentType: { legacyId: number | null; name: string | null } | null
}

type ReviewRow = {
  id: string
  profileId: string
  legacyServiceId: number | null
  author: string | null
  text: string | null
  rating: number | null
  imageUrl: string | null
  reviewUrl: string | null
  status: number
  sortOrder: number
  profile: { id: string; slug: string | null; legacyId: number | null }
}

type Counters = Record<Status, number>

const counts: Counters = {
  SUCCESS: 0,
  ALREADY_S3: 0,
  SOURCE_NOT_FOUND: 0,
  UPLOAD_FAILED: 0,
  DB_UPDATE_FAILED: 0,
  AMBIGUOUS_ATTACHMENT: 0,
  FALLBACK_IMAGE: 0,
  NO_IMAGE: 0,
  REVIEW_URL_FOUND: 0,
  NO_REVIEW_URL: 0,
  SKIPPED: 0,
}

function log(status: Status, review: Pick<ReviewRow, 'id' | 'author' | 'legacyServiceId'>, message: string) {
  counts[status] += 1
  const label = review.author?.trim() ? `"${review.author.trim()}"` : review.id
  console.log(`[${status}] review ${label} legacyServiceId=${review.legacyServiceId ?? 'null'} ${message}`)
}

function chunks<T>(items: T[], size = MYSQL_IN_CHUNK): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

function isHttpUrl(value?: string | null): boolean {
  const raw = value?.trim() || ''
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isFilenameOnly(value?: string | null): boolean {
  const raw = value?.trim() || ''
  return Boolean(raw && !isHttpUrl(raw) && !raw.includes('://'))
}

function isUsableS3(value?: string | null): boolean {
  const raw = value?.trim() || ''
  return isValidDestination(raw) && isAlreadyOnS3(raw)
}

function sanitizeFilename(name: string): string {
  const raw = name.trim().replace(/\\/g, '/')
  const base = path.basename(raw)
  const ext = path.extname(base)
  const stem = path
    .basename(base, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return `${stem || 'review'}${ext.toLowerCase()}`
}

function extensionOf(filename: string, fallback?: string | null): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase() || (fallback || '').replace(/^\./, '').toLowerCase()
}

function mimeForExtension(ext: string, contentType?: string | null): string {
  const header = contentType?.split(';')[0]?.trim()
  if (header && header !== 'application/octet-stream' && !header.includes('text/html')) return header
  const known: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
  }
  return known[ext] || header || 'application/octet-stream'
}

function resourceTypeForMime(mime: string, ext: string): 'image' | 'video' | 'raw' {
  if (mime.startsWith('image/') || isImageFilename(`file.${ext}`)) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'raw'
}

function filenameFrom(value?: string | null): string | null {
  const raw = value?.trim() || ''
  if (!raw) return null
  if (isHttpUrl(raw)) {
    try {
      const parsed = new URL(raw)
      return path.basename(decodeURIComponent(parsed.pathname)) || null
    } catch {
      return path.basename(raw) || null
    }
  }
  return path.basename(raw.replace(/\\/g, '/')) || null
}

function legacyAttachmentIsImage(row: LegacyAttachment): boolean {
  const filename = filenameFrom(row.doc_name)
  return Boolean(filename && isImageFilename(filename))
}

function pgAttachmentIsImage(row: PgAttachment): boolean {
  if (row.resourceType === 'image') return true
  const filename = row.docName || filenameFrom(row.url)
  return Boolean(filename && isImageFilename(filename))
}

function mediaBase(): string {
  return (config.MEDIA_BASE_URL || 'https://app.vbizme.com').replace(/\/$/, '')
}

function canonicalLegacyUrl(filename: string, attachmentTypeId: number | null, profileLegacyId: number): string | null {
  const folder = attachmentTypeId == null ? null : FOLDER_BY_TYPE_ID[attachmentTypeId]
  if (!folder) return null
  return `${mediaBase()}/storage/ecard/${folder}/${profileLegacyId}/${filename.replace(/^\/+/, '')}`
}

function objectKey(reviewId: string, filename: string): string {
  const prefix = (config.S3.KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')
  return `${prefix}/reviews/${reviewId}/${sanitizeFilename(filename)}`
}

async function assertRequiredSchema() {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Review'
      AND column_name IN ('legacyServiceId', 'imageUrl', 'reviewUrl')
  `
  const present = new Set(columns.map((row) => row.column_name))
  const missing = ['legacyServiceId', 'imageUrl', 'reviewUrl'].filter((name) => !present.has(name))
  if (missing.length) throw new Error(`Review schema missing required column(s): ${missing.join(', ')}`)
}

async function openLegacyConnection(): Promise<Connection> {
  if (!config.LARAVEL_MYSQL_URL) {
    throw new Error('LARAVEL_MYSQL_URL is not set. Refusing to repair Reviews without the legacy source database.')
  }
  return mysql.createConnection(config.LARAVEL_MYSQL_URL)
}

async function legacyTableExists(connection: Connection, table: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  )
  return Number(rows[0]?.total || 0) > 0
}

async function legacyColumns(connection: Connection, table: string): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY ordinal_position`,
    [table]
  )
  return rows.map((row) => String(row.column_name))
}

async function loadLegacyAttachments(connection: Connection, serviceIds: number[]): Promise<LegacyAttachment[]> {
  const ids = [...new Set(serviceIds)]
  if (!ids.length) return []
  const rows: LegacyAttachment[] = []
  for (const part of chunks(ids)) {
    const placeholders = part.map(() => '?').join(',')
    const [result] = await connection.query<RowDataPacket[]>(
      `SELECT id, doc_name, attachmentable_id, attachmentable_type, attachment_type_id, created_at
       FROM attachments
       WHERE attachmentable_type = ?
         AND attachmentable_id IN (${placeholders})
       ORDER BY attachmentable_id ASC, id ASC, created_at ASC`,
      [SERVICE_TYPE, ...part]
    )
    rows.push(...(result as unknown as LegacyAttachment[]))
  }
  return rows
}

async function loadLegacyServices(connection: Connection, serviceIds: number[]): Promise<LegacyService[]> {
  const ids = [...new Set(serviceIds)]
  if (!ids.length) return []
  if (!(await legacyTableExists(connection, 'services'))) {
    throw new Error('Legacy services table not found')
  }
  const rows: LegacyService[] = []
  for (const part of chunks(ids)) {
    const placeholders = part.map(() => '?').join(',')
    const [result] = await connection.query<RowDataPacket[]>(
      `SELECT * FROM services WHERE id IN (${placeholders})`,
      part
    )
    rows.push(...(result as unknown as LegacyService[]))
  }
  return rows
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const raw = value.trim()
  if (!raw || !['{', '['].includes(raw[0])) return value
  try {
    return JSON.parse(raw)
  } catch {
    return value
  }
}

function collectUrlCandidatesFromObject(value: unknown, out: string[], depth = 0) {
  if (depth > 6 || value == null) return
  const parsed = maybeJson(value)
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectUrlCandidatesFromObject(item, out, depth + 1)
    return
  }
  if (typeof parsed !== 'object') return
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = normalizeKey(rawKey)
    if (REVIEW_URL_KEYS.has(key) && typeof rawValue === 'string' && isHttpUrl(rawValue)) {
      out.push(rawValue.trim())
    }
    if (rawValue && typeof rawValue === 'object') collectUrlCandidatesFromObject(rawValue, out, depth + 1)
    else if (typeof rawValue === 'string') {
      const nested = maybeJson(rawValue)
      if (nested !== rawValue) collectUrlCandidatesFromObject(nested, out, depth + 1)
    }
  }
}

function explicitUrlFromRow(row: Record<string, unknown>): string | null {
  const candidates: string[] = []
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = normalizeKey(rawKey)
    if (REVIEW_URL_KEYS.has(key) && typeof rawValue === 'string' && isHttpUrl(rawValue)) {
      candidates.push(rawValue.trim())
    }
    if (rawValue && (typeof rawValue === 'object' || typeof rawValue === 'string')) {
      collectUrlCandidatesFromObject({ [rawKey]: rawValue }, candidates)
    }
  }
  return candidates[0] || null
}

async function loadLegacyMetaRows(
  connection: Connection,
  services: LegacyService[],
  serviceIds: number[]
): Promise<LegacyMeta[]> {
  const tables = ['service_metas', 'service_meta', 'post_metas', 'post_meta', 'metas']
  const result: LegacyMeta[] = []
  const serviceById = new Map(services.map((row) => [Number(row.id), row]))

  for (const table of tables) {
    if (!(await legacyTableExists(connection, table))) continue
    const columns = await legacyColumns(connection, table)
    const lower = new Map(columns.map((column) => [column.toLowerCase(), column]))

    let ids: number[] = []
    let idColumn: string | null = null
    let typeColumn: string | null = null
    let requireServiceType = false
    let serviceResolver: (row: Record<string, unknown>) => number | null = () => null

    if (lower.has('service_id')) {
      idColumn = lower.get('service_id')!
      ids = serviceIds
      serviceResolver = (row) => Number(row[idColumn!]) || null
    } else {
      const polymorphicId =
        lower.get('metable_id') || lower.get('metaable_id') || lower.get('model_id') || lower.get('entity_id') || null
      const polymorphicType =
        lower.get('metable_type') ||
        lower.get('metaable_type') ||
        lower.get('model_type') ||
        lower.get('entity_type') ||
        null

      if (polymorphicId && polymorphicType) {
        idColumn = polymorphicId
        typeColumn = polymorphicType
        ids = serviceIds
        requireServiceType = true
        serviceResolver = (row) => Number(row[idColumn!]) || null
      } else if (lower.has('post_id')) {
        // Only use post_metas when services itself explicitly tells us the post_id.
        const servicePostPairs = services
          .map((service) => ({
            serviceId: Number(service.id),
            postId: Number((service as Record<string, unknown>).post_id),
          }))
          .filter((pair) => Number.isFinite(pair.postId) && pair.postId > 0)

        if (!servicePostPairs.length) continue
        const postToService = new Map(servicePostPairs.map((pair) => [pair.postId, pair.serviceId]))
        idColumn = lower.get('post_id')!
        ids = [...postToService.keys()]
        serviceResolver = (row) => postToService.get(Number(row[idColumn!])) || null
      } else {
        // No authoritative Service relationship exists for this meta table.
        continue
      }
    }

    if (!idColumn || !ids.length) continue

    for (const part of chunks([...new Set(ids)])) {
      const placeholders = part.map(() => '?').join(',')
      let sql = `SELECT * FROM \`${table}\` WHERE \`${idColumn}\` IN (${placeholders})`
      const params: unknown[] = [...part]

      if (requireServiceType && typeColumn) {
        sql += ` AND \`${typeColumn}\` = ?`
        params.push(SERVICE_TYPE)
      }

      const [rows] = await connection.query<RowDataPacket[]>(sql, params)
      for (const raw of rows as unknown as Record<string, unknown>[]) {
        const serviceId = serviceResolver(raw)
        if (!serviceId || !serviceById.has(serviceId)) continue
        result.push({ ...raw, __serviceId: serviceId, __table: table })
      }
    }
  }

  return result
}

function reviewUrlForService(service: LegacyService | null, metas: LegacyMeta[]): string | null {
  if (!service) return null

  // Explicit Service columns/JSON are first priority.
  const direct = explicitUrlFromRow(service)
  if (direct) return direct

  // Meta rows are considered only after an authoritative Service relationship was established.
  for (const meta of metas) {
    const candidates: string[] = []

    const keyColumn =
      (typeof meta.meta_key === 'string' && meta.meta_key) ||
      (typeof meta.key === 'string' && meta.key) ||
      (typeof meta.name === 'string' && meta.name) ||
      (typeof meta.field === 'string' && meta.field) ||
      null

    const value = meta.meta_value ?? meta.value ?? meta.content ?? meta.data ?? meta.url ?? null

    if (keyColumn && REVIEW_URL_KEYS.has(normalizeKey(keyColumn)) && typeof value === 'string' && isHttpUrl(value)) {
      return value.trim()
    }

    collectUrlCandidatesFromObject(meta, candidates)
    if (candidates.length) return candidates[0]
  }

  return null
}

function rowsByLegacyService<T extends { attachmentable_id: number | string }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>()
  for (const row of rows) {
    const serviceId = Number(row.attachmentable_id)
    if (!Number.isFinite(serviceId)) continue
    const current = map.get(serviceId) || []
    current.push(row)
    map.set(serviceId, current)
  }
  return map
}

async function loadPgAttachments(
  reviewIds: string[],
  serviceIds: number[],
  legacyAttachmentIds: number[]
): Promise<PgAttachment[]> {
  const OR: any[] = []
  if (legacyAttachmentIds.length) OR.push({ legacyId: { in: [...new Set(legacyAttachmentIds)] } })
  if (serviceIds.length) {
    OR.push({
      attachableType: SERVICE_TYPE,
      attachableId: { in: [...new Set(serviceIds)].map(String) },
    })
  }
  if (!OR.length) return []

  return prisma.attachment.findMany({
    where: { OR },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { attachmentType: { select: { legacyId: true, name: true } } },
  }) as unknown as Promise<PgAttachment[]>
}

function selectLegacyImage(rows: LegacyAttachment[]): { row: LegacyAttachment | null; fallback: boolean } {
  const ordered = [...rows].sort(
    (a, b) =>
      Number(a.id) - Number(b.id) || new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
  )
  const featured = ordered.find((row) => Number(row.attachment_type_id) === 7 && legacyAttachmentIsImage(row))
  if (featured) return { row: featured, fallback: false }
  const firstImage = ordered.find(legacyAttachmentIsImage) || null
  return { row: firstImage, fallback: Boolean(firstImage) }
}

function selectPgImage(serviceId: number, rows: PgAttachment[]): { row: PgAttachment | null; fallback: boolean } {
  const exact = rows
    .filter(
      (row) => row.attachableType === SERVICE_TYPE && row.attachableId === String(serviceId) && pgAttachmentIsImage(row)
    )
    .sort(
      (a, b) =>
        (a.legacyId ?? Number.MAX_SAFE_INTEGER) - (b.legacyId ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime()
    )
  const featured = exact.find((row) => row.attachmentType?.legacyId === 7)
  if (featured) return { row: featured, fallback: false }
  return { row: exact[0] || null, fallback: exact.length > 0 }
}

function pgForLegacyAttachment(legacy: LegacyAttachment, candidates: PgAttachment[]): PgAttachment | null {
  // The entity relationship was already established with attachmentable_id -> Review.legacyServiceId.
  // Matching legacyId here only locates the migrated copy of THAT exact legacy attachment.
  return candidates.find((row) => row.legacyId === Number(legacy.id)) || null
}

async function fetchFile(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const candidates = [url]
  try {
    const encoded = encodeUrlPath(url)
    if (encoded !== url) candidates.push(encoded)
  } catch {
    // Keep original.
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'User-Agent': 'vbizme-review-repair/1.0',
          Accept: '*/*',
          Referer: `${mediaBase()}/`,
        },
        redirect: 'follow',
      })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || 'application/octet-stream'
      if (contentType.includes('text/html')) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length) return { buffer, contentType }
    } catch {
      // Try next.
    }
  }
  return null
}

async function locateImageSource(opts: {
  pg: PgAttachment | null
  legacy: LegacyAttachment | null
  profileLegacyId: number | null
}): Promise<{ url: string; file: { buffer: Buffer; contentType: string } } | null> {
  const candidates: string[] = []

  const add = (value?: string | null) => {
    const raw = value?.trim() || ''
    if (isHttpUrl(raw) && !candidates.includes(raw)) candidates.push(raw)
  }

  if (opts.pg?.url && !isUsableS3(opts.pg.url)) add(opts.pg.url)
  if (isHttpUrl(opts.legacy?.doc_name)) add(opts.legacy?.doc_name)

  const filename =
    (opts.legacy?.doc_name && !isHttpUrl(opts.legacy.doc_name) ? filenameFrom(opts.legacy.doc_name) : null) ||
    (opts.pg?.docName ? filenameFrom(opts.pg.docName) : null) ||
    (opts.pg?.url && isFilenameOnly(opts.pg.url) ? filenameFrom(opts.pg.url) : null)

  if (filename && opts.legacy && opts.profileLegacyId != null) {
    const canonical = canonicalLegacyUrl(filename, Number(opts.legacy.attachment_type_id), opts.profileLegacyId)
    add(canonical)
  }

  for (const url of candidates) {
    const file = await fetchFile(url)
    if (file) return { url, file }
  }
  return null
}

function metadataFor(pg: PgAttachment | null, filename: string, contentType?: string | null) {
  const format = pg?.format || extensionOf(filename, pg?.extension)
  const mimeType = pg?.mimeType || mimeForExtension(format, contentType)
  return {
    format,
    mimeType,
    resourceType: pg?.resourceType || resourceTypeForMime(mimeType, format),
    bytes: pg?.bytes || 0,
  }
}

async function persistReviewImage(opts: {
  dryRun: boolean
  review: ReviewRow
  pg: PgAttachment | null
  legacy: LegacyAttachment | null
  s3Url: string
  publicId: string
  filename: string
  mimeType: string
  format: string
  resourceType: string
  bytes: number
}): Promise<boolean> {
  if (!isUsableS3(opts.s3Url) || !opts.publicId) return false
  if (opts.dryRun) return true

  assertMutationAllowed(opts.dryRun, 'Review image transaction')

  try {
    await prisma.$transaction(async (tx) => {
      const attachmentData = {
        url: opts.s3Url,
        publicId: opts.publicId,
        resourceType: opts.resourceType,
        format: opts.format,
        extension: opts.format,
        mimeType: opts.mimeType,
        bytes: opts.bytes,
        profileId: opts.review.profileId,
      }

      if (opts.pg) {
        // Preserve attachableId/type so the original legacyServiceId mapping remains intact.
        await tx.attachment.update({
          where: { id: opts.pg.id },
          data: {
            ...attachmentData,
            docName: opts.pg.docName || opts.filename,
          },
        })
      } else if (opts.legacy) {
        await tx.attachment.upsert({
          where: { legacyId: Number(opts.legacy.id) },
          create: {
            legacyId: Number(opts.legacy.id),
            attachableType: SERVICE_TYPE,
            attachableId: String(opts.review.legacyServiceId),
            ...attachmentData,
            docName: opts.legacy.doc_name || opts.filename,
            profileId: opts.review.profileId,
          },
          update: attachmentData,
        })
      }

      // Review.imageUrl is authoritative. Never substitute profile media.
      await tx.review.update({
        where: { id: opts.review.id },
        data: { imageUrl: opts.s3Url },
      })
    })
    return true
  } catch (error) {
    console.error(error)
    return false
  }
}

async function migrateReviewImage(
  dryRun: boolean,
  review: ReviewRow,
  legacyRows: LegacyAttachment[],
  pgCandidates: PgAttachment[]
) {
  if (review.legacyServiceId == null) {
    log('SKIPPED', review, 'legacyServiceId is NULL')
    return
  }

  const selectedLegacy = selectLegacyImage(legacyRows)
  let legacy = selectedLegacy.row
  let pg: PgAttachment | null = legacy ? pgForLegacyAttachment(legacy, pgCandidates) : null
  let fallback = selectedLegacy.fallback

  if (!legacy) {
    const selectedPg = selectPgImage(review.legacyServiceId, pgCandidates)
    pg = selectedPg.row
    fallback = selectedPg.fallback
  }

  if (!legacy && !pg) {
    log('NO_IMAGE', review, 'no legitimate legacy Service image exists; imageUrl remains NULL')
    return
  }

  if (fallback) {
    log('FALLBACK_IMAGE', review, 'no featured type-7 image; selected first legitimate image by legacy ordering')
  }

  const filename =
    filenameFrom(legacy?.doc_name) ||
    filenameFrom(pg?.docName) ||
    filenameFrom(pg?.url) ||
    `review-${review.legacyServiceId}.jpg`

  if (!isImageFilename(filename) && pg?.resourceType !== 'image') {
    log('NO_IMAGE', review, `selected attachment is not an image (${filename}); imageUrl unchanged`)
    return
  }

  // Only the selected Review attachment may provide the Review image.
  if (isUsableS3(pg?.url)) {
    const publicId = pg?.publicId || keyFromS3Url(pg?.url || '')
    const plan = existingS3Plan(pg?.url || null, publicId, isUsableS3)
    if (!plan.shouldUpload && plan.url && plan.publicId) {
      const metadata = metadataFor(pg, filename)
      const ok = await persistReviewImage({
        dryRun,
        review,
        pg,
        legacy,
        s3Url: plan.url,
        publicId: plan.publicId,
        filename,
        ...metadata,
      })
      log(
        ok ? 'ALREADY_S3' : 'DB_UPDATE_FAILED',
        review,
        ok
          ? `existing S3 image ${dryRun ? 'would be ' : ''}connected to this Review`
          : `could not persist existing S3 image key=${plan.publicId}`
      )
      return
    }
  }

  const source = await locateImageSource({
    pg,
    legacy,
    profileLegacyId: review.profile.legacyId,
  })

  if (!source) {
    log('SOURCE_NOT_FOUND', review, `original image file not found for ${filename}; imageUrl unchanged`)
    return
  }

  const format = extensionOf(filename, pg?.extension)
  const mimeType = mimeForExtension(format, source.file.contentType)
  const resourceType = resourceTypeForMime(mimeType, format)
  if (resourceType !== 'image') {
    log('NO_IMAGE', review, `located media is not an image (${mimeType}); imageUrl unchanged`)
    return
  }

  const key = objectKey(review.id, filename)
  const plannedUrl = s3Utils.publicUrlForKey(key)

  if (dryRun) {
    log('SUCCESS', review, `DRY_RUN would upload ${source.url} -> ${plannedUrl}`)
    return
  }

  assertMutationAllowed(dryRun, 'Review S3 upload')

  try {
    const uploaded = await s3Utils.uploadBuffer(source.file.buffer, {
      key,
      filename: sanitizeFilename(filename),
      contentType: mimeType,
      resourceType: 'image',
    })

    if (!(await s3Utils.headObject(uploaded.publicId))) {
      log('UPLOAD_FAILED', review, `S3 HeadObject failed for ${uploaded.publicId}`)
      return
    }

    const ok = await persistReviewImage({
      dryRun,
      review,
      pg,
      legacy,
      s3Url: uploaded.url,
      publicId: uploaded.publicId,
      filename,
      mimeType,
      format,
      resourceType: uploaded.resourceType,
      bytes: uploaded.bytes ?? 0,
    })

    log(
      ok ? 'SUCCESS' : 'DB_UPDATE_FAILED',
      review,
      ok
        ? `uploaded ${source.url} -> ${uploaded.url}`
        : `S3 upload succeeded but DB update failed; recover key ${uploaded.publicId}`
    )
  } catch (error) {
    log('UPLOAD_FAILED', review, error instanceof Error ? error.message : String(error))
  }
}

async function repairReviewUrl(dryRun: boolean, review: ReviewRow, service: LegacyService | null, metas: LegacyMeta[]) {
  const found = reviewUrlForService(service, metas)
  const isLeaveReview = /(?:leave|write)\s+(?:a\s+)?review/i.test(review.author || '')

  if (!found) {
    log(
      'NO_REVIEW_URL',
      review,
      isLeaveReview
        ? 'Leave/Write A Review record has no legitimate legacy submission URL; reviewUrl remains NULL'
        : 'no legitimate external review URL exists in the legacy Service/meta data'
    )
    return
  }

  if (dryRun) {
    log('REVIEW_URL_FOUND', review, `${isLeaveReview ? 'CTA ' : ''}DRY_RUN would set reviewUrl=${found}`)
    return
  }

  assertMutationAllowed(dryRun, 'Review reviewUrl update')
  try {
    await prisma.review.update({
      where: { id: review.id },
      data: { reviewUrl: found },
    })
    log('REVIEW_URL_FOUND', review, `${isLeaveReview ? 'CTA ' : ''}reviewUrl=${found}`)
  } catch (error) {
    log(
      'DB_UPDATE_FAILED',
      review,
      `reviewUrl update failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function processReviewBatch(dryRun: boolean, batch: ReviewRow[], connection: Connection) {
  const serviceIds = batch.map((review) => review.legacyServiceId).filter((id): id is number => id != null)

  const legacyAttachments = await loadLegacyAttachments(connection, serviceIds)
  const legacyServices = await loadLegacyServices(connection, serviceIds)
  const legacyMetas = await loadLegacyMetaRows(connection, legacyServices, serviceIds)

  const legacyByService = rowsByLegacyService(legacyAttachments)
  const serviceById = new Map(legacyServices.map((row) => [Number(row.id), row]))
  const metasByService = new Map<number, LegacyMeta[]>()
  for (const meta of legacyMetas) {
    if (!meta.__serviceId) continue
    const current = metasByService.get(meta.__serviceId) || []
    current.push(meta)
    metasByService.set(meta.__serviceId, current)
  }

  const pgCandidates = await loadPgAttachments(
    batch.map((review) => review.id),
    serviceIds,
    legacyAttachments.map((row) => Number(row.id))
  )

  for (const review of batch) {
    try {
      const serviceId = review.legacyServiceId
      const sourceAttachments = serviceId == null ? [] : legacyByService.get(serviceId) || []
      const sourceService = serviceId == null ? null : serviceById.get(serviceId) || null
      const sourceMetas = serviceId == null ? [] : metasByService.get(serviceId) || []

      if (sourceAttachments.length > 1) {
        const images = sourceAttachments.filter(legacyAttachmentIsImage)
        if (images.length > 1) {
          log(
            'AMBIGUOUS_ATTACHMENT',
            review,
            `${images.length} legitimate legacy images found; type 7 is preferred, otherwise first image by legacy ordering`
          )
        }
      }

      await migrateReviewImage(dryRun, review, sourceAttachments, pgCandidates)
      await repairReviewUrl(dryRun, review, sourceService, sourceMetas)
    } catch (error) {
      log(
        /prisma|database|transaction|constraint|column|relation|connect|query/i.test(String(error))
          ? 'DB_UPDATE_FAILED'
          : 'UPLOAD_FAILED',
        review,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

async function processReviewBatches(dryRun: boolean, profileId?: string) {
  const connection = await openLegacyConnection()
  let cursor: string | undefined
  let processed = 0

  try {
    while (true) {
      const batch = (await prisma.review.findMany({
        where: {
          legacyServiceId: { not: null },
          ...(profileId ? { profileId } : {}),
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          profile: { select: { id: true, slug: true, legacyId: true } },
        },
      })) as unknown as ReviewRow[]

      if (!batch.length) break

      await processReviewBatch(dryRun, batch, connection)

      processed += batch.length
      cursor = batch.at(-1)!.id
      console.log(`Review batch complete: ${processed}`)
    }
  } finally {
    await connection.end()
  }

  return processed
}

async function printValidation(profileId?: string) {
  const where = profileId ? { profileId } : {}
  const reviews = await prisma.review.findMany({
    where,
    select: {
      id: true,
      author: true,
      legacyServiceId: true,
      imageUrl: true,
      reviewUrl: true,
    },
  })

  const badImageUrls = reviews.filter(
    (review) => review.imageUrl && review.imageUrl.trim() && !isHttpUrl(review.imageUrl)
  )

  const duplicateImageUrls = new Map<
    string,
    Array<{ id: string; author: string | null; legacyServiceId: number | null }>
  >()
  for (const review of reviews) {
    const url = review.imageUrl?.trim()
    if (!url) continue
    const current = duplicateImageUrls.get(url) || []
    current.push({ id: review.id, author: review.author, legacyServiceId: review.legacyServiceId })
    duplicateImageUrls.set(url, current)
  }

  const duplicates = [...duplicateImageUrls.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([imageUrl, rows]) => ({ imageUrl, uses: rows.length, reviews: rows }))

  console.log('Review counts', {
    total: reviews.length,
    with_image: reviews.filter((review) => Boolean(review.imageUrl?.trim())).length,
    with_review_url: reviews.filter((review) => Boolean(review.reviewUrl?.trim())).length,
  })
  console.log('filename-only Review.imageUrl', badImageUrls)
  console.log('duplicate Review.imageUrl requiring manual legacy verification', duplicates)
}

async function printMichaelangeloValidation() {
  const profile = await prisma.profile.findFirst({
    where: { slug: MICHAELANGELO_SLUG },
    select: { id: true },
  })
  if (!profile) {
    console.log(`Michaelangelo validation: profile not found slug=${MICHAELANGELO_SLUG}`)
    return
  }

  const reviews = await prisma.review.findMany({
    where: { profileId: profile.id },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      legacyServiceId: true,
      author: true,
      imageUrl: true,
      reviewUrl: true,
      sortOrder: true,
    },
  })

  console.log(`Michaelangelo validation: slug=${MICHAELANGELO_SLUG} reviews=${reviews.length}`)
  for (const review of reviews) {
    console.log('Michaelangelo Review', {
      legacyServiceId: review.legacyServiceId,
      author: review.author,
      imageUrl: review.imageUrl,
      imageIsS3: isUsableS3(review.imageUrl),
      reviewUrl: review.reviewUrl,
      knownMigratedPgMediaExpected:
        review.legacyServiceId != null && MICHAELANGELO_KNOWN_MEDIA_IDS.has(review.legacyServiceId),
    })
  }
}

async function main() {
  const { dryRun, slug } = parseRepairArgs(process.argv.slice(2), process.env.DRY_RUN ?? 'true')
  console.log(`repairReviewMediaUrls dryRun=${dryRun} slug=${slug || '(all)'} batch=${BATCH_SIZE}`)

  await assertRequiredSchema()

  const profile = slug
    ? await prisma.profile.findFirst({
        where: { slug },
        select: { id: true, slug: true },
      })
    : null

  if (slug && !profile) throw new Error(`Profile not found for slug=${slug}`)

  const processed = await processReviewBatches(dryRun, profile?.id)
  console.log(`Review processing complete: ${processed}`)
  console.log('Status counts', counts)

  await printValidation(profile?.id)
  if (slug === MICHAELANGELO_SLUG || !slug) await printMichaelangeloValidation()
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
