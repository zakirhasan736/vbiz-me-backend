import type { MasterBusinessProfile } from './businessProfile.schema'
import { TAB_CATALOG } from './cardBlueprint.schema'

const PINNED = new Set(['home', 'about', 'public-cards', 'my-info'])

export type RecommendedTab = {
  type: string
  navId: string
  name: string
  enabled: boolean
  order: number
  reason: string
  priority: 'high' | 'medium' | 'low'
}

const CATALOG_BY_NAV = Object.fromEntries(TAB_CATALOG.map((t) => [t.navId, t]))

function industryBlob(profile: MasterBusinessProfile): string {
  return [
    profile.industry,
    profile.businessType,
    profile.businessDescription,
    profile.businessName,
    ...(profile.services || []).map((s) => `${s.title} ${s.description}`),
    ...(profile.importantFacts || []).map((f) => (typeof f === 'string' ? f : String(f.value))),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * Recommend only tabs the vBiz Me create-card catalog supports.
 * Never invent frontend tab types.
 */
export function decideRecommendedTabs(profile: MasterBusinessProfile): RecommendedTab[] {
  const hay = industryBlob(profile)
  const picks: Array<{ navId: string; reason: string; priority: RecommendedTab['priority'] }> = [
    { navId: 'home', reason: 'Every card starts with contact and identity.', priority: 'high' },
  ]

  const add = (navId: string, reason: string, priority: RecommendedTab['priority'] = 'medium') => {
    if (PINNED.has(navId) && navId !== 'home') return
    if (picks.some((p) => p.navId === navId)) return
    if (!CATALOG_BY_NAV[navId]) return
    picks.push({ navId, reason, priority })
  }

  if ((profile.services || []).length) add('services', 'Services were found in the source material.', 'high')
  if ((profile.portfolio || []).length) add('gallery', 'Project or portfolio items were found.', 'high')
  if ((profile.blogs || []).length) add('blog', 'Blog or news articles were found on the website.', 'high')
  if ((profile.verifiedReviews || []).length || (profile.existingTestimonials || []).length) {
    add('reviews', 'Real testimonials were found in the sources.', 'high')
  }
  if ((profile.education || []).length) add('education', 'Education history was found.', 'medium')
  if ((profile.experience || []).length) add('work', 'Work history was found.', 'medium')
  if ((profile.skills || []).some((g) => (g.skills || []).length)) add('skills', 'Skills were found.', 'medium')
  if ((profile.certifications || []).length || (profile.licenses || []).length || (profile.credentials || []).length) {
    add('certificates', 'Licenses or certifications were found.', 'high')
  }

  const legal = /attorney|lawyer|law firm|legal|esquire|counsel/
  const trade = /plumb|hvac|electric|roof|contractor|handyman|locksmith/
  const care = /daycare|child care|preschool|nanny|pediatric/
  const medical = /clinic|dentist|chiropract|physician|medical|optometr/
  const creative = /photographer|designer|studio|agency|brand/

  if (legal.test(hay)) {
    add('education', 'Legal practices usually list credentials and schooling.', 'high')
    add('work', 'Practice history helps visitors evaluate experience.', 'high')
    add('certificates', 'Bar admission and licenses belong on a legal card.', 'high')
    add('faq', 'Common legal questions help set expectations.', 'medium')
    add('reviews', 'Client feedback is useful when real reviews exist.', 'medium')
  } else if (trade.test(hay)) {
    add('services', 'Trades need a clear service list.', 'high')
    add('faq', 'Emergency, pricing, and service-area questions are expected.', 'high')
    add('certificates', 'License verification is important for contractors.', 'high')
    add('gallery', 'Project photos help prove work quality.', 'medium')
  } else if (care.test(hay)) {
    add('services', 'Programs and age groups map to services.', 'high')
    add('faq', 'Parents need enrollment and safety answers.', 'high')
    add('certificates', 'Safety and licensing credentials matter.', 'high')
    add('reviews', 'Parent testimonials help when they already exist.', 'medium')
  } else if (medical.test(hay)) {
    add('services', 'Treatments and specialties belong on the card.', 'high')
    add('faq', 'Patients typically ask about insurance, hours, and visits.', 'medium')
    add('certificates', 'Licenses and board certifications should be listed.', 'high')
  } else if (creative.test(hay)) {
    add('gallery', 'A portfolio is the primary proof for creative work.', 'high')
    add('services', 'Packages and offerings should be listed.', 'medium')
  }

  if (profile.businessDescription) add('profile', 'A public profile/about section fits this business.', 'medium')
  add('faq', 'A short FAQ helps visitors act without extra research.', 'low')

  const enabled: RecommendedTab[] = []
  let order = 1
  for (const pick of picks) {
    const tab = CATALOG_BY_NAV[pick.navId]
    if (!tab) continue
    enabled.push({
      type: pick.navId,
      navId: pick.navId,
      name: tab.name,
      enabled: true,
      order: order++,
      reason: pick.reason,
      priority: pick.priority,
    })
  }
  return enabled
}

export function recommendedTabNames(tabs: RecommendedTab[]): string[] {
  return tabs.filter((t) => t.enabled).map((t) => t.name)
}
