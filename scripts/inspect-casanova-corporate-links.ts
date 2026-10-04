import { toApiRole } from '../src/constants/userRole'
import { prisma } from '../src/utils/prisma'

const SLUGS = [
  'michaelangelo-casanova-2',
  'julia-rose',
  'mila',
  'michaelanglo-casanova',
  'billy-toolen',
  'ryan',
  'ryan-aldrich',
]
const EMAIL = 'mcasanova@vbizme.com'

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: EMAIL, mode: 'insensitive' } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      accountStatus: true,
      companyName: true,
    },
  })

  const cards = await prisma.profile.findMany({
    where: {
      OR: [
        { slug: { in: SLUGS, mode: 'insensitive' } },
        { email: { equals: EMAIL, mode: 'insensitive' } },
        ...(user ? [{ userId: user.id }, { companyUserId: user.id }] : []),
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      companyName: true,
      designation: true,
      userId: true,
      companyUserId: true,
      user: { select: { id: true, name: true, email: true, role: true } },
      companyUser: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { slug: 'asc' },
  })

  const unique = new Map(cards.map((card) => [card.id, card]))
  const rows = [...unique.values()]

  console.log(
    JSON.stringify(
      {
        corporateUser: user
          ? {
              id: user.id,
              name: user.name,
              email: user.email,
              role: toApiRole(user.role),
              isActive: user.isActive,
              accountStatus: user.accountStatus,
              companyName: user.companyName,
            }
          : null,
        expectedSlugs: SLUGS,
        cardCount: rows.length,
        cards: rows.map((card) => ({
          slug: card.slug,
          name: card.name,
          email: card.email,
          companyName: card.companyName,
          designation: card.designation,
          owner: card.user ? { name: card.user.name, email: card.user.email, role: toApiRole(card.user.role) } : null,
          linkedTo: card.companyUser
            ? {
                name: card.companyUser.name,
                email: card.companyUser.email,
                role: toApiRole(card.companyUser.role),
              }
            : null,
          isTeamMember: Boolean(card.userId && card.companyUserId && card.userId !== card.companyUserId),
          isOwnerCard: Boolean(user && card.userId === user.id && card.companyUserId === user.id),
        })),
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
