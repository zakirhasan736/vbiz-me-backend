import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../generated/prisma/client'
import config from '../configs/config'

const connectionString = config.DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required for Prisma Client')
}

/** Per-process pool size. Use PgBouncer in production when running multiple Node instances. */
const poolMax = Math.min(Math.max(Number(process.env.DATABASE_POOL_MAX || 20), 4), 50)

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: poolMax }),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export { prisma }
