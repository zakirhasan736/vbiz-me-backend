import { toApiRole } from '../src/constants/userRole'
import { getEffectiveEntitlements } from '../src/services/entitlement.service'
import { isCorporateEditUnlockedCard, resolveCorporateParentUserIdFromProfile } from '../src/utils/corporateSiblingSync'
import { prisma } from '../src/utils/prisma'

const NAMES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Jesse James Perkins', 'George Coates', 'Kasia Nowak', 'Precisely Cleaned Cleaning']

async function describeUser(id: string | null) {
  if (!id) return null
  const user = await prisma.user.findFirst({
    where: { id },
    select: { id: true, email: true, role: true, deletedAt: true },
  })
  if (!user) return { id, missing: true }
  const apiRole = toApiRole(user.role)
  const entitlements = await getEffectiveEntitlements(user.id, apiRole).catch(() => null)
  return {
    id: user.id,
    email: user.email,
    role: apiRole,
    ownerMode: entitlements?.ownerMode ?? null,
    deleted: Boolean(user.deletedAt),
  }
}

async function main() {
  for (const name of NAMES) {
    const cards = await prisma.profile.findMany({
      where: {
        OR: [
          { name: { contains: name, mode: 'insensitive' } },
          { companyName: { contains: name, mode: 'insensitive' } },
        ],
      },
      select: { id: true, slug: true, name: true, companyName: true, userId: true, companyUserId: true },
    })
    console.log(`\n=== ${name}: ${cards.length} card(s)`)
    for (const card of cards) {
      const settings = await prisma.setting.findMany({
        where: {
          profileId: card.id,
          key: {
            in: [
              'duplicated_from',
              'corporate_owned_ids_json',
              'hide_owner_photos',
              'hide_owner_videos',
              'hidden_owner_media_json',
            ],
          },
        },
        select: { key: true, value: true },
      })
      const map = Object.fromEntries(settings.map((row) => [row.key, row.value]))
      const ownedMap = map.corporate_owned_ids_json
        ? (JSON.parse(map.corporate_owned_ids_json) as Record<string, string[]>)
        : {}
      console.log(
        JSON.stringify(
          {
            slug: card.slug,
            name: card.name,
            companyName: card.companyName,
            user: await describeUser(card.userId),
            companyUser: card.companyUserId === card.userId ? 'same as user' : await describeUser(card.companyUserId),
            corporateParent: await resolveCorporateParentUserIdFromProfile(card),
            duplicatedFrom: map.duplicated_from || null,
            ownedIdCounts: Object.fromEntries(Object.entries(ownedMap).map(([k, v]) => [k, v.length])),
            hideOwnerPhotos: map.hide_owner_photos ?? null,
            hideOwnerVideos: map.hide_owner_videos ?? null,
            editUnlockedWithFix: await isCorporateEditUnlockedCard(card.id),
          },
          null,
          2
        )
      )
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
