import cron from 'node-cron'
import config from '../configs/config'
import birthdayWishService from '../services/birthdayWish.service'
import logger from '../utils/logger'

let started = false

/** Schedule daily birthday wishes (owner email + inbox). Safe to call once at boot. */
export function startBirthdayWishCron() {
  if (started) return
  started = true

  if (!config.BIRTHDAY_CRON.ENABLED) {
    logger.info('Birthday wish cron disabled (BIRTHDAY_CRON_ENABLED=false)')
    return
  }

  const expr = config.BIRTHDAY_CRON.EXPR
  const timeZone = config.BIRTHDAY_CRON.TZ

  if (!cron.validate(expr)) {
    logger.error(`Invalid BIRTHDAY_CRON_EXPR: ${expr}`)
    return
  }

  cron.schedule(
    expr,
    () => {
      void birthdayWishService.runDailyBirthdayWishes({ timeZone }).catch((error) => {
        logger.error('Birthday wish cron run failed', error)
      })
    },
    { timezone: timeZone }
  )

  logger.info(`Birthday wish cron scheduled expr="${expr}" tz="${timeZone}"`)
}
