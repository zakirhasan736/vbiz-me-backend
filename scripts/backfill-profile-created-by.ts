/**
 * Backfill Profile.createdById for migrated rows (was never set on import).
 * Prefer companyUserId (admin/corporate portfolio), else userId (owner).
 *
 * Usage: yarn tsx --env-file=.env scripts/backfill-profile-created-by.ts
 */
import 'dotenv/config'
import { prisma } from '../src/utils/prisma'

async function main() {
  const nullCreated = await prisma.profile.count({ where: { createdById: null } })
  console.log('profiles missing createdById:', nullCreated)
  if (!nullCreated) {
    console.log('Nothing to backfill')
    return
  }

  const rows = await prisma.profile.findMany({
    where: { createdById: null },
    select: { id: true, userId: true, companyUserId: true },
  })

  let updated = 0
  for (const row of rows) {
    const createdById = row.companyUserId || row.userId
    if (!createdById) continue
    await prisma.profile.update({
      where: { id: row.id },
      data: { createdById },
    })
    updated += 1
  }

  console.log(`Backfilled createdById on ${updated} profiles`)

  const remaining = await prisma.profile.count({ where: { createdById: null } })
  console.log('remaining null:', remaining)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
