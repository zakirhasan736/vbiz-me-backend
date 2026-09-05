import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

/** Default homepage Explore live demos — order is intentional. */
export const DEFAULT_LANDING_DEMO_CARDS = [
  {
    id: 'landing-demo-executive',
    category: 'Executive',
    designationOverride: 'CEO/Founder',
    slug: 'michaelangelo-casanova-2',
    sortOrder: 0,
  },
  {
    id: 'landing-demo-electrician',
    category: 'Electrician',
    designationOverride: 'Owner/Operator',
    slug: 'chago-vargas',
    sortOrder: 1,
  },
  {
    id: 'landing-demo-finance-wealth',
    category: 'Finance & Wealth',
    designationOverride: 'Certified Wealth Educator',
    slug: 'walter-jofre-jr',
    sortOrder: 2,
  },
  {
    id: 'landing-demo-auto-sales',
    category: 'Auto Sales',
    designationOverride: 'Senior Sales Consultant',
    slug: 'brian-dennis',
    sortOrder: 3,
  },
  {
    id: 'landing-demo-financial-coach',
    category: 'Financial Coach',
    designationOverride: 'Wealth Advisor',
    slug: 'sheldon-singleton',
    sortOrder: 4,
  },
  {
    id: 'landing-demo-restaurant',
    category: 'Restaurant',
    designationOverride: 'Sabor Ecuatoriano',
    slug: 'sabor-ecuatoriano-3',
    sortOrder: 5,
  },
  {
    id: 'landing-demo-moving-services',
    category: 'Moving Services',
    designationOverride: 'Richard Kincaid · CEO',
    slug: 'richard-kincaid',
    sortOrder: 6,
  },
  {
    id: 'landing-demo-real-estate',
    category: 'Real Estate',
    designationOverride: 'Jessica Brito · Agent',
    slug: 'jessica-brito',
    sortOrder: 7,
  },
  {
    id: 'landing-demo-fitness',
    category: 'Fitness',
    designationOverride: 'Mike Faienza · Trainer',
    slug: 'mike-faienza',
    sortOrder: 8,
  },
  {
    id: 'landing-demo-legal',
    category: 'Legal',
    designationOverride: 'Wil Jacques · Attorney',
    slug: 'wil-jacques',
    sortOrder: 9,
  },
] as const

/**
 * Idempotent startup seed: ensures curated landing demos exist.
 * Does not overwrite category/designation/sortOrder/status if an admin already edited them.
 * Links profileId when a matching public profile slug exists.
 */
const seedLandingDemoCards = async (): Promise<void> => {
  for (const demo of DEFAULT_LANDING_DEMO_CARDS) {
    const profile = await prisma.profile.findFirst({
      where: { slug: demo.slug },
      select: { id: true },
    })

    await prisma.landingDemoCard.upsert({
      where: { id: demo.id },
      create: {
        id: demo.id,
        category: demo.category,
        designationOverride: demo.designationOverride,
        slug: demo.slug,
        sortOrder: demo.sortOrder,
        status: 'active',
        profileId: profile?.id ?? null,
      },
      update: {
        // Keep curated copy stable on restart; only refresh profile link when missing.
        ...(profile
          ? {
              profileId: profile.id,
            }
          : {}),
      },
    })
  }

  logger.info(`Landing demo card seed ensured (${DEFAULT_LANDING_DEMO_CARDS.length} demos)`)
}

export default seedLandingDemoCards
