import type { MasterBusinessProfile } from './businessProfile.schema'
import { cardBlueprintSchema, TAB_CATALOG, type CardBlueprint } from './cardBlueprint.schema'
import { profileToBlueprintFacts } from './contentGenerator.service'
import type { AiCardField } from './fieldGraph.service'
import type { RecommendedTab } from './tabDecision.service'
import { sanitizeBlueprint } from './validation.service'

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function assembleAiCard(input: {
  profile: MasterBusinessProfile
  fields: AiCardField[]
  recommendedTabs: RecommendedTab[]
  selectedNavIds: string[]
}): { blueprint: CardBlueprint; issues: { code: string; message: string; field?: string }[] } {
  const selected = new Set(input.selectedNavIds.filter((id) => TAB_CATALOG.some((t) => t.navId === id)))
  const tabs = input.recommendedTabs.filter((t) => selected.has(t.navId) || t.navId === 'home')
  const facts = profileToBlueprintFacts(input.profile, tabs.length ? tabs : input.recommendedTabs)
  const valueOf = (key: string) => input.fields.find((f) => f.fieldKey === key && f.status !== 'SKIPPED')?.currentValue

  const personalPatch = {
    fullName: String(valueOf('fullName') || facts.personal?.fullName || ''),
    email: String(valueOf('email') || facts.personal?.email || ''),
    phone: String(valueOf('phone') || facts.personal?.phone || ''),
    designation: String(valueOf('designation') || facts.personal?.designation || ''),
    company: String(valueOf('company') || facts.personal?.company || ''),
    about: String(valueOf('about') || facts.personal?.about || ''),
    website: String(valueOf('website') || facts.personal?.website || ''),
    address: String(valueOf('address') || facts.personal?.address || ''),
  }

  const enabledTabs = TAB_CATALOG.filter((t) => selected.has(t.navId) || t.navId === 'home').map((t) => t.name)

  const raw = {
    ...facts,
    personal: { ...facts.personal, ...personalPatch },
    services: selected.has('services')
      ? asArray(valueOf('services')).length
        ? asArray(valueOf('services'))
        : facts.services
      : [],
    faqs: selected.has('faq') ? asArray(valueOf('faqs')) : [],
    blogs: selected.has('blog') ? asArray(valueOf('blogs')) : [],
    reviews: selected.has('reviews')
      ? asArray(valueOf('reviews')).length
        ? asArray(valueOf('reviews'))
        : facts.reviews
      : [],
    portfolio: selected.has('gallery')
      ? asArray(valueOf('portfolio')).length
        ? asArray(valueOf('portfolio'))
        : facts.portfolio
      : [],
    education: selected.has('education')
      ? asArray(valueOf('education')).length
        ? asArray(valueOf('education'))
        : facts.education
      : [],
    experience: selected.has('work')
      ? asArray(valueOf('experience')).length
        ? asArray(valueOf('experience'))
        : facts.experience
      : [],
    skills: selected.has('skills')
      ? asArray(valueOf('skills')).length
        ? asArray(valueOf('skills'))
        : facts.skills
      : [],
    enabledTabs,
    recommendedTabs: input.recommendedTabs
      .filter((t) => t.name !== 'Personal')
      .map((t) => ({ tab: t.name, reason: t.reason, priority: t.priority })),
    businessSummary: facts.businessSummary || personalPatch.about || '',
    suggestedSlug: facts.suggestedSlug || 'my-card',
  }

  return sanitizeBlueprint(cardBlueprintSchema.parse(raw))
}
