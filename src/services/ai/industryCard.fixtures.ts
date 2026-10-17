/**
 * Deterministic industry fixtures for regression scoring (Phase 12).
 * These are synthetic source summaries — not live research claims.
 */

import { scoreWritingUpgrade } from './writingQuality.fixtures'

export type IndustryFixture = {
  industry: 'real_estate' | 'automotive' | 'cleaning' | 'solar' | 'accounting'
  ownerName: string
  businessName: string
  title: string
  /** Simulated weak AI output (before upgrade rules). */
  before: { about: string; serviceDescription: string; inventsReviews: boolean; serviceImage: boolean }
  /** Target quality shape (after upgrade rules). */
  after: { about: string; serviceDescription: string; inventsReviews: boolean; serviceImage: boolean }
}

export const INDUSTRY_FIXTURES: IndustryFixture[] = [
  {
    industry: 'real_estate',
    ownerName: 'Jane Doe',
    businessName: 'Jane Realty',
    title: 'Realtor',
    before: {
      about: 'Jane Doe is a realtor who helps clients. Contact Jane Realty today.',
      serviceDescription: 'We provide buyer representation.',
      inventsReviews: true,
      serviceImage: true,
    },
    after: {
      about:
        'I help families buy and sell homes with clear guidance and local expertise. My process keeps you informed from first showing to closing, with calm negotiation and neighborhood insight tailored to your goals.',
      serviceDescription:
        'I guide you through every step of buying a home — from neighborhood research and private showings to offer strategy and negotiations — so you move forward with confidence, clear next steps, and a process built around your timeline and budget.',
      inventsReviews: false,
      serviceImage: false,
    },
  },
  {
    industry: 'automotive',
    ownerName: 'Marcus Lee',
    businessName: 'Lee Auto Group',
    title: 'Sales Manager',
    before: {
      about: 'Marcus Lee is a sales manager at Lee Auto Group. The dealership sells cars and trucks.',
      serviceDescription: 'Vehicle sales available.',
      inventsReviews: true,
      serviceImage: true,
    },
    after: {
      about:
        'I help drivers find the right vehicle without pressure — walking you through inventory, financing options, and trade-ins so you leave confident in both the car and the numbers on every visit.',
      serviceDescription:
        'I match you with inventory that fits your commute, budget, and must-have features, then explain every line of the deal so you understand payment options, warranty choices, protection products, and trade-in value before you commit with full clarity and confidence.',
      inventsReviews: false,
      serviceImage: false,
    },
  },
  {
    industry: 'cleaning',
    ownerName: 'Sofia Ruiz',
    businessName: 'BrightPath Cleaning',
    title: 'Owner',
    before: {
      about: 'Sofia Ruiz owns BrightPath Cleaning. The company provides cleaning services for homes and offices.',
      serviceDescription: 'We clean houses.',
      inventsReviews: false,
      serviceImage: true,
    },
    after: {
      about:
        'I built BrightPath Cleaning to give busy households a reliable, respectful clean — careful teams, clear checklists, and communication you can count on after every visit to your home.',
      serviceDescription:
        'I schedule recurring or one-time home cleans with a detailed room-by-room checklist, vetted team members, eco-friendly products when preferred, and photo confirmations when requested — so you return to a fresh space without chasing details or redoing unfinished work yourself later.',
      inventsReviews: false,
      serviceImage: false,
    },
  },
  {
    industry: 'solar',
    ownerName: 'Dev Patel',
    businessName: 'SunLedger Energy',
    title: 'Solar Consultant',
    before: {
      about: 'Dev Patel works at SunLedger Energy. The company installs solar panels for homeowners.',
      serviceDescription: 'Solar installation services.',
      inventsReviews: true,
      serviceImage: false,
    },
    after: {
      about:
        'I help homeowners evaluate solar with clear production estimates and honest financing options — no inflated savings claims, just a plan that fits your roof, usage, and long-term goals.',
      serviceDescription:
        'I design a rooftop solar proposal from your utility usage and roof layout, then walk you through equipment choices, incentives you may qualify for, interconnection steps, monitoring options, and expected production — so you decide with numbers you can independently verify.',
      inventsReviews: false,
      serviceImage: false,
    },
  },
  {
    industry: 'accounting',
    ownerName: 'Priya Shah',
    businessName: 'Shah Tax Advisors',
    title: 'CPA',
    before: {
      about: 'Priya Shah is a CPA at Shah Tax Advisors offering tax and bookkeeping services.',
      serviceDescription: 'Tax preparation available.',
      inventsReviews: false,
      serviceImage: true,
    },
    after: {
      about:
        'I partner with small business owners on tax planning and clean books year-round — translating requirements into practical steps so you stay compliant and make decisions with clearer numbers each quarter.',
      serviceDescription:
        'I prepare business and personal tax returns with organized document checklists, proactive quarterly estimates when useful, and plain-language explanations of deductions, credits, and filing deadlines — so tax season stays predictable instead of stressful for you and your whole team.',
      inventsReviews: false,
      serviceImage: false,
    },
  },
]

export function evaluateIndustryFixture(fixture: IndustryFixture) {
  const before = scoreWritingUpgrade({
    about: fixture.before.about,
    serviceDescription: fixture.before.serviceDescription,
  })
  const after = scoreWritingUpgrade({
    about: fixture.after.about,
    serviceDescription: fixture.after.serviceDescription,
  })
  return {
    industry: fixture.industry,
    beforeFailsFirstPerson: !before.firstPerson,
    afterFirstPerson: after.firstPerson,
    afterServiceInRange: after.serviceInRange,
    afterNoFakeReviews: !fixture.after.inventsReviews,
    afterNoServiceImages: !fixture.after.serviceImage,
    upgraded:
      after.firstPerson &&
      after.serviceInRange &&
      !fixture.after.inventsReviews &&
      !fixture.after.serviceImage &&
      (!before.firstPerson || !before.serviceInRange),
  }
}
