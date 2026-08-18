/**
 * One-time, resumable Client + Portfolio media repair.
 *
 * Defaults to a global, read-only dry run. Use --slug only for explicit testing.
 * Mapping authority:
 *   Laravel attachments.attachmentable_id -> Client.legacyServiceId -> Client.id
 *   Laravel attachments.attachmentable_id -> Portfolio.legacyId -> Portfolio.id
 */
import mysql from 'mysql2/promise'
import path from 'path'
import { Prisma } from '../generated/prisma/client'
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
  LegacyMediaRow,
  matchEntityAttachments,
  parseRepairArgs,
  pickClientPrimary,
  pickPortfolioRoles,
  typeNameMatches,
} from './repairClientPortfolioMedia.helpers'

const SERVICE_TYPE = 'App\\Models\\Service'
const PORTFOLIO_TYPE = 'App\\Models\\Portfolio'
const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE) || 40)
const MYSQL_IN_CHUNK = 400
const MICHAELANGELO_SLUG = 'michaelangelo-casanova-2'
const MICHAELANGELO_CLIENT_IDS = [821, 822, 823, 824, 825, 826, 829, 832, 846, 952, 1052, 255, 265]
const MICHAELANGELO_PORTFOLIO_IDS = [121, 123, 125, 430, 431, 432, 433, 783, 852]

const FOLDER_BY_TYPE_ID: Record<number, string> = {
  5: 'portFolios',
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
  | 'SKIPPED'
type Kind = 'client' | 'portfolio'

type LogRow = {
  status: Status
  kind: Kind
  entityId?: string
  title?: string | null
  legacyEntityId?: number | null
  attachmentId?: string | null
  attachmentLegacyId?: number | null
  s3Key?: string
  s3Url?: string
  sourceUrl?: string
  message: string
}

type LaravelAttachment = LegacyMediaRow

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

type ClientRow = {
  id: string
  title: string | null
  featuredImage: string | null
  legacyServiceId: number | null
  profileId: string
  profile: { id: string; slug: string | null; legacyId: number | null }
}

type PortfolioRow = {
  id: string
  title: string | null
  imageUrl: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  legacyId: number | null
  profileId: string
  profile: { id: string; slug: string | null; legacyId: number | null }
}

const counts: Record<Status, number> = {
  SUCCESS: 0,
  ALREADY_S3: 0,
  SOURCE_NOT_FOUND: 0,
  UPLOAD_FAILED: 0,
  DB_UPDATE_FAILED: 0,
  AMBIGUOUS_ATTACHMENT: 0,
  SKIPPED: 0,
}

function log(row: LogRow) {
  counts[row.status] += 1
  const label = row.title ? `"${row.title}"` : row.entityId || ''
  console.log(`[${row.status}] ${row.kind} ${label} ${row.message}`.trim())
}

function isHttpUrl(value?: string | null): boolean {
  return Boolean(value && /^https?:\/\//i.test(value.trim()))
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
  const base = path.basename(name.trim().replace(/\\/g, '/'))
  const ext = path.extname(base)
  const stem = path
    .basename(base, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${stem || 'file'}${ext.toLowerCase()}`
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
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
  }
  return known[ext] || header || 'application/octet-stream'
}

function resourceTypeForMime(mime: string, ext: string): 'image' | 'video' | 'raw' {
  if (mime.startsWith('image/') || isImageFilename(`file.${ext}`)) return 'image'
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video'
  return 'raw'
}

function folderForTypeId(typeId?: number | null): string | null {
  return typeId == null ? null : FOLDER_BY_TYPE_ID[typeId] || null
}

function mediaBase(): string {
  return (config.MEDIA_BASE_URL || 'https://app.vbizme.com').replace(/\/$/, '')
}

function canonicalLegacyUrl(filename: string, folder: string, profileLegacyId: number): string {
  return `${mediaBase()}/storage/ecard/${folder}/${profileLegacyId}/${filename.replace(/^\/+/, '')}`
}

function objectKey(kind: Kind, entityId: string, filename: string): string {
  const prefix = (config.S3.KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')
  return `${prefix}/${kind === 'client' ? 'clients' : 'portfolio'}/${entityId}/${sanitizeFilename(filename)}`
}

function chunks<T>(items: T[], size = MYSQL_IN_CHUNK): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

async function assertRequiredSchema() {
  const [result] = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Client'
        AND column_name = 'legacyServiceId'
    ) AS present
  `
  if (!result?.present) {
    throw new Error(
      'Client.legacyServiceId is missing. Deploy Prisma migration 20260818220000_client_legacy_service_id before running this repair.'
    )
  }
}

async function loadLaravelRows(kind: 'Service' | 'Portfolio', legacyEntityIds: number[]): Promise<LaravelAttachment[]> {
  const ids = [...new Set(legacyEntityIds)]
  if (!ids.length) return []
  if (!config.LARAVEL_MYSQL_URL) {
    console.warn('LARAVEL_MYSQL_URL is not set; Laravel source attachments cannot be loaded')
    return []
  }
  const connection = await mysql.createConnection(config.LARAVEL_MYSQL_URL)
  const rows: LaravelAttachment[] = []
  try {
    for (const part of chunks(ids)) {
      const placeholders = part.map(() => '?').join(',')
      const [result] = await connection.query(
        `SELECT id, doc_name, attachmentable_id, attachmentable_type, attachment_type_id, created_at
         FROM attachments
         WHERE attachmentable_type LIKE ?
           AND attachmentable_id IN (${placeholders})
         ORDER BY attachmentable_id ASC, id ASC, created_at ASC`,
        [`%${kind}%`, ...part]
      )
      rows.push(...(result as LaravelAttachment[]))
    }
  } finally {
    await connection.end()
  }
  return rows
}

function rowsByEntity(rows: LaravelAttachment[]): Map<number, LaravelAttachment[]> {
  const result = new Map<number, LaravelAttachment[]>()
  for (const row of rows) {
    const id = Number(row.attachmentable_id)
    const list = result.get(id) || []
    list.push(row)
    result.set(id, list)
  }
  return result
}

async function loadPgAttachmentsForBatch(opts: {
  entityIds: string[]
  legacyEntityIds: number[]
  laravelAttachmentIds: number[]
}): Promise<PgAttachment[]> {
  const attachableIds = [...new Set([...opts.entityIds, ...opts.legacyEntityIds.map(String)])]
  const legacyIds = [...new Set(opts.laravelAttachmentIds)]
  if (!attachableIds.length && !legacyIds.length) return []
  return prisma.attachment.findMany({
    where: {
      OR: [
        ...(attachableIds.length ? [{ attachableId: { in: attachableIds } }] : []),
        ...(legacyIds.length ? [{ legacyId: { in: legacyIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { attachmentType: { select: { legacyId: true, name: true } } },
  })
}

async function fetchFile(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const candidates = [url]
  try {
    const encoded = encodeUrlPath(url)
    if (encoded !== url) candidates.push(encoded)
  } catch {
    // Keep the original URL.
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { 'User-Agent': 'vbizme-client-portfolio-repair/2.0', Accept: '*/*', Referer: `${mediaBase()}/` },
        redirect: 'follow',
      })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || 'application/octet-stream'
      if (contentType.includes('text/html')) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length) return { buffer, contentType }
    } catch {
      // Try the next canonical form.
    }
  }
  return null
}

async function locateSource(opts: {
  pgUrl?: string | null
  pgDocName?: string | null
  laravel?: LaravelAttachment | null
  profileLegacyId?: number | null
}): Promise<{ url: string; file: { buffer: Buffer; contentType: string } } | { url?: string; file: null }> {
  const tried: string[] = []
  const tryUrl = async (candidate?: string | null) => {
    const url = candidate?.trim()
    if (!url || !isHttpUrl(url) || tried.includes(url)) return null
    tried.push(url)
    const file = await fetchFile(url)
    return file ? { url, file } : null
  }
  if (opts.pgUrl && !isUsableS3(opts.pgUrl)) {
    const hit = await tryUrl(opts.pgUrl)
    if (hit) return hit
  }
  if (isHttpUrl(opts.laravel?.doc_name)) {
    const hit = await tryUrl(opts.laravel?.doc_name)
    if (hit) return hit
  }
  const filename =
    (opts.laravel?.doc_name && !isHttpUrl(opts.laravel.doc_name) ? opts.laravel.doc_name : null) ||
    (opts.pgDocName && !isHttpUrl(opts.pgDocName) ? path.basename(opts.pgDocName) : null) ||
    (opts.pgUrl && isFilenameOnly(opts.pgUrl) ? path.basename(opts.pgUrl) : null)
  const folder = folderForTypeId(opts.laravel?.attachment_type_id)
  if (filename && folder && opts.profileLegacyId != null) {
    const hit = await tryUrl(canonicalLegacyUrl(filename, folder, opts.profileLegacyId))
    if (hit) return hit
  }
  return { url: tried[0], file: null }
}

type EntityPatch = {
  clientFeaturedImage?: string
  portfolio?: Partial<{ imageUrl: string; attachmentUrl: string; attachmentName: string }>
}

async function persistFile(opts: {
  dryRun: boolean
  kind: Kind
  attachment: PgAttachment | null
  laravel: LaravelAttachment | null
  entityId: string
  profileId: string
  s3Url: string
  publicId: string
  mimeType: string
  format: string
  resourceType: string
  bytes: number
  filename: string
  entityPatch?: EntityPatch
}): Promise<'ok' | 'db'> {
  if (!isUsableS3(opts.s3Url) || !opts.publicId) return 'db'
  if (opts.dryRun) return 'ok'
  assertMutationAllowed(opts.dryRun, 'Attachment/entity transaction')
  const attachableType = opts.kind === 'client' ? SERVICE_TYPE : PORTFOLIO_TYPE
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
        profileId: opts.profileId,
        attachableType,
        attachableId: opts.entityId,
      }
      if (opts.attachment) {
        await tx.attachment.update({
          where: { id: opts.attachment.id },
          data: { ...attachmentData, docName: opts.attachment.docName || opts.filename },
        })
      } else if (opts.laravel) {
        await tx.attachment.upsert({
          where: { legacyId: opts.laravel.id },
          create: { legacyId: opts.laravel.id, docName: opts.laravel.doc_name, ...attachmentData },
          update: attachmentData,
        })
      }
      if (opts.entityPatch?.clientFeaturedImage) {
        const current = await tx.client.findUnique({ where: { id: opts.entityId }, select: { featuredImage: true } })
        if (!isUsableS3(current?.featuredImage)) {
          await tx.client.update({
            where: { id: opts.entityId },
            data: { featuredImage: opts.entityPatch.clientFeaturedImage },
          })
        }
      }
      if (opts.entityPatch?.portfolio) {
        const current = await tx.portfolio.findUnique({
          where: { id: opts.entityId },
          select: { imageUrl: true, attachmentUrl: true },
        })
        const data = { ...opts.entityPatch.portfolio }
        if (isUsableS3(current?.imageUrl)) delete data.imageUrl
        if (isUsableS3(current?.attachmentUrl)) {
          delete data.attachmentUrl
          delete data.attachmentName
        }
        if (Object.keys(data).length) await tx.portfolio.update({ where: { id: opts.entityId }, data })
      }
    })
    return 'ok'
  } catch (error) {
    console.error(error)
    return 'db'
  }
}

async function uploadFile(opts: {
  dryRun: boolean
  kind: Kind
  entityId: string
  filename: string
  source: { url: string; file: { buffer: Buffer; contentType: string } }
}) {
  const format = extensionOf(opts.filename)
  const mimeType = mimeForExtension(format, opts.source.file.contentType)
  const resourceType = resourceTypeForMime(mimeType, format)
  const plannedKey = objectKey(opts.kind, opts.entityId, opts.filename)
  const plannedUrl = s3Utils.publicUrlForKey(plannedKey)
  if (opts.dryRun) {
    return {
      status: 'SUCCESS' as Status,
      s3Url: plannedUrl,
      publicId: plannedKey,
      mimeType,
      format,
      resourceType,
      bytes: opts.source.file.buffer.length,
      message: `DRY_RUN would upload ${opts.source.url} -> ${plannedUrl}`,
    }
  }
  assertMutationAllowed(opts.dryRun, 'S3 upload')
  try {
    const uploaded = await s3Utils.uploadBuffer(opts.source.file.buffer, {
      key: plannedKey,
      filename: sanitizeFilename(opts.filename),
      contentType: mimeType,
      resourceType,
    })
    if (!(await s3Utils.headObject(uploaded.publicId))) {
      return {
        status: 'UPLOAD_FAILED' as Status,
        s3Key: uploaded.publicId,
        message: `HeadObject failed for ${uploaded.publicId}`,
      }
    }
    return {
      status: 'SUCCESS' as Status,
      s3Url: uploaded.url,
      publicId: uploaded.publicId,
      mimeType,
      format,
      resourceType: uploaded.resourceType,
      bytes: uploaded.bytes,
      message: `uploaded ${opts.source.url} -> ${uploaded.url}`,
    }
  } catch (error) {
    return {
      status: 'UPLOAD_FAILED' as Status,
      s3Key: plannedKey,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function metadataFor(attachment: PgAttachment | null, filename: string) {
  const format = attachment?.format || extensionOf(filename, attachment?.extension)
  const mimeType = attachment?.mimeType || mimeForExtension(format)
  return {
    format,
    mimeType,
    resourceType: attachment?.resourceType || resourceTypeForMime(mimeType, format),
    bytes: attachment?.bytes || 0,
  }
}

function workItems(laravelRows: LaravelAttachment[], matched: PgAttachment[]) {
  const used = new Set<string>()
  const items: Array<{ laravel: LaravelAttachment | null; attachment: PgAttachment | null }> = laravelRows.map(
    (laravel) => {
      const attachment = matched.find((candidate) => candidate.legacyId === laravel.id) || null
      if (attachment) used.add(attachment.id)
      return { laravel, attachment }
    }
  )
  for (const attachment of matched) {
    if (!used.has(attachment.id)) items.push({ laravel: null, attachment })
  }
  return items
}

async function repairOneFile(opts: {
  dryRun: boolean
  kind: Kind
  entityId: string
  title: string | null
  legacyEntityId: number | null
  profileId: string
  profileLegacyId: number | null
  laravel: LaravelAttachment | null
  attachment: PgAttachment | null
  existingDestinationUrl?: string | null
  entityPatch: (url: string, filename: string, image: boolean) => EntityPatch | undefined
}) {
  const filename = opts.laravel?.doc_name || opts.attachment?.docName || 'file'
  const metadata = metadataFor(opts.attachment, filename)
  const image = metadata.resourceType === 'image'
  const reusableUrl = isUsableS3(opts.attachment?.url) ? opts.attachment?.url : opts.existingDestinationUrl
  const reusablePublicId =
    reusableUrl === opts.attachment?.url ? opts.attachment?.publicId : keyFromS3Url(reusableUrl || '')
  const existing = existingS3Plan(reusableUrl, reusablePublicId, isUsableS3)
  if (!existing.shouldUpload && existing.url && existing.publicId) {
    const db = await persistFile({
      dryRun: opts.dryRun,
      kind: opts.kind,
      attachment: opts.attachment,
      laravel: opts.laravel,
      entityId: opts.entityId,
      profileId: opts.profileId,
      s3Url: existing.url,
      publicId: existing.publicId,
      ...metadata,
      filename,
      entityPatch: opts.entityPatch(existing.url, filename, image),
    })
    log({
      status: db === 'ok' ? 'ALREADY_S3' : 'DB_UPDATE_FAILED',
      kind: opts.kind,
      entityId: opts.entityId,
      title: opts.title,
      legacyEntityId: opts.legacyEntityId,
      attachmentId: opts.attachment?.id,
      attachmentLegacyId: opts.laravel?.id ?? opts.attachment?.legacyId,
      s3Key: existing.publicId,
      s3Url: existing.url,
      message:
        db === 'ok'
          ? `existing S3 URL reused; metadata and relationship ${opts.dryRun ? 'would be ' : ''}repaired`
          : `existing S3 object retained but DB transaction failed; key ${existing.publicId}`,
    })
    return
  }
  if (!existing.shouldUpload && (!existing.publicId || !existing.url)) {
    log({
      status: 'SKIPPED',
      kind: opts.kind,
      entityId: opts.entityId,
      title: opts.title,
      legacyEntityId: opts.legacyEntityId,
      attachmentId: opts.attachment?.id,
      message: 'S3 URL exists but its object key could not be derived; no upload attempted',
    })
    return
  }
  const located = await locateSource({
    pgUrl: opts.attachment?.url,
    pgDocName: opts.attachment?.docName,
    laravel: opts.laravel,
    profileLegacyId: opts.profileLegacyId,
  })
  if (!located.file) {
    log({
      status: 'SOURCE_NOT_FOUND',
      kind: opts.kind,
      entityId: opts.entityId,
      title: opts.title,
      legacyEntityId: opts.legacyEntityId,
      attachmentId: opts.attachment?.id,
      attachmentLegacyId: opts.laravel?.id ?? opts.attachment?.legacyId,
      sourceUrl: located.url,
      message: 'original file not found; DB unchanged',
    })
    return
  }
  const uploaded = await uploadFile({
    dryRun: opts.dryRun,
    kind: opts.kind,
    entityId: opts.entityId,
    filename,
    source: located,
  })
  if (uploaded.status !== 'SUCCESS' || !uploaded.s3Url || !uploaded.publicId) {
    log({
      status: uploaded.status,
      kind: opts.kind,
      entityId: opts.entityId,
      title: opts.title,
      legacyEntityId: opts.legacyEntityId,
      attachmentId: opts.attachment?.id,
      attachmentLegacyId: opts.laravel?.id ?? opts.attachment?.legacyId,
      s3Key: uploaded.s3Key,
      sourceUrl: located.url,
      message: uploaded.message,
    })
    return
  }
  const db = await persistFile({
    dryRun: opts.dryRun,
    kind: opts.kind,
    attachment: opts.attachment,
    laravel: opts.laravel,
    entityId: opts.entityId,
    profileId: opts.profileId,
    s3Url: uploaded.s3Url,
    publicId: uploaded.publicId,
    mimeType: uploaded.mimeType || metadata.mimeType,
    format: uploaded.format || metadata.format,
    resourceType: uploaded.resourceType || metadata.resourceType,
    bytes: uploaded.bytes || located.file.buffer.length,
    filename,
    entityPatch: opts.entityPatch(uploaded.s3Url, filename, image),
  })
  log({
    status: db === 'ok' ? 'SUCCESS' : 'DB_UPDATE_FAILED',
    kind: opts.kind,
    entityId: opts.entityId,
    title: opts.title,
    legacyEntityId: opts.legacyEntityId,
    attachmentId: opts.attachment?.id,
    attachmentLegacyId: opts.laravel?.id ?? opts.attachment?.legacyId,
    s3Key: uploaded.publicId,
    s3Url: uploaded.s3Url,
    sourceUrl: located.url,
    message: db === 'ok' ? uploaded.message : `S3 upload succeeded but DB failed; recover key ${uploaded.publicId}`,
  })
}

async function repairClient(
  dryRun: boolean,
  client: ClientRow,
  candidates: PgAttachment[],
  laravelRows: LaravelAttachment[]
) {
  if (client.legacyServiceId == null && !candidates.some((row) => row.attachableId === client.id)) {
    log({
      status: 'SKIPPED',
      kind: 'client',
      entityId: client.id,
      title: client.title,
      message: 'Client.legacyServiceId is missing; authoritative Laravel mapping is unavailable',
    })
    return
  }
  const matched = matchEntityAttachments({
    attachments: candidates,
    kind: 'Service',
    legacyEntityId: client.legacyServiceId,
    entityId: client.id,
    laravelRows,
  })
  if (!laravelRows.length && !matched.length) {
    log({
      status: 'SKIPPED',
      kind: 'client',
      entityId: client.id,
      title: client.title,
      legacyEntityId: client.legacyServiceId,
      message: 'no authoritative Laravel or connected Postgres attachment',
    })
    return
  }
  const primaryLaravel = pickClientPrimary(laravelRows)
  const primaryPg =
    (primaryLaravel && matched.find((row) => row.legacyId === primaryLaravel.id)) ||
    matched.find((row) => row.attachmentType?.legacyId === 7) ||
    matched.find((row) => row.attachmentType?.legacyId === 6) ||
    matched.find((row) => metadataFor(row, row.docName || '').resourceType === 'image') ||
    null
  if (laravelRows.length > 1) {
    log({
      status: 'AMBIGUOUS_ATTACHMENT',
      kind: 'client',
      entityId: client.id,
      title: client.title,
      legacyEntityId: client.legacyServiceId,
      message: `${laravelRows.length} Laravel attachments found; type 7, then type 6, then first image is primary`,
    })
  }
  for (const item of workItems(laravelRows, matched)) {
    const isPrimary = item.laravel ? item.laravel.id === primaryLaravel?.id : item.attachment?.id === primaryPg?.id
    await repairOneFile({
      dryRun,
      kind: 'client',
      entityId: client.id,
      title: client.title,
      legacyEntityId: client.legacyServiceId,
      profileId: client.profileId,
      profileLegacyId: client.profile.legacyId,
      laravel: item.laravel,
      attachment: item.attachment,
      existingDestinationUrl: isPrimary ? client.featuredImage : null,
      entityPatch: (url, _filename, image) => (isPrimary && image ? { clientFeaturedImage: url } : undefined),
    })
  }
}

async function repairPortfolio(
  dryRun: boolean,
  portfolio: PortfolioRow,
  candidates: PgAttachment[],
  laravelRows: LaravelAttachment[]
) {
  const matched = matchEntityAttachments({
    attachments: candidates,
    kind: 'Portfolio',
    legacyEntityId: portfolio.legacyId,
    entityId: portfolio.id,
    laravelRows,
  })
  if (!laravelRows.length && !matched.length) {
    log({
      status: 'SKIPPED',
      kind: 'portfolio',
      entityId: portfolio.id,
      title: portfolio.title,
      legacyEntityId: portfolio.legacyId,
      message: 'no authoritative Laravel or connected Postgres attachment',
    })
    return
  }
  const roles = pickPortfolioRoles(laravelRows)
  const orderedPg = [...matched].sort(
    (a, b) =>
      (a.legacyId ?? Number.MAX_SAFE_INTEGER) - (b.legacyId ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  )
  const fallbackPg = orderedPg.find((row) => metadataFor(row, row.docName || '').resourceType === 'image') || null
  const primaryPg =
    (roles.featured && matched.find((row) => row.legacyId === roles.featured?.id)) ||
    (!roles.featured ? fallbackPg : null)
  if (roles.featuredFallback && roles.featured) {
    console.log(
      `[fallback] portfolio ${portfolio.id} legacy=${portfolio.legacyId ?? 'null'} selected first legacy-ordered image attachment ${roles.featured.id}`
    )
  } else if (!roles.featured && fallbackPg) {
    console.log(`[fallback] portfolio ${portfolio.id} selected first PG image attachment ${fallbackPg.id}`)
  } else if (!roles.featured && !fallbackPg) {
    console.log(`[fallback] portfolio ${portfolio.id} has no image; imageUrl will remain unchanged`)
  }
  let primaryFilled = isUsableS3(portfolio.imageUrl)
  let secondaryFilled = isUsableS3(portfolio.attachmentUrl)
  let secondaryDestinationClaimed = false
  for (const item of workItems(roles.ordered, matched)) {
    const isPrimary = item.laravel ? item.laravel.id === roles.featured?.id : item.attachment?.id === primaryPg?.id
    const itemMetadata = metadataFor(item.attachment, item.laravel?.doc_name || item.attachment?.docName || 'file')
    const isPrimaryImage = isPrimary && itemMetadata.resourceType === 'image'
    const existingDestinationUrl = isPrimaryImage
      ? portfolio.imageUrl
      : !secondaryDestinationClaimed
        ? portfolio.attachmentUrl
        : null
    if (!isPrimaryImage && existingDestinationUrl) secondaryDestinationClaimed = true
    await repairOneFile({
      dryRun,
      kind: 'portfolio',
      entityId: portfolio.id,
      title: portfolio.title,
      legacyEntityId: portfolio.legacyId,
      profileId: portfolio.profileId,
      profileLegacyId: portfolio.profile.legacyId,
      laravel: item.laravel,
      attachment: item.attachment,
      existingDestinationUrl,
      entityPatch: (url, filename, image) => {
        const patch: EntityPatch['portfolio'] = {}
        if (isPrimary && image && !primaryFilled) {
          patch.imageUrl = url
          primaryFilled = true
        } else if (!secondaryFilled) {
          patch.attachmentUrl = url
          patch.attachmentName = filename
          secondaryFilled = true
        }
        return Object.keys(patch).length ? { portfolio: patch } : undefined
      },
    })
  }
}

function classifyUnexpected(error: unknown): Status {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /prisma|database|transaction|constraint|column|relation|connect|query/i.test(message)
    ? 'DB_UPDATE_FAILED'
    : 'UPLOAD_FAILED'
}

async function processClientBatches(dryRun: boolean, profileId?: string) {
  let cursor: string | undefined
  let processed = 0
  while (true) {
    const batch = await prisma.client.findMany({
      where: { deletedAt: null, ...(profileId ? { profileId } : {}) },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { profile: { select: { id: true, slug: true, legacyId: true } } },
    })
    if (!batch.length) break
    const legacyIds = batch.map((row) => row.legacyServiceId).filter((id): id is number => id != null)
    const laravelRows = await loadLaravelRows('Service', legacyIds)
    const candidates = await loadPgAttachmentsForBatch({
      entityIds: batch.map((row) => row.id),
      legacyEntityIds: legacyIds,
      laravelAttachmentIds: laravelRows.map((row) => Number(row.id)),
    })
    const byEntity = rowsByEntity(laravelRows)
    for (const client of batch) {
      try {
        await repairClient(
          dryRun,
          client,
          candidates,
          client.legacyServiceId == null ? [] : byEntity.get(client.legacyServiceId) || []
        )
      } catch (error) {
        log({
          status: classifyUnexpected(error),
          kind: 'client',
          entityId: client.id,
          title: client.title,
          legacyEntityId: client.legacyServiceId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    processed += batch.length
    cursor = batch.at(-1)!.id
    console.log(`Client batch complete: ${processed}`)
  }
}

async function processPortfolioBatches(dryRun: boolean, profileId?: string) {
  let cursor: string | undefined
  let processed = 0
  while (true) {
    const batch = await prisma.portfolio.findMany({
      where: profileId ? { profileId } : {},
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { profile: { select: { id: true, slug: true, legacyId: true } } },
    })
    if (!batch.length) break
    const legacyIds = batch.map((row) => row.legacyId).filter((id): id is number => id != null)
    const laravelRows = await loadLaravelRows('Portfolio', legacyIds)
    const candidates = await loadPgAttachmentsForBatch({
      entityIds: batch.map((row) => row.id),
      legacyEntityIds: legacyIds,
      laravelAttachmentIds: laravelRows.map((row) => Number(row.id)),
    })
    const byEntity = rowsByEntity(laravelRows)
    for (const portfolio of batch) {
      try {
        await repairPortfolio(
          dryRun,
          portfolio,
          candidates,
          portfolio.legacyId == null ? [] : byEntity.get(portfolio.legacyId) || []
        )
      } catch (error) {
        log({
          status: classifyUnexpected(error),
          kind: 'portfolio',
          entityId: portfolio.id,
          title: portfolio.title,
          legacyEntityId: portfolio.legacyId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    processed += batch.length
    cursor = batch.at(-1)!.id
    console.log(`Portfolio batch complete: ${processed}`)
  }
}

async function printValidation(profileId?: string) {
  const clientScope = profileId ? Prisma.sql`AND "profileId" = ${profileId}` : Prisma.empty
  const portfolioScope = profileId ? Prisma.sql`AND "profileId" = ${profileId}` : Prisma.empty
  const [clients] = await prisma.$queryRaw<Array<{ total: number; with_image: number }>>`
    SELECT COUNT(*)::int AS total, COUNT(NULLIF("featuredImage", ''))::int AS with_image
    FROM "Client" WHERE 1=1 ${clientScope}
  `
  const [portfolios] = await prisma.$queryRaw<Array<{ total: number; with_image: number; with_attachment: number }>>`
    SELECT COUNT(*)::int AS total,
      COUNT(NULLIF("imageUrl", ''))::int AS with_image,
      COUNT(NULLIF("attachmentUrl", ''))::int AS with_attachment
    FROM "Portfolio" WHERE 1=1 ${portfolioScope}
  `
  const badClients = await prisma.$queryRaw<Array<{ id: string; title: string | null; featuredImage: string | null }>>`
    SELECT id, title, "featuredImage" FROM "Client"
    WHERE "featuredImage" IS NOT NULL AND "featuredImage" <> '' AND "featuredImage" NOT LIKE 'http%'
    ${clientScope}
  `
  const badPortfolios = await prisma.$queryRaw<
    Array<{ id: string; title: string | null; imageUrl: string | null; attachmentUrl: string | null }>
  >`
    SELECT id, title, "imageUrl", "attachmentUrl" FROM "Portfolio"
    WHERE (
      ("imageUrl" IS NOT NULL AND "imageUrl" <> '' AND "imageUrl" NOT LIKE 'http%')
      OR ("attachmentUrl" IS NOT NULL AND "attachmentUrl" <> '' AND "attachmentUrl" NOT LIKE 'http%')
    )
    ${portfolioScope}
  `
  console.log('Client counts', clients)
  console.log('Portfolio counts', portfolios)
  console.log('filename-only Client.featuredImage', badClients)
  console.log('filename-only Portfolio destinations', badPortfolios)
}

async function printMichaelangeloReport() {
  const profile = await prisma.profile.findFirst({
    where: { slug: MICHAELANGELO_SLUG },
    select: { id: true },
  })
  console.log(`Michaelangelo validation: slug=${MICHAELANGELO_SLUG}`)
  if (!profile) {
    console.log('Michaelangelo profile not found')
    return
  }
  const [clients, portfolios, clientSources, portfolioSources] = await Promise.all([
    prisma.client.findMany({
      where: { profileId: profile.id, legacyServiceId: { in: MICHAELANGELO_CLIENT_IDS } },
      select: { id: true, legacyServiceId: true, featuredImage: true },
    }),
    prisma.portfolio.findMany({
      where: { profileId: profile.id, legacyId: { in: MICHAELANGELO_PORTFOLIO_IDS } },
      select: { id: true, legacyId: true, imageUrl: true, attachmentUrl: true },
    }),
    loadLaravelRows('Service', MICHAELANGELO_CLIENT_IDS),
    loadLaravelRows('Portfolio', MICHAELANGELO_PORTFOLIO_IDS),
  ])
  const entities = [...clients, ...portfolios]
  const candidates = await loadPgAttachmentsForBatch({
    entityIds: entities.map((row) => row.id),
    legacyEntityIds: [...MICHAELANGELO_CLIENT_IDS, ...MICHAELANGELO_PORTFOLIO_IDS],
    laravelAttachmentIds: [...clientSources, ...portfolioSources].map((row) => Number(row.id)),
  })
  const clientByLegacy = new Map(clients.map((row) => [row.legacyServiceId, row]))
  const portfolioByLegacy = new Map(portfolios.map((row) => [row.legacyId, row]))
  const clientSourceMap = rowsByEntity(clientSources)
  const portfolioSourceMap = rowsByEntity(portfolioSources)
  for (const legacyId of MICHAELANGELO_CLIENT_IDS) {
    const entity = clientByLegacy.get(legacyId)
    const connected = entity
      ? candidates.filter((row) => typeNameMatches(row.attachableType, 'Service') && row.attachableId === entity.id)
      : []
    const sourceCount = clientSourceMap.get(legacyId)?.length || 0
    const s3AttachmentCount = connected.filter((row) => isUsableS3(row.url)).length
    console.log('Michaelangelo Client', {
      legacyServiceId: legacyId,
      destinationUrl: entity?.featuredImage || null,
      destinationIsS3: isUsableS3(entity?.featuredImage),
      connectedAttachmentCount: connected.length,
      s3AttachmentCount,
      laravelSourceCount: sourceCount,
      entityMissingDespiteSource: !entity && sourceCount > 0,
      sourceExistsButNoS3Destination: sourceCount > 0 && !isUsableS3(entity?.featuredImage),
      sourceExistsButNoS3Attachment: sourceCount > 0 && s3AttachmentCount === 0,
    })
  }
  for (const legacyId of MICHAELANGELO_PORTFOLIO_IDS) {
    const entity = portfolioByLegacy.get(legacyId)
    const connected = entity
      ? candidates.filter((row) => typeNameMatches(row.attachableType, 'Portfolio') && row.attachableId === entity.id)
      : []
    const sourceCount = portfolioSourceMap.get(legacyId)?.length || 0
    const s3AttachmentCount = connected.filter((row) => isUsableS3(row.url)).length
    const hasS3Destination = isUsableS3(entity?.imageUrl) || isUsableS3(entity?.attachmentUrl)
    console.log('Michaelangelo Portfolio', {
      legacyId,
      destinationUrl: entity?.imageUrl || entity?.attachmentUrl || null,
      destinationIsS3: hasS3Destination,
      primaryUrl: entity?.imageUrl || null,
      secondaryUrl: entity?.attachmentUrl || null,
      connectedAttachmentCount: connected.length,
      s3AttachmentCount,
      laravelSourceCount: sourceCount,
      entityMissingDespiteSource: !entity && sourceCount > 0,
      sourceExistsButNoS3Destination: sourceCount > 0 && !hasS3Destination,
      sourceExistsButNoS3Attachment: sourceCount > 0 && s3AttachmentCount === 0,
    })
    if (legacyId === 125) {
      const portfolio125Sources = portfolioSourceMap.get(125) || []
      const sourceIds = new Set(portfolio125Sources.map((row) => Number(row.id)))
      const postgresAttachments = candidates
        .filter(
          (row) => connected.some((item) => item.id === row.id) || (row.legacyId != null && sourceIds.has(row.legacyId))
        )
        .map((row) => ({
          id: row.id,
          legacyId: row.legacyId,
          attachableType: row.attachableType,
          attachableId: row.attachableId,
          url: row.url,
          publicId: row.publicId,
          isS3: isUsableS3(row.url),
        }))
      console.log('Michaelangelo Portfolio 125 all attachment records', {
        primaryUrl: entity?.imageUrl || null,
        secondaryUrl: entity?.attachmentUrl || null,
        laravelSources: portfolio125Sources.map((row) => ({
          id: row.id,
          attachmentTypeId: row.attachment_type_id,
          docName: row.doc_name,
          hasPostgresRecord: postgresAttachments.some((attachment) => attachment.legacyId === Number(row.id)),
        })),
        postgresAttachments,
      })
    }
  }
}

async function main() {
  const { dryRun, slug } = parseRepairArgs(process.argv.slice(2), process.env.DRY_RUN ?? 'true')
  console.log(`repairClientPortfolioMedia dryRun=${dryRun} slug=${slug || '(all)'} batch=${BATCH_SIZE}`)
  await assertRequiredSchema()
  const profile = slug ? await prisma.profile.findFirst({ where: { slug }, select: { id: true, slug: true } }) : null
  if (slug && !profile) throw new Error(`Profile not found for slug=${slug}`)

  await processClientBatches(dryRun, profile?.id)
  await processPortfolioBatches(dryRun, profile?.id)
  console.log('Status counts', counts)
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
