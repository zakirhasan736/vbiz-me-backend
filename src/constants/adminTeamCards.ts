import type { Prisma } from '../../generated/prisma/client'

/** The only profiles shown on Admin → VBizMe Team Cards (exactly these 8). */
export const ADMIN_TEAM_CARD_SLUGS = [
  'ryan-aldrich', // Leon White
  'tj-desjardins', // Thomas J Desjardins
  'julia-rose', // Julia Rose Quinn
  'mila', // Dagmary "Mila" Balanta
  'ryan', // Ryan Thomas
  'billy-toolen', // Billy Toolen
  'michaelangelo-casanova-2', // Michaelangelo Casanova (admin)
  'michaelanglo-casanova', // Michaelangelo Casanova (user)
] as const

/** Team Cards list is slug-only — no other admin-portfolio cards. */
export function buildAdminTeamCardsScopeWhere(): Prisma.ProfileWhereInput {
  return {
    slug: {
      in: [...ADMIN_TEAM_CARD_SLUGS],
      mode: 'insensitive',
    },
  }
}
