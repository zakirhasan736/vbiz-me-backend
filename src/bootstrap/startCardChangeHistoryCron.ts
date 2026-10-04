import cron from 'node-cron'
import cardChangeHistoryService from '../services/cardChangeHistory.service'
import { backupAllCards } from '../services/cardDailyBackup.service'
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

  // Once a day, snapshot every card and drop anything older than the newest 7 days.
  cron.schedule('10 2 * * *', () => {
    void backupAllCards().catch((error) => {
      logger.error('Card daily backup cron failed', error)
    })
  })

  logger.info('Card change history expire cron scheduled hourly; daily card backup keeps 7 days')
}
