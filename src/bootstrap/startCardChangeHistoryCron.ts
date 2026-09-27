import cron from 'node-cron'
import cardChangeHistoryService from '../services/cardChangeHistory.service'
import logger from '../utils/logger'

let started = false

export function startCardChangeHistoryCron() {
  if (started) return
  started = true

  cron.schedule('15 * * * *', () => {
    void cardChangeHistoryService.expireSnapshots().catch((error) => {
      logger.error('Card change history expire cron failed', error)
    })
  })

  logger.info('Card change history expire cron scheduled hourly')
}
