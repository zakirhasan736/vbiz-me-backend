import cron from 'node-cron'
import config from '../configs/config'
import crmReminderService from '../services/crmReminder.service'
import logger from '../utils/logger'

let started = false

export function startCrmReminderCron() {
  if (started) return
  started = true

  if (!config.CRM_REMINDER_CRON.ENABLED) {
    logger.info('CRM reminder cron disabled (CRM_REMINDER_CRON_ENABLED=false)')
    return
  }

  const expr = config.CRM_REMINDER_CRON.EXPR
  const timeZone = config.CRM_REMINDER_CRON.TZ

  if (!cron.validate(expr)) {
    logger.error(`Invalid CRM_REMINDER_CRON_EXPR: ${expr}`)
    return
  }

  cron.schedule(
    expr,
    () => {
      void crmReminderService.runCrmReminders().catch((error) => {
        logger.error('CRM reminder cron run failed', error)
      })
    },
    { timezone: timeZone }
  )

  logger.info(`CRM reminder cron scheduled expr="${expr}" tz="${timeZone}"`)
}
