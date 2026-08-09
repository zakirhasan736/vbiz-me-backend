import app from './app'
import seedAdmin from './bootstrap/seedAdmin'
import seedCardTemplates from './bootstrap/seedCardTemplates'
import seedSupportTickets from './bootstrap/seedSupportTickets'
import config from './configs/config'
import logger from './utils/logger'
import { prisma } from './utils/prisma'

const main = async () => {
  try {
    await prisma.$connect()
    await seedAdmin()
    await seedCardTemplates()
    await seedSupportTickets()

    app.listen(config.PORT, () => {
      logger.info(`🔗 Database connected && server running on port ${config.PORT}`)
    })
  } catch (err) {
    logger.error('❌ Startup failed:', err)
    await prisma.$disconnect()
    process.exit(1)
  }
}

main()
