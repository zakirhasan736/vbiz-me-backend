/**
 * Audit / fix corporate team-card member logins.
 *
 * Usage:
 *   npx tsx scripts/check-corporate-member-logins.ts jacky cba
 *   npx tsx scripts/check-corporate-member-logins.ts jacky cba --apply
 */
import { toApiRole } from '../src/constants/userRole'
import { ensureCorporateMemberLoginsForParent } from '../src/utils/corporateMemberUser'
import { prisma } from '../src/utils/prisma'

async function findCorporateIds(terms: string[]): Promise<string[]> {
  const ids = new Set<string>()
  for (const term of terms) {
    const q = term.trim()
    if (!q) continue
    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { companyName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, role: true },
      take: 40,
    })
    for (const u of users) {
      const role = toApiRole(u.role)
      if (role === 'corporate-owner') ids.add(u.id)
    }

    const profiles = await prisma.profile.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { companyName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        userId: true,
        companyUserId: true,
        user: { select: { id: true, role: true } },
        companyUser: { select: { id: true, role: true } },
      },
      take: 50,
    })
    for (const p of profiles) {
      if (p.companyUserId && p.companyUser && toApiRole(p.companyUser.role) === 'corporate-owner') {
        ids.add(p.companyUserId)
      }
      if (p.userId && p.user && toApiRole(p.user.role) === 'corporate-owner') {
        ids.add(p.userId)
      }
    }
  }
  return [...ids]
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const terms = args.filter((a) => a !== '--apply')
  const searchTerms = terms.length ? terms : ['jacky', 'cba']

  console.log(`Search: ${searchTerms.join(', ')} | mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const corpIds = await findCorporateIds(searchTerms)
  if (!corpIds.length) {
    console.log('No corporate accounts matched Jacky/CBA (or search terms).')
    return
  }

  for (const corpId of corpIds) {
    const report = await ensureCorporateMemberLoginsForParent({
      corporateUserId: corpId,
      actorUserId: corpId,
      apply,
    })
    console.log('\n===', report.corporate.name, `<${report.corporate.email}>`, report.corporate.companyName, '===')
    console.log('summary', report.summary)
    for (const card of report.cards) {
      console.log(
        JSON.stringify({
          status: card.status,
          name: card.name,
          email: card.email,
          slug: card.slug,
          ownerEmail: card.ownerEmail,
          message: card.message,
        })
      )
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
