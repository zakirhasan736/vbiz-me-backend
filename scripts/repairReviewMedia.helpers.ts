export const SERVICE_ATTACHABLE_TYPE = 'App\\Models\\Service'

export type RepairArgs = { dryRun: boolean; slug: string }

export type ReviewAttachment = {
  id: string
  legacyId: number | null
  attachableType: string
  attachableId: string
  docName: string | null
  url: string | null
  publicId: string | null
  resourceType: string | null
  mimeType: string | null
  extension: string | null
  bytes: number | null
  createdAt: Date
  attachmentType?: { legacyId: number | null } | null
}

export type LaravelAttachment = {
  id: number
  attachmentable_id: number
  attachmentable_type: string
  attachment_type_id: number | null
  doc_name: string
  created_at: Date | string | null
}

export type ImageCandidate = {
  key: string
  typeId: number | null
  filename: string
  legacyAttachmentId: number | null
  createdAt: Date | string | null
  pg: ReviewAttachment | null
  laravel: LaravelAttachment | null
}

const REVIEW_URL_KEYS = [
  'review_url',
  'google_review_url',
  'facebook_url',
  'yelp_url',
  'external_url',
  'source_url',
  'button_url',
  'url',
  'link',
] as const

const MEDIA_EXTENSIONS = /\.(?:jpe?g|png|webp|gif|svg|bmp|avif|tiff?)(?:[?#].*)?$/i
const PAGE_REJECT_EXTENSIONS =
  /\.(?:jpe?g|png|webp|gif|svg|bmp|avif|tiff?|mp4|mov|webm|m4v|mp3|wav|ogg|pdf|docx?|xlsx?|zip)(?:[?#].*)?$/i

export function parseRepairArgs(argv: string[], envDryRun = 'true'): RepairArgs {
  void envDryRun
  // Applying always requires an explicit CLI flag. Environment configuration may
  // force dry-run, but can never silently authorize writes.
  let dryRun = true
  let slug = ''
  let all = false
  for (const arg of argv) {
    if (arg === '--apply') dryRun = false
    else if (arg === '--dry-run' || arg === '--dryRun') dryRun = true
    else if (arg.startsWith('--slug=')) slug = arg.slice(7).trim()
    else if (arg === '--all') all = true
  }
  if (all) slug = ''
  return { dryRun, slug }
}

export function assertMutationAllowed(dryRun: boolean, operation: string): void {
  if (dryRun) throw new Error(`DRY_RUN mutation blocked: ${operation}`)
}

export function normalizeAttachableType(value: string): string {
  return value.trim().replace(/\\\\/g, '\\').replace(/^\\+/, '')
}

export function isExactServiceType(value: string): boolean {
  return normalizeAttachableType(value) === SERVICE_ATTACHABLE_TYPE
}

export function isNumericId(value?: string | null): boolean {
  return Boolean(value && /^\d+$/.test(value.trim()))
}

export function isExactCurrentAttachment(attachment: ReviewAttachment, legacyServiceId: number): boolean {
  return (
    isExactServiceType(attachment.attachableType) &&
    isNumericId(attachment.attachableId) &&
    Number(attachment.attachableId) === legacyServiceId
  )
}

export function isImageAttachment(value: {
  docName?: string | null
  url?: string | null
  resourceType?: string | null
  mimeType?: string | null
  extension?: string | null
}): boolean {
  if (value.resourceType?.toLowerCase() === 'image' || value.mimeType?.toLowerCase().startsWith('image/')) return true
  const extension = value.extension?.replace(/^\./, '') || ''
  return (
    MEDIA_EXTENSIONS.test(value.docName || '') ||
    MEDIA_EXTENSIONS.test(value.url || '') ||
    MEDIA_EXTENSIONS.test(`x.${extension}`)
  )
}

function orderCandidate(a: ImageCandidate, b: ImageCandidate): number {
  const aType = a.typeId === 7 ? 0 : a.typeId === 6 ? 1 : 2
  const bType = b.typeId === 7 ? 0 : b.typeId === 6 ? 1 : 2
  if (aType !== bType) return aType - bType
  const byLegacy = (a.legacyAttachmentId ?? Number.MAX_SAFE_INTEGER) - (b.legacyAttachmentId ?? Number.MAX_SAFE_INTEGER)
  if (byLegacy) return byLegacy
  const byCreated = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
  return byCreated || a.key.localeCompare(b.key)
}

export function selectPrimaryImage(candidates: ImageCandidate[]): ImageCandidate | null {
  return (
    [...candidates]
      .filter(
        (candidate) => isImageAttachment(candidate.pg || {}) || isImageAttachment({ docName: candidate.filename })
      )
      .sort(orderCandidate)[0] || null
  )
}

export function authoritativeCandidates(
  attachments: ReviewAttachment[],
  laravelRows: LaravelAttachment[],
  legacyServiceId: number
): ImageCandidate[] {
  const exactLaravel = laravelRows.filter(
    (row) =>
      isExactServiceType(row.attachmentable_type) &&
      Number(row.attachmentable_id) === legacyServiceId &&
      isImageAttachment({ docName: row.doc_name })
  )
  const pgByLegacy = new Map(
    attachments.filter((row) => row.legacyId != null).map((row) => [Number(row.legacyId), row] as const)
  )
  const candidates = new Map<string, ImageCandidate>()
  for (const row of exactLaravel) {
    const pg = pgByLegacy.get(Number(row.id)) || null
    candidates.set(`laravel:${row.id}`, {
      key: `laravel:${row.id}`,
      typeId: row.attachment_type_id,
      filename: row.doc_name,
      legacyAttachmentId: Number(row.id),
      createdAt: row.created_at,
      pg,
      laravel: row,
    })
  }
  for (const row of attachments) {
    if (!isExactCurrentAttachment(row, legacyServiceId) || !isImageAttachment(row)) continue
    if (row.legacyId != null && candidates.has(`laravel:${row.legacyId}`)) continue
    candidates.set(`pg:${row.id}`, {
      key: `pg:${row.id}`,
      typeId: row.attachmentType?.legacyId ?? null,
      filename: row.docName || row.url || 'image',
      legacyAttachmentId: row.legacyId,
      createdAt: row.createdAt,
      pg: row,
      laravel: null,
    })
  }
  return [...candidates.values()]
}

export function keyFromS3Url(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')) || null
  } catch {
    return null
  }
}

export function existingS3Plan(
  url: string | null | undefined,
  publicId: string | null | undefined,
  isS3: (url: string) => boolean
) {
  const value = url?.trim()
  if (!value || !isS3(value)) return { shouldUpload: true as const }
  return {
    shouldUpload: false as const,
    url: value,
    publicId: publicId?.trim() || keyFromS3Url(value) || undefined,
  }
}

export function isAbsoluteDestination(value?: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function clearUnprovenImage(value?: string | null): null | undefined {
  return value?.trim() ? null : undefined
}

export function isLegitimatePageUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return false
    if (PAGE_REJECT_EXTENSIONS.test(url.pathname)) return false
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (/^google\.[a-z.]+$/.test(host) && (url.pathname === '/' || /^\/search\/?$/.test(url.pathname))) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function parseNested(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || !['{', '['].includes(trimmed[0] || '')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function collectByKey(root: unknown, wanted: string, seen: Set<unknown>): string[] {
  const value = parseNested(root)
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  const found: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) found.push(...collectByKey(item, wanted, seen))
    return found
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase()
      .replace(/^_+|_+$/g, '')
    if (normalizedKey === wanted && typeof child === 'string' && isLegitimatePageUrl(child)) {
      found.push(child.trim())
    }
    found.push(...collectByKey(child, wanted, seen))
  }
  return found
}

export function extractReviewUrl(serviceRow: Record<string, unknown>): string | null {
  for (const key of REVIEW_URL_KEYS) {
    const found = collectByKey(serviceRow, key, new Set())
    if (found.length) return found[0]
  }
  return null
}
