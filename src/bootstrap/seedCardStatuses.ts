import { seedCardStatuses as upsertCardStatuses } from '../utils/cardStatus'
import logger from '../utils/logger'

const seedCardStatuses = async (): Promise<void> => {
  await upsertCardStatuses()
  logger.info('Card statuses ready (active, inactive, paused, suspended, draft)')
}

export default seedCardStatuses
