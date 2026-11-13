import path from 'path'
import { collectCardMediaRefs, rewriteCardMediaKeys } from './cardMediaScan'
import logger from './logger'
import { mediaFolderFor } from './mediaAsset'
import s3Utils from './s3'

export type DuplicateMediaCopyReport = {
  found: number
  copied: number
  failed: Array<{ key: string; reason: string }>
}

/** `vbizme/1793285518140-ML1.jpg` → folder `vbizme`, filename `ML1.jpg`. */
export function splitMediaKey(key: string): { folder: string; filename: string } {
  const clean = key.replace(/^\/+/, '')
  const folder = path.posix.dirname(clean)
  const base = path.posix.basename(clean).replace(/^\d{10,}-/, '')
  return { folder: folder === '.' ? '' : folder, filename: base || 'file' }
}

/**
 * Copy-on-duplicate for EVERY image / video on a freshly duplicated card — profile
 * media, settings, every tab (services, gallery, blogs, about, custom tabs, posts …)
 * and rich-text HTML — then point the new card's rows at its own copies.
 *
 * Runs after the DB clone (and after corporate fan-out) so it sees exactly what the
 * new card ended up with. Server-side S3 copy, no download. A key that fails to copy
 * keeps the shared URL (still safe: the API never deletes media).
 */
export async function copyAllCardMediaToOwnKeys(
  targetProfileId: string,
  concurrency = 5
): Promise<DuplicateMediaCopyReport> {
  const report: DuplicateMediaCopyReport = { found: 0, copied: 0, failed: [] }
  try {
    s3Utils.ensureConfigured()
  } catch {
    return report
  }

  // Area per key from where it is used on the card (a Service row beats the
  // generic Attachment row that points at the same file).
  const areaByKey = new Map<string, { area: string; label: string | null }>()
  for (const ref of await collectCardMediaRefs(targetProfileId)) {
    const current = areaByKey.get(ref.key)
    const generic = (a?: string) => !a || a === 'attachments' || a === 'settings'
    if (!current || (generic(current.area) && !generic(ref.area))) {
      areaByKey.set(ref.key, { area: ref.area, label: ref.label })
    }
  }
  const keys = [...areaByKey.keys()]
  report.found = keys.length
  if (!keys.length) return report

  const keyMap = new Map<string, string>()
  const queue = [...keys]
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      try {
        if ((await s3Utils.checkObject(key)) === 'missing') {
          // Source already broken — try to bring it back before copying.
          const healed = await s3Utils.restoreFromVersions(key)
          if (healed.status === 'unrecoverable') {
            report.failed.push({ key, reason: healed.reason })
            continue
          }
        }
        const { filename } = splitMediaKey(key)
        const where = areaByKey.get(key)
        const copied = await s3Utils.copyObject(key, {
          folder: mediaFolderFor({ profileId: targetProfileId, area: where?.area }),
          filename,
          identity: { profileId: targetProfileId, area: where?.area, itemLabel: where?.label, source: 'duplicate' },
        })
        keyMap.set(key, copied.publicId)
        report.copied += 1
      } catch (error) {
        report.failed.push({ key, reason: (error as { name?: string })?.name || 'copy failed' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

  await rewriteCardMediaKeys(targetProfileId, keyMap)

  if (report.failed.length) {
    logger.error('duplicate media copy: some files keep the shared source URL', {
      targetProfileId,
      failed: report.failed,
    })
  }
  return report
}
