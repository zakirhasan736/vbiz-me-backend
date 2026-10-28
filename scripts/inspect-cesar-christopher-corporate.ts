import { toApiRole } from '../src/constants/userRole'
import { prisma } from '../src/utils/prisma'

const SLUGS = ['cesar-vertiz-1', 'christopher-crespo']

async function main() {
  const cards = await prisma.profile.findMany({
    where: { slug: { in: SLUGS, mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      name: true,
      email: true,
      phone: true,
      companyName: true,
      userId: true,
      companyUserId: true,
      createdById: true,
      user: { select: { id: true, email: true, role: true, deletedAt: true, isActive: true } },
      companyUser: { select: { id: true, email: true, role: true, deletedAt: true, isActive: true } },
    },
  })

  console.log('=== cards ===')
  console.log(JSON.stringify(cards, null, 2))

  const userIds = [
    ...new Set(
      cards.flatMap((c) => [c.userId, c.companyUserId, c.user?.id, c.companyUser?.id].filter(Boolean) as string[])
    ),
  ]

  for (const userId of userIds) {
    const owned = await prisma.profile.findMany({
      where: { OR: [{ userId }, { companyUserId: userId }] },
      select: {
        slug: true,
        name: true,
        email: true,
        userId: true,
        companyUserId: true,
      },
      orderBy: { slug: 'asc' },
    })
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, deletedAt: true },
    })
    console.log(`\n=== pool for user ${user?.email || userId} (${toApiRole(user?.role as never) || '?'}) ===`)
    console.log(JSON.stringify(owned, null, 2))
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
