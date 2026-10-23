import { linkCardsToCorporateAccount } from '../src/utils/corporateMemberUser'
import { prisma } from '../src/utils/prisma'

/**
 * Repair: AI card builder reassigned #arlene-gonzalez to a new Corporate Team Member
 * because the website email (gonzalespg.com) differed from the corporate login
 * (gonzalezps.com). Claim the card back as the Corporate Team Owner login.
 *
 * Dry-run:  npx tsx scripts/claim-arlene-card-as-owner.ts
 * Apply:    npx tsx scripts/claim-arlene-card-as-owner.ts --apply
 */
const CORPORATE_EMAIL = 'arlene@gonzalezps.com'
const SLUGS = ['arlene-gonzalez']

async function main() {
  const apply = process.argv.includes('--apply')

  const data = await linkCardsToCorporateAccount({
    corporateEmail: CORPORATE_EMAIL,
    slugs: SLUGS,
    actorUserId: 'script',
    apply,
    promoteToCorporateOwner: true,
    forceAsOwnerCard: true,
    deleteOrphanMembers: true,
  })

  console.log(JSON.stringify(data, null, 2))

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to claim the card as owner and soft-delete orphan members.')
    return
  }

  const card = await prisma.profile.findFirst({
    where: { slug: { equals: SLUGS[0], mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      userId: true,
      companyUserId: true,
      user: { select: { email: true, role: true } },
      companyUser: { select: { email: true, role: true } },
    },
  })
  console.log('\nCard ownership after apply:')
  console.log(JSON.stringify(card, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
