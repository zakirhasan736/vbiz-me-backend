import type { Prisma } from '../../generated/prisma/client'

/** Legacy / curated slugs that always belong on Admin → VBizMe Team Cards. */
export const ADMIN_TEAM_CARD_SLUGS = [
  'ryan-aldrich', // Leon White
  'tj-desjardins', // Thomas J Desjardins
  'julia-rose', // Julia Rose Quinn
  'mila', // Dagmary "Mila" Balanta
  'ryan', // Ryan Thomas
  'billy-toolen', // Billy Toolen
  'michaelangelo-casanova-2', // Michaelangelo Casanova (admin)
  'michaelanglo-casanova', // Michaelangelo Casanova (user portfolio)
] as const

/**
 * Team Cards list: curated portfolio slugs plus any card assigned under an admin portfolio
 * (`companyUserId` = admin/staff). User-owned cards without admin assignment stay vCards-only.
 */
export function buildAdminTeamCardsScopeWhere(staffIdList: string[]): Prisma.ProfileWhereInput {
  const or: Prisma.ProfileWhereInput[] = [
    {
      slug: {
        in: [...ADMIN_TEAM_CARD_SLUGS],
        mode: 'insensitive',
      },
    },
  ]

  if (staffIdList.length) {
    or.push({ companyUserId: { in: staffIdList } })
  }

  return { OR: or }
}
