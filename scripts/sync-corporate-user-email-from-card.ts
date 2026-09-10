/**
 * Align Corporate Owner login email with their main corporate card email.
 * Main card = owner's own card (userId + companyUserId = owner), else oldest owned/company card.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/sync-corporate-user-email-from-card.ts --dry-run
 *   npx tsx --env-file=.env scripts/sync-corporate-user-email-from-card.ts
 */
import { UserRole } from '@prisma/client'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

const dryRun = process.argv.includes('--dry-run')

function norm(email: string | null | undefined): string {
  return String(email || '')
    .trim()
    .toLowerCase()
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
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

type ReportRow = {
  userId: string
  userName: string | null
  companyName: string | null
  fromEmail: string
  toEmail: string
  cardSlug: string | null
  cardName: string
  status:
    | 'updated'
    | 'already-matched'
    | 'skipped-no-card'
    | 'skipped-empty-card-email'
    | 'skipped-invalid'
    | 'skipped-conflict'
  detail?: string
}

function pickMainCorporateCard(ownerId: string, cards: CardRow[]): CardRow | null {
  if (!cards.length) return null

  const withEmail = (list: CardRow[]) => list.filter((c) => norm(c.email))

  // Owner's own main card: both ownership pointers point at the corporate owner.
  const ownMain =
    withEmail(cards).find((c) => c.userId === ownerId && c.companyUserId === ownerId) ||
    cards.find((c) => c.userId === ownerId && c.companyUserId === ownerId)

  if (ownMain) return ownMain

  // Directly owned cards (userId = corporate owner)
  const owned =
    withEmail(cards).find((c) => c.userId === ownerId && c.isPublic && !c.isDraft) ||
    withEmail(cards).find((c) => c.userId === ownerId && !c.isDraft) ||
    withEmail(cards).find((c) => c.userId === ownerId) ||
    cards.find((c) => c.userId === ownerId)

  if (owned) return owned

  // Company-scoped cards (companyUserId = corporate owner)
  const company =
    withEmail(cards).find((c) => c.companyUserId === ownerId && c.isPublic && !c.isDraft) ||
    withEmail(cards).find((c) => c.companyUserId === ownerId && !c.isDraft) ||
    withEmail(cards).find((c) => c.companyUserId === ownerId) ||
    cards.find((c) => c.companyUserId === ownerId)

  return company || null
}

async function main() {
  const users = await prisma.user.findMany({
    where: { role: UserRole.CORPORATE_OWNER },
    select: {
      id: true,
      name: true,
      email: true,
      companyName: true,
    },
    orderBy: { email: 'asc' },
  })

  const rows: ReportRow[] = []
  let updated = 0
  let matched = 0
  let skipped = 0

  for (const user of users) {
    const cards = await prisma.profile.findMany({
      where: {
        OR: [{ userId: user.id }, { companyUserId: user.id }],
      },
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

    const mainCard = pickMainCorporateCard(user.id, cards)
    const fromEmail = norm(user.email)

    if (!mainCard) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail: '',
        cardSlug: null,
        cardName: '',
        status: 'skipped-no-card',
        detail: 'No corporate main/owned card found',
      })
      continue
    }

    const toEmail = norm(mainCard.email)
    if (!toEmail) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail: '',
        cardSlug: mainCard.slug,
        cardName: mainCard.name,
        status: 'skipped-empty-card-email',
        detail: 'Main card email is empty',
      })
      continue
    }

    if (!isValidEmail(toEmail)) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail: mainCard.email,
        cardSlug: mainCard.slug,
        cardName: mainCard.name,
        status: 'skipped-invalid',
        detail: 'Main card email is not valid',
      })
      continue
    }

    if (toEmail === fromEmail) {
      matched += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail,
        cardSlug: mainCard.slug,
        cardName: mainCard.name,
        status: 'already-matched',
      })
      continue
    }

    const conflict = await prisma.user.findUnique({
      where: { email: toEmail },
      select: { id: true, email: true, role: true },
    })
    if (conflict && conflict.id !== user.id) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail,
        cardSlug: mainCard.slug,
        cardName: mainCard.name,
        status: 'skipped-conflict',
        detail: `Email already used by user ${conflict.id} (${conflict.role})`,
      })
      continue
    }

    if (dryRun) {
      updated += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        companyName: user.companyName,
        fromEmail: user.email,
        toEmail,
        cardSlug: mainCard.slug,
        cardName: mainCard.name,
        status: 'updated',
        detail: 'dry-run',
      })
      logger.info(`[dry-run] ${user.email} → ${toEmail} (main card /${mainCard.slug || ''})`)
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: toEmail,
        isVerified: true,
      },
    })
    updated += 1
    rows.push({
      userId: user.id,
      userName: user.name,
      companyName: user.companyName,
      fromEmail: user.email,
      toEmail,
      cardSlug: mainCard.slug,
      cardName: mainCard.name,
      status: 'updated',
    })
    logger.info(`Updated ${user.email} → ${toEmail} (main card /${mainCard.slug || ''})`)
  }

  const report = {
    dryRun,
    corporateOwners: users.length,
    updated,
    alreadyMatched: matched,
    skipped,
    rows,
  }

  const outPath = fileURLToPath(new URL('./sync-corporate-user-email-from-card.report.json', import.meta.url))
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')

  logger.info('--- Sync corporate owner login email from main card email ---')
  logger.info(`Corporate owners: ${users.length}`)
  logger.info(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`)
  logger.info(`Already matched: ${matched}`)
  logger.info(`Skipped: ${skipped}`)
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
