/**
 * Align Single Card Owner login emails with their owned card email.
 * After this, single users can sign in with card email + the global reset password.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/sync-single-user-email-from-card.ts --dry-run
 *   npx tsx --env-file=.env scripts/sync-single-user-email-from-card.ts
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

type ReportRow = {
  userId: string
  userName: string | null
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

async function main() {
  const users = await prisma.user.findMany({
    where: { role: UserRole.VCARD_OWNER },
    select: {
      id: true,
      name: true,
      email: true,
      subscriptions: {
        where: { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { package: { select: { ownerMode: true, name: true } } },
      },
      profiles: {
        select: {
          id: true,
          slug: true,
          name: true,
          email: true,
          isPublic: true,
          isDraft: true,
          createdAt: true,
        },
        orderBy: [{ isDraft: 'asc' }, { createdAt: 'asc' }],
      },
    },
    orderBy: { email: 'asc' },
  })

  const singleUsers = users.filter((user) => {
    const ownerMode = user.subscriptions[0]?.package?.ownerMode
    return !ownerMode || ownerMode === 'SINGLE'
  })

  const rows: ReportRow[] = []
  let updated = 0
  let matched = 0
  let skipped = 0

  for (const user of singleUsers) {
    const fromEmail = norm(user.email)
    const card =
      user.profiles.find((p) => norm(p.email) && p.isPublic && !p.isDraft) ||
      user.profiles.find((p) => norm(p.email) && !p.isDraft) ||
      user.profiles.find((p) => norm(p.email)) ||
      user.profiles[0]

    if (!card) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        fromEmail: user.email,
        toEmail: '',
        cardSlug: null,
        cardName: '',
        status: 'skipped-no-card',
        detail: 'User has no owned cards',
      })
      continue
    }

    const toEmail = norm(card.email)
    if (!toEmail) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        fromEmail: user.email,
        toEmail: '',
        cardSlug: card.slug,
        cardName: card.name,
        status: 'skipped-empty-card-email',
        detail: 'Card email is empty',
      })
      continue
    }

    if (!isValidEmail(toEmail)) {
      skipped += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        fromEmail: user.email,
        toEmail: card.email,
        cardSlug: card.slug,
        cardName: card.name,
        status: 'skipped-invalid',
        detail: 'Card email is not a valid email',
      })
      continue
    }

    if (toEmail === fromEmail) {
      matched += 1
      rows.push({
        userId: user.id,
        userName: user.name,
        fromEmail: user.email,
        toEmail,
        cardSlug: card.slug,
        cardName: card.name,
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
        fromEmail: user.email,
        toEmail,
        cardSlug: card.slug,
        cardName: card.name,
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
        fromEmail: user.email,
        toEmail,
        cardSlug: card.slug,
        cardName: card.name,
        status: 'updated',
        detail: 'dry-run',
      })
      logger.info(`[dry-run] ${user.email} → ${toEmail} (card /${card.slug || ''})`)
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: toEmail,
        // Keep account usable for card-email + global password login without re-verify friction.
        isVerified: true,
      },
    })
    updated += 1
    rows.push({
      userId: user.id,
      userName: user.name,
      fromEmail: user.email,
      toEmail,
      cardSlug: card.slug,
      cardName: card.name,
      status: 'updated',
    })
    logger.info(`Updated ${user.email} → ${toEmail} (card /${card.slug || ''})`)
  }

  const report = {
    dryRun,
    singleUsers: singleUsers.length,
    updated,
    alreadyMatched: matched,
    skipped,
    rows,
  }

  const outPath = fileURLToPath(new URL('./sync-single-user-email-from-card.report.json', import.meta.url))
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')

  logger.info('--- Sync single user login email from card email ---')
  logger.info(`Single users: ${singleUsers.length}`)
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
