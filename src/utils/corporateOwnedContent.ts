import AppError from '../error/AppError'
import { prisma } from './prisma'

/** Setting that lists owner-synced row ids on a member card (per Prisma model key). */
export const CORPORATE_OWNED_IDS_SETTING_KEY = 'corporate_owned_ids_json'

export type CorporateOwnedIdsMap = Record<string, string[]>

const CLIENT_DRAFT_ID_RE = /^(pf_|sk_|post_|faq_|svc_|sec_|rev_|edu_|exp_|cert_|custom_item_)/

/** True for editor temp ids that are not real database row ids. */
export function isClientDraftCollectionId(id: unknown): boolean {
  if (typeof id !== 'string' || !id.trim()) return true
  return CLIENT_DRAFT_ID_RE.test(id.trim())
}

export function parseCorporateOwnedIdsMap(raw: string | null | undefined): CorporateOwnedIdsMap {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CorporateOwnedIdsMap = {}
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      if (ids.length) out[model] = [...new Set(ids)]
    }
    return out
  } catch {
    return {}
  }
}

export async function readCorporateOwnedIdsMap(profileId: string): Promise<CorporateOwnedIdsMap> {
  const row = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: CORPORATE_OWNED_IDS_SETTING_KEY } },
    select: { value: true },
  })
  return parseCorporateOwnedIdsMap(row?.value)
}

export async function writeCorporateOwnedIdsMap(profileId: string, map: CorporateOwnedIdsMap): Promise<void> {
  const cleaned: CorporateOwnedIdsMap = {}
  for (const [model, ids] of Object.entries(map)) {
    const next = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
    if (next.length) cleaned[model] = next
  }
  const value = JSON.stringify(cleaned)
  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key: CORPORATE_OWNED_IDS_SETTING_KEY } },
    create: { profileId, key: CORPORATE_OWNED_IDS_SETTING_KEY, value },
    update: { value },
  })
}

export async function getCorporateOwnedIds(profileId: string, model: string): Promise<Set<string>> {
  const map = await readCorporateOwnedIdsMap(profileId)
  return new Set(map[model] || [])
}

export async function setCorporateOwnedIds(profileId: string, model: string, ids: string[]): Promise<void> {
  const map = await readCorporateOwnedIdsMap(profileId)
  const next = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
  if (next.length) map[model] = next
  else delete map[model]
  await writeCorporateOwnedIdsMap(profileId, map)
}

/**
 * When a linked member card has owner-synced rows but no ownership map yet
 * (pre-feature data), treat current live rows as owner-owned so members can
 * still append their own editable items without wiping those rows.
 */
export async function seedCorporateOwnedIdsIfEmpty(
  profileId: string,
  model: string,
  liveIds: string[]
): Promise<Set<string>> {
  const existing = await getCorporateOwnedIds(profileId, model)
  if (existing.size > 0) return existing
  const ids = [
    ...new Set(liveIds.filter((id) => typeof id === 'string' && id.trim() && !isClientDraftCollectionId(id))),
  ]
  if (!ids.length) return existing
  await setCorporateOwnedIds(profileId, model, ids)
  return new Set(ids)
}

export async function isCorporateOwnedRow(profileId: string, model: string, rowId: string): Promise<boolean> {
  if (!rowId.trim()) return false
  const owned = await getCorporateOwnedIds(profileId, model)
  return owned.has(rowId)
}

/**
 * Team members may add local content, but cannot edit/delete rows that were
 * synced from the corporate team owner card.
 */
export async function assertNotCorporateOwnedRow(args: {
  profileId: string
  model: string
  rowId: string
  isOwnerCard: boolean
}): Promise<void> {
  if (args.isOwnerCard) return
  if (!(await isCorporateOwnedRow(args.profileId, args.model, args.rowId))) return
  throw new AppError(
    403,
    'This item was added by the corporate team owner and cannot be edited or removed on a team member card.'
  )
}

/** Stable-enough fingerprint so member replace payloads can skip owner-synced rows without sending ids. */
export function corporateContentFingerprint(row: Record<string, unknown>): string {
  const parts = [
    row.title,
    row.description,
    row.text,
    row.author,
    row.question,
    row.answer,
    row.name,
    row.url,
    row.reviewUrl,
    row.imageUrl,
    row.featuredImage,
    row.company,
    row.jobTitle,
  ]
    .map((value) => (value == null ? '' : String(value).trim().toLowerCase()))
    .filter(Boolean)
  return parts.join('|')
}
