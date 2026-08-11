/**
 * Manually seed starter packages + attach corporate-starter to existing corporate owners.
 * Usage: yarn seed:packages
 */
import seedPackages from '../src/bootstrap/seedPackages'
import { prisma } from '../src/utils/prisma'

async function main() {
  await prisma.$connect()
  await seedPackages()
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
