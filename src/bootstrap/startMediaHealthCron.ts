import cron from 'node-cron'
import logger from '../utils/logger'
import { runMediaHealthSweep } from '../utils/mediaHealth'
import { DEFAULT_CAMPAIGN_TIMEZONE } from '../utils/scheduleTimezone'

let started = false
let running = false

/**
 * Nightly media health sweep (HEAD every referenced S3 file, recover from versions,
 * flag what is still missing in MediaAsset). Disable with MEDIA_HEALTH_CRON_ENABLED=false.
 */
export function startMediaHealthCron() {
  if (started) return
  started = true
  if ((process.env.MEDIA_HEALTH_CRON_ENABLED || 'true').toLowerCase() === 'false') {
    logger.info('Media health cron disabled (MEDIA_HEALTH_CRON_ENABLED=false)')
    return
  }
  const expr = process.env.MEDIA_HEALTH_CRON_EXPR || '40 3 * * *'
  if (!cron.validate(expr)) {
    logger.warn(`Invalid MEDIA_HEALTH_CRON_EXPR="${expr}" — media health cron not started`)
    return
  }
  const timezone = process.env.MEDIA_HEALTH_CRON_TZ || DEFAULT_CAMPAIGN_TIMEZONE
  cron.schedule(
    expr,
    () => {
      if (running) return
      running = true
      void runMediaHealthSweep()
        .catch((error) => logger.error('Media health cron failed', error))
        .finally(() => {
          running = false
        })
    },
    { timezone }
  )
  logger.info(`Media health cron scheduled expr="${expr}" tz="${timezone}"`)
}
