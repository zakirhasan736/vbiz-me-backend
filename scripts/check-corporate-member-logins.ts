/**
 * Audit / fix corporate team-card member logins for ALL corporate accounts.
 * Optionally reset default passwords for single + corporate + linked owners.
 *
 * Usage:
 *   npx tsx scripts/check-corporate-member-logins.ts
 *   npx tsx scripts/check-corporate-member-logins.ts --apply
 *   npx tsx scripts/check-corporate-member-logins.ts --apply --reset-owner-passwords
 *   npx tsx scripts/check-corporate-member-logins.ts jacky --apply
 */
import { toApiRole } from '../src/constants/userRole'
import {
  ensureAllCorporateMemberLogins,
  ensureCorporateMemberLoginsForParent,
  listAllCorporateOwnerIds,
  resetOwnerDefaultPasswords,
} from '../src/utils/corporateMemberUser'
import { CORPORATE_MEMBER_DEFAULT_PASSWORD } from '../src/utils/duplicateCard'
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
      if (toApiRole(u.role) === 'corporate-owner') ids.add(u.id)
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
        user: { select: { role: true } },
        companyUser: { select: { role: true } },
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
  const resetOwnerPasswords = args.includes('--reset-owner-passwords')
  const terms = args.filter((a) => !a.startsWith('--'))

  console.log(
    `mode=${apply ? 'APPLY' : 'DRY-RUN'} | defaultPassword=${CORPORATE_MEMBER_DEFAULT_PASSWORD} | resetOwnerPasswords=${resetOwnerPasswords}`
  )

  if (!terms.length) {
    const all = await ensureAllCorporateMemberLogins({
      actorUserId: (await listAllCorporateOwnerIds())[0] || 'system',
      apply,
      resetPasswords: apply,
    })
    // Prefer a real actor when applying: use first corporate id or first admin if needed
    console.log('\nALL CORPORATES totals', all.totals)
    for (const report of all.results) {
      console.log(
        `\n=== ${report.corporate.name} <${report.corporate.email}> ${report.corporate.companyName || ''} ===`
      )
      console.log('summary', report.summary)
      for (const card of report.cards) {
        if (card.status === 'ready' && !apply) continue
        console.log(
          JSON.stringify({
            status: card.status,
            name: card.name,
            email: card.email,
            slug: card.slug,
            message: card.message,
          })
        )
      }
    }
  } else {
    const corpIds = await findCorporateIds(terms)
    if (!corpIds.length) {
      console.log('No corporate accounts matched:', terms.join(', '))
      return
    }
    for (const corpId of corpIds) {
      const report = await ensureCorporateMemberLoginsForParent({
        corporateUserId: corpId,
        actorUserId: corpId,
        apply,
        resetPasswords: apply,
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
            message: card.message,
          })
        )
      }
    }
  }

  if (resetOwnerPasswords) {
    const ownerReport = await resetOwnerDefaultPasswords({ apply })
    console.log('\nOWNER PASSWORD RESET', ownerReport.summary)
    console.log(`password=${ownerReport.password}`)
    if (ownerReport.summary.errors) {
      for (const u of ownerReport.users.filter((row) => row.status === 'error')) {
        console.log(JSON.stringify(u))
      }
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
