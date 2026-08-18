export type RepairKind = 'Service' | 'Portfolio'

export type LegacyMediaRow = {
  id: number
  attachmentable_id: number
  attachmentable_type: string
  attachment_type_id: number | null
  doc_name: string
  created_at: Date | string | null
}

export type MatchableAttachment = {
  id: string
  legacyId: number | null
  attachableType: string
  attachableId: string
}

export function parseRepairArgs(argv: string[], envDryRun = 'true') {
  const normalizedDryRun = envDryRun.trim().toLowerCase()
  let dryRun = normalizedDryRun !== 'false' && normalizedDryRun !== '0'
  let slug = ''
  let all = false
  for (const arg of argv) {
    if (arg === '--apply') dryRun = false
    if (arg === '--dry-run' || arg === '--dryRun') dryRun = true
    if (arg.startsWith('--slug=')) slug = arg.slice('--slug='.length).trim()
    if (arg === '--all') all = true
  }
  if (all) slug = ''
  return { dryRun, slug }
}

export function assertMutationAllowed(dryRun: boolean, operation: string): void {
  if (dryRun) throw new Error(`DRY_RUN mutation blocked: ${operation}`)
}

export function typeNameMatches(value: string, kind: RepairKind): boolean {
  return value.replace(/\\\\/g, '\\').includes(`Models\\${kind}`) || value.endsWith(kind)
}

export function isNumericAttachableId(value?: string | null): boolean {
  return Boolean(value && /^\d+$/.test(value.trim()))
}

export function keyFromS3Url(url: string): string | null {
  try {
    const key = new URL(url).pathname.replace(/^\/+/, '')
    return key || null
  } catch {
    return null
  }
}

export function existingS3Plan(
  url: string | null | undefined,
  publicId: string | null | undefined,
  isS3Url: (value: string) => boolean
): { shouldUpload: boolean; url?: string; publicId?: string } {
  const trimmed = url?.trim()
  if (!trimmed || !isS3Url(trimmed)) return { shouldUpload: true }
  const key = publicId?.trim() || keyFromS3Url(trimmed)
  return { shouldUpload: false, url: trimmed, publicId: key || undefined }
}

export function isValidDestination(value?: string | null): boolean {
  const trimmed = value?.trim() || ''
  return /^https?:\/\//i.test(trimmed)
}

function legacyOrder(a: LegacyMediaRow, b: LegacyMediaRow): number {
  const byId = Number(a.id) - Number(b.id)
  if (byId) return byId
  const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
  const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
  return aTime - bTime
}

export function isImageFilename(filename: string): boolean {
  return /\.(?:jpe?g|png|webp|gif|svg|bmp)$/i.test(filename.split(/[?#]/, 1)[0] || '')
}

export function pickClientPrimary(rows: LegacyMediaRow[]): LegacyMediaRow | null {
  const ordered = [...rows].sort(legacyOrder)
  return (
    ordered.find((row) => row.attachment_type_id === 7) ||
    ordered.find((row) => row.attachment_type_id === 6) ||
    ordered.find((row) => isImageFilename(row.doc_name)) ||
    null
  )
}

export function pickPortfolioRoles(rows: LegacyMediaRow[]) {
  const ordered = [...rows].sort(legacyOrder)
  const explicit = ordered.find((row) => row.attachment_type_id === 7)
  const featured = explicit || ordered.find((row) => isImageFilename(row.doc_name)) || null
  return {
    featured,
    others: ordered.filter((row) => row.id !== featured?.id),
    featuredFallback: !explicit && Boolean(featured),
    ordered,
  }
}

/**
 * A Laravel attachment legacyId is authoritative even when the current PG type/id is wrong.
 * Numeric attachableId matching is only against the entity's legacy id, never attachment legacyId.
 */
export function matchEntityAttachments<T extends MatchableAttachment>(opts: {
  attachments: T[]
  kind: RepairKind
  legacyEntityId: number | null
  entityId: string
  laravelRows: LegacyMediaRow[]
}): T[] {
  const authoritativeLegacyIds = new Set(
    opts.laravelRows
      .filter(
        (row) =>
          typeNameMatches(row.attachmentable_type, opts.kind) &&
          opts.legacyEntityId != null &&
          Number(row.attachmentable_id) === opts.legacyEntityId
      )
      .map((row) => Number(row.id))
  )
  const unique = new Map<string, T>()
  for (const attachment of opts.attachments) {
    const legacyProvesRelationship =
      attachment.legacyId != null && authoritativeLegacyIds.has(Number(attachment.legacyId))
    const currentTypeMatches = typeNameMatches(attachment.attachableType, opts.kind)
    const currentIdMatches =
      attachment.attachableId === opts.entityId ||
      (opts.legacyEntityId != null &&
        isNumericAttachableId(attachment.attachableId) &&
        Number(attachment.attachableId) === opts.legacyEntityId)
    if (legacyProvesRelationship || (currentTypeMatches && currentIdMatches)) {
      unique.set(attachment.id, attachment)
    }
  }
  return [...unique.values()]
}
