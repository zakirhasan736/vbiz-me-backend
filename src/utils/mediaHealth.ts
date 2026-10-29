import config from '../configs/config'
import logger from './logger'
import { setMediaStatus } from './mediaAsset'
import { extractMediaKeys } from './mediaKeys'
import s3Utils from './s3'

export type MediaHealReport = {
  checked: number
  alive: number
  restored: string[]
  missing: Array<{ key: string; reason: string }>
}

const emptyReport = (): MediaHealReport => ({ checked: 0, alive: 0, restored: [], missing: [] })

/**
 * Make sure every bucket key is readable. Missing keys are brought back from
 * S3 versioning when a stored version exists. Never throws — media healing is
 * best-effort and must not block a restore or a save.
 */
export async function healMediaKeys(keys: Iterable<string>, concurrency = 6): Promise<MediaHealReport> {
  const report = emptyReport()
  const queue = [...new Set([...keys].map((k) => k.trim()).filter(Boolean))]
  report.checked = queue.length
  if (!queue.length) return report

  try {
    s3Utils.ensureConfigured()
  } catch {
    return report
  }

  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      try {
        const result = await s3Utils.restoreFromVersions(key)
        if (result.status === 'alive') {
          report.alive += 1
          await setMediaStatus(key, 'ok')
        } else if (result.status === 'restored') {
          report.restored.push(key)
          logger.warn(`media heal: restored missing S3 key from version ${result.versionId}`, { key })
        } else {
          report.missing.push({ key, reason: result.reason })
          await setMediaStatus(key, 'missing', { reason: result.reason })
        }
      } catch (error) {
        const reason = (error as { name?: string; message?: string })?.name || 'error'
        report.missing.push({ key, reason })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

  if (report.missing.length) {
    logger.error('media heal: some referenced S3 keys are missing and could not be recovered', {
      missing: report.missing,
    })
  }
  return report
}

/** Heal every bucket URL found anywhere inside `value` (snapshot JSON, rows, HTML …). */
export async function healMediaInValue(value: unknown): Promise<MediaHealReport> {
  const keys = extractMediaKeys(value, config.S3.PUBLIC_BASE_URL || '')
  return healMediaKeys(keys)
}

/**
 * Nightly site-wide check: every file referenced anywhere in the DB is HEAD-checked,
 * missing ones are recovered from S3 versions, and MediaAsset.status is updated so
 * broken media shows up in admin before a client notices.
 */
export async function runMediaHealthSweep(): Promise<MediaHealReport> {
  const { collectAllReferencedMediaKeys } = await import('./cardMediaScan')
  const keys = await collectAllReferencedMediaKeys()
  const report = await healMediaKeys(keys, 8)
  logger.info('media health sweep finished', {
    checked: report.checked,
    ok: report.alive,
    recovered: report.restored.length,
    missing: report.missing.length,
  })
  return report
}

export type CardMediaItem = {
  url: string
  key: string
  /** Tab / screen, e.g. services, portfolio, gallery, profile, intro-video. */
  area: string
  /** Item on that tab, e.g. the service title. */
  label: string | null
  status: 'ok' | 'missing' | 'pending' | 'recovered' | 'unknown'
  reason?: string | null
  /** Card / tab the file was originally uploaded for (from MediaAsset). */
  uploadedFor?: { profileId: string | null; area: string | null } | null
}

const HISTORY_TABLES = new Set(['CardChangeHistory', 'CardDailyBackup'])
const GENERIC_AREAS = new Set(['attachments', 'settings'])

/**
 * Every image/video on one card, grouped by tab and item, with its S3 status.
 * `heal: true` HEAD-checks each file now and recovers missing ones from versions;
 * otherwise statuses come from the last check stored in MediaAsset.
 */
export async function cardMediaReport(profileId: string, options?: { heal?: boolean }): Promise<CardMediaItem[]> {
  const { collectCardMediaRefs } = await import('./cardMediaScan')
  const { prisma } = await import('./prisma')
  const refs = await collectCardMediaRefs(profileId, { skipTables: HISTORY_TABLES })

  // One row per (key, area, label); prefer specific tabs over the generic Attachment row.
  const byKey = new Map<string, typeof refs>()
  for (const ref of refs) {
    if (!byKey.has(ref.key)) byKey.set(ref.key, [])
    byKey.get(ref.key)!.push(ref)
  }

  let healed: MediaHealReport | null = null
  if (options?.heal) healed = await healMediaKeys(byKey.keys())

  const assets = await prisma.mediaAsset.findMany({
    where: { key: { in: [...byKey.keys()] } },
    select: { key: true, status: true, missingReason: true, profileId: true, area: true },
  })
  const assetByKey = new Map(assets.map((a) => [a.key, a]))
  const restored = new Set(healed?.restored || [])
  const missing = new Map((healed?.missing || []).map((m) => [m.key, m.reason]))

  const items: CardMediaItem[] = []
  for (const [key, keyRefs] of byKey) {
    const specific = keyRefs.filter((r) => !GENERIC_AREAS.has(r.area))
    const shown = specific.length ? specific : keyRefs.slice(0, 1)
    const asset = assetByKey.get(key)
    let status: CardMediaItem['status'] = (asset?.status as CardMediaItem['status']) || 'unknown'
    let reason = asset?.missingReason || null
    if (healed) {
      if (restored.has(key)) status = 'recovered'
      else if (missing.has(key)) {
        status = 'missing'
        reason = missing.get(key) || reason
      } else status = 'ok'
    }
    const seen = new Set<string>()
    for (const ref of shown) {
      const dedupe = `${ref.area}|${ref.label || ''}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      items.push({
        url: s3Utils.publicUrlForKey(key),
        key,
        area: ref.area,
        label: ref.label,
        status,
        reason: status === 'missing' ? reason : null,
        uploadedFor: asset ? { profileId: asset.profileId, area: asset.area } : null,
      })
    }
  }
  const rank = { missing: 0, unknown: 1, pending: 2, recovered: 3, ok: 4 }
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.area.localeCompare(b.area))
}
