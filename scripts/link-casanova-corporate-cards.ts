import { linkCardsToCorporateAccount } from '../src/utils/corporateMemberUser'
import { syncCorporateSiblingSharedContent } from '../src/utils/corporateSiblingSync'
import { prisma } from '../src/utils/prisma'

/**
 * Corporate owner: michaelangelo-casanova-2 (mcasanova@vbizme.com)
 *
 * Already linked: julia-rose, mila
 * Newly link: michaelanglo-casanova, billy-toolen, ryan, ryan-aldrich
 *
 * Personal Information + About Me stay per card.
 * Shared business sync is OPT-IN only (--sync-shared) and requires force:true.
 */
const CORPORATE_EMAIL = 'mcasanova@vbizme.com'
const OWNER_SLUG = 'michaelangelo-casanova-2'
const SLUGS = [
  OWNER_SLUG,
  // already linked
  'julia-rose',
  'mila',
  // newly link
  'michaelanglo-casanova',
  'billy-toolen',
  'ryan',
  'ryan-aldrich',
]

async function main() {
  const apply = process.argv.includes('--apply')
  // Opt-in only — never auto-wipe sibling tabs on link.
  const syncShared = apply && process.argv.includes('--sync-shared')

  const data = await linkCardsToCorporateAccount({
    corporateEmail: CORPORATE_EMAIL,
    slugs: SLUGS,
    actorUserId: 'script',
    apply,
    promoteToCorporateOwner: true,
  })
  console.log(JSON.stringify(data, null, 2))

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write links.')
    console.log('Optional (destructive): --apply --sync-shared to copy owner business tabs onto linked cards.')
    return
  }

  if (syncShared) {
    const owner = await prisma.profile.findFirst({
      where: { slug: { equals: OWNER_SLUG, mode: 'insensitive' } },
      select: { id: true, slug: true, name: true },
    })
    if (!owner) {
      throw new Error(`Owner card not found after link: ${OWNER_SLUG}`)
    }
    const result = await syncCorporateSiblingSharedContent(
      owner.id,
      { type: 'fullShared' },
      { allowEmpty: false, force: true }
    )
    console.log(
      JSON.stringify(
        {
          syncedFrom: { id: owner.id, slug: owner.slug, name: owner.name },
          siblingCount: result.siblingCount,
          note: 'Personal info + About Me were not overwritten (per-card).',
        },
        null,
        2
      )
    )
  } else {
    console.log(
      'Links written. Shared content was NOT synced (pass --sync-shared only if you intend a full overwrite).'
    )
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
