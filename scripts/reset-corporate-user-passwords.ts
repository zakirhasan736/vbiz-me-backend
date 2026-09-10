/**
 * Reset login passwords for Corporate Card Owner accounts (role: corporate-owner).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/reset-corporate-user-passwords.ts --dry-run --password 'YourPassword'
 *   npx tsx --env-file=.env scripts/reset-corporate-user-passwords.ts --password 'YourPassword'
 */
import { UserRole } from '@prisma/client'
import authUtils from '../src/utils/auth.utils'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

const SPECIAL_CHAR_REGEX = /[!@#$%^&*(),.?":{}|<>_\-+=[\]\\/]/

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function assertStrongPassword(password: string) {
  if (password.length < 8) throw new Error('Password must be at least 8 characters')
  if (!/[A-Z]/.test(password)) throw new Error('Password must contain at least one uppercase letter')
  if (!/[0-9]/.test(password)) throw new Error('Password must contain at least one number')
  if (!SPECIAL_CHAR_REGEX.test(password)) throw new Error('Password must contain at least one special character')
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const password = readArg('--password')?.trim()
  if (!password) throw new Error('Missing --password "<value>"')
  assertStrongPassword(password)

  const users = await prisma.user.findMany({
    where: { role: UserRole.CORPORATE_OWNER },
    select: {
      id: true,
      email: true,
      name: true,
      companyName: true,
      subscriptions: {
        where: { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { package: { select: { name: true, ownerMode: true } } },
      },
    },
    orderBy: { email: 'asc' },
  })

  logger.info(`${dryRun ? 'Dry run:' : 'Resetting'} ${users.length} corporate owner password(s)`)

  if (users.length === 0) {
    logger.info('No corporate owners found.')
    return
  }

  const hashed = dryRun ? null : await authUtils.hashPassword(password)
  let updated = 0

  for (const user of users) {
    const packageName = user.subscriptions[0]?.package?.name || 'no package'
    if (dryRun) {
      logger.info(`[dry-run] ${user.email} (${user.name || user.companyName || 'unnamed'}) · ${packageName}`)
      continue
    }

    if (password.trim().toLowerCase() === user.email.trim().toLowerCase()) {
      logger.warn(`Skip ${user.email}: password cannot equal email`)
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed!,
        passwordChangedAt: new Date(),
      },
    })
    updated += 1
    logger.info(`Updated ${user.email} (${user.name || user.companyName || 'unnamed'}) · ${packageName}`)
  }

  logger.info(
    dryRun
      ? `Dry run complete for ${users.length} corporate owner(s).`
      : `Updated ${updated} corporate owner password(s).`
  )
}

main()
  .catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
