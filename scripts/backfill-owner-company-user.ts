/**
 * One-shot repair after single → corporate switches:
 * set companyUserId = userId on corporate-owner cards that still have null companyUserId.
 *
 *   npx tsx --env-file=.env scripts/backfill-owner-company-user.ts
 *   npx tsx --env-file=.env scripts/backfill-owner-company-user.ts --apply
 */
import { UserRole as PrismaUserRole } from '../generated/prisma/enums'
import { prisma } from '../src/utils/prisma'

async function main() {
  const apply = process.argv.includes('--apply')
  const corporates = await prisma.user.findMany({
    where: { role: PrismaUserRole.CORPORATE_OWNER },
    select: { id: true, email: true, name: true },
  })

  let total = 0
  for (const corp of corporates) {
    const count = await prisma.profile.count({
      where: { userId: corp.id, companyUserId: null },
    })
    if (!count) continue
    total += count
    console.log(`${corp.email || corp.id}: ${count} card(s) missing companyUserId`)
    if (apply) {
      const result = await prisma.profile.updateMany({
        where: { userId: corp.id, companyUserId: null },
        data: { companyUserId: corp.id },
      })
      console.log(`  → updated ${result.count}`)
    }
  }

  if (!total) console.log('Nothing to repair.')
  else if (!apply) console.log(`\nDRY-RUN: ${total} card(s). Re-run with --apply to write.`)
  else console.log(`\nDone. Repaired ${total} card(s).`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
  })
