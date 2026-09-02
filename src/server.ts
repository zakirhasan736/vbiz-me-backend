import { createServer } from 'http'
import app from './app'
import seedCardStatuses from './bootstrap/seedCardStatuses'
import seedCardTemplates from './bootstrap/seedCardTemplates'
import seedLandingDemoCards from './bootstrap/seedLandingDemoCards'
import seedPackages from './bootstrap/seedPackages'
import { startBillingTrialCron } from './bootstrap/startBillingTrialCron'
import { startBirthdayWishCron } from './bootstrap/startBirthdayWishCron'
import config from './configs/config'
import logger from './utils/logger'
import { prisma } from './utils/prisma'
import { attachSocket } from './utils/socket'

const main = async () => {
  try {
    await prisma.$connect()
    // Admin/owner accounts come from Laravel import (yarn migrate:laravel), not env seed.
    // Starter packages must exist before corporate register can attach subscriptions.
    await seedPackages()
    await seedCardStatuses()
    await seedCardTemplates()
    await seedLandingDemoCards()

    const httpServer = createServer(app)
    attachSocket(httpServer)
    startBirthdayWishCron()
    startBillingTrialCron()

    httpServer.listen(config.PORT, () => {
      logger.info(`🔗 Database connected && server running on port ${config.PORT}`)
    })
  } catch (err) {
    logger.error('❌ Startup failed:', err)
    await prisma.$disconnect()
    process.exit(1)
  }
}

main()
