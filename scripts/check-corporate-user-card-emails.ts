/**
 * Compare corporate owner login email vs main corporate card email.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/check-corporate-user-card-emails.ts
 */
import { UserRole } from '@prisma/client'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

function norm(email: string | null | undefined): string {
  return String(email || '')
    .trim()
    .toLowerCase()
}

type CardRow = {
  id: string
  slug: string | null
  name: string
  email: string
  userId: string | null
  companyUserId: string | null
  isPublic: boolean
  isDraft: boolean
  createdAt: Date
}

function pickMainCorporateCard(ownerId: string, cards: CardRow[]): CardRow | null {
  if (!cards.length) return null
  const withEmail = (list: CardRow[]) => list.filter((c) => norm(c.email))
  return (
    withEmail(cards).find((c) => c.userId === ownerId && c.companyUserId === ownerId) ||
    cards.find((c) => c.userId === ownerId && c.companyUserId === ownerId) ||
    withEmail(cards).find((c) => c.userId === ownerId && !c.isDraft) ||
    withEmail(cards).find((c) => c.userId === ownerId) ||
    cards.find((c) => c.userId === ownerId) ||
    withEmail(cards).find((c) => c.companyUserId === ownerId && !c.isDraft) ||
    withEmail(cards).find((c) => c.companyUserId === ownerId) ||
    cards.find((c) => c.companyUserId === ownerId) ||
    null
  )
}

async function main() {
  const users = await prisma.user.findMany({
    where: { role: UserRole.CORPORATE_OWNER },
    select: { id: true, name: true, email: true, companyName: true },
    orderBy: { email: 'asc' },
  })

  const mismatches: Array<{
    userEmail: string
    userName: string | null
    companyName: string | null
    cardSlug: string | null
    cardName: string
    cardEmail: string
  }> = []

  let matched = 0
  let noCard = 0

  for (const user of users) {
    const cards = await prisma.profile.findMany({
      where: { OR: [{ userId: user.id }, { companyUserId: user.id }] },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        userId: true,
        companyUserId: true,
        isPublic: true,
        isDraft: true,
        createdAt: true,
      },
      orderBy: [{ isDraft: 'asc' }, { createdAt: 'asc' }],
    })
    const main = pickMainCorporateCard(user.id, cards)
    if (!main) {
      noCard += 1
      continue
    }
    if (norm(main.email) && norm(main.email) === norm(user.email)) {
      matched += 1
    } else {
      mismatches.push({
        userEmail: user.email,
        userName: user.name,
        companyName: user.companyName,
        cardSlug: main.slug,
        cardName: main.name,
        cardEmail: main.email || '(empty)',
      })
    }
  }

  for (const row of mismatches) {
    logger.info(
      `MISMATCH ${row.userEmail} | company="${row.companyName || ''}" | mainCard="${row.cardName}" @/${row.cardSlug || ''} | cardEmail=${row.cardEmail}`
    )
  }

  const report = {
    corporateOwners: users.length,
    matched,
    mismatched: mismatches.length,
    noCard,
    mismatches,
  }
  const outPath = fileURLToPath(new URL('./check-corporate-user-card-emails.report.json', import.meta.url))
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')

  logger.info('--- Corporate owner vs main card email ---')
  logger.info(`Owners: ${users.length}`)
  logger.info(`Matched: ${matched}`)
  logger.info(`Mismatched: ${mismatches.length}`)
  logger.info(`No main card: ${noCard}`)
  logger.info(`Report: ${outPath}`)
}

main()
  .catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
