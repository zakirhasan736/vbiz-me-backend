/**
 * Compare account (User.email) vs owned card (Profile.email) for single owners.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/check-user-card-emails.ts
 *   npx tsx --env-file=.env scripts/check-user-card-emails.ts --all-owners
 */
import { UserRole } from '@prisma/client'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

const allOwners = process.argv.includes('--all-owners')

function norm(email: string | null | undefined): string {
  return String(email || '')
    .trim()
    .toLowerCase()
}

async function main() {
  const users = await prisma.user.findMany({
    where: {
      role: allOwners ? { in: [UserRole.VCARD_OWNER, UserRole.CORPORATE_OWNER] } : UserRole.VCARD_OWNER,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      profiles: {
        select: {
          id: true,
          slug: true,
          name: true,
          email: true,
          isDraft: true,
          isPublic: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { email: 'asc' },
  })

  let matchedCards = 0
  let mismatchedCards = 0
  let usersWithNoCards = 0
  let usersAllMatch = 0
  let usersWithMismatch = 0
  const mismatchRows: Array<{
    userEmail: string
    userName: string | null
    role: string
    cardSlug: string | null
    cardName: string
    cardEmail: string
  }> = []

  for (const user of users) {
    const userEmail = norm(user.email)
    if (user.profiles.length === 0) {
      usersWithNoCards += 1
      continue
    }

    let userHasMismatch = false
    for (const card of user.profiles) {
      const cardEmail = norm(card.email)
      if (cardEmail && cardEmail === userEmail) {
        matchedCards += 1
      } else {
        mismatchedCards += 1
        userHasMismatch = true
        mismatchRows.push({
          userEmail: user.email,
          userName: user.name,
          role: user.role,
          cardSlug: card.slug,
          cardName: card.name,
          cardEmail: card.email || '(empty)',
        })
      }
    }
    if (userHasMismatch) usersWithMismatch += 1
    else usersAllMatch += 1
  }

  logger.info('--- User email vs owned card email ---')
  logger.info(`Users checked: ${users.length} (${allOwners ? 'single + corporate' : 'single only'})`)
  logger.info(`Users with no cards: ${usersWithNoCards}`)
  logger.info(`Users where all cards match account email: ${usersAllMatch}`)
  logger.info(`Users with at least one mismatch: ${usersWithMismatch}`)
  logger.info(`Cards matching user email: ${matchedCards}`)
  logger.info(`Cards NOT matching user email: ${mismatchedCards}`)

  if (mismatchRows.length) {
    logger.info('--- Mismatches ---')
    for (const row of mismatchRows) {
      logger.info(
        `${row.userEmail} | user="${row.userName || ''}" | card="${row.cardName}" @/${row.cardSlug || ''} | cardEmail=${row.cardEmail}`
      )
    }
  } else {
    logger.info('No mismatches found.')
  }

  const report = {
    scope: allOwners ? 'single+corporate' : 'single',
    usersChecked: users.length,
    usersWithNoCards,
    usersAllMatch,
    usersWithMismatch,
    matchedCards,
    mismatchedCards,
    mismatches: mismatchRows,
  }
  const outPath = new URL('./check-user-card-emails.report.json', import.meta.url)
  const { writeFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  writeFileSync(fileURLToPath(outPath), JSON.stringify(report, null, 2), 'utf8')
  logger.info(`Wrote report: ${fileURLToPath(outPath)}`)
}

main()
  .catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
