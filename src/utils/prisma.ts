import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../generated/prisma/client'
import config from '../configs/config'

const connectionString = config.DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required for Prisma Client')
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 20 }),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export { prisma }
