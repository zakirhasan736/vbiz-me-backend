import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../generated/prisma/client'
import config from '../configs/config'

const connectionString = config.DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required for Prisma Client')
}

const adapter = new PrismaPg({ connectionString })
const prisma = new PrismaClient({
  adapter,
})

export { prisma }
