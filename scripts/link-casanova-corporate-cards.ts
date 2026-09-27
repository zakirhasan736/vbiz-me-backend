import { linkCardsToCorporateAccount } from '../src/utils/corporateMemberUser'
import { prisma } from '../src/utils/prisma'

const CORPORATE_EMAIL = 'mcasanova@vbizme.com'
const SLUGS = ['michaelangelo-casanova-2', 'julia-rose', 'mila']

async function main() {
  const apply = process.argv.includes('--apply')
  const data = await linkCardsToCorporateAccount({
    corporateEmail: CORPORATE_EMAIL,
    slugs: SLUGS,
    actorUserId: 'script',
    apply,
    promoteToCorporateOwner: true,
  })
  console.log(JSON.stringify(data, null, 2))
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply on the live server to write the links.')
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
