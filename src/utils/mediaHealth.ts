import config from '../configs/config'
import logger from './logger'
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
        if (result.status === 'alive') report.alive += 1
        else if (result.status === 'restored') {
          report.restored.push(key)
          logger.warn(`media heal: restored missing S3 key from version ${result.versionId}`, { key })
        } else {
          report.missing.push({ key, reason: result.reason })
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
