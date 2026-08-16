import { logChatMeta } from './aiUsageLog.service'
import type { MasterBusinessProfile } from './businessProfile.schema'
import {
  BLUEPRINT_JSON_INSTRUCTION,
  FILL_SECTION_SCHEMA_HINTS,
  coerceServiceTypes,
  fillSectionSchemas,
  type CardBlueprint,
  type FillSectionId,
} from './cardBlueprint.schema'
import { selectModelForTask, type AiTier } from './modelRouter.service'
import { chatJson } from './openai.client'
import { compactProfileForPrompt } from './sourceNormalizer.service'
import { recommendedTabNames, type RecommendedTab } from './tabDecision.service'
import { filterRealReviews } from './validation.service'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function mapServiceType(title: string, description = ''): string {
  const lower = `${title} ${description}`.toLowerCase()
  if (/web|frontend|backend|full.?stack/.test(lower)) return 'Web Development'
  if (/app|mobile|ios|android|ui.?ux/.test(lower)) return 'App Design'
  if (/seo|search/.test(lower)) return 'SEO'
  if (/market|ads|social|brand/.test(lower)) return 'Marketing'
  return 'Other'
}

export function profileToBlueprintFacts(
  profile: MasterBusinessProfile,
  tabs: RecommendedTab[]
): Partial<CardBlueprint> {
  const realReviews = [
    ...filterRealReviews(profile.verifiedReviews),
    ...filterRealReviews(profile.existingTestimonials),
  ]
  const social = profile.socialMedia || {}
  const name = profile.ownerName || profile.businessName || ''
  return {
    businessSummary: profile.businessDescription || '',
    suggestedSlug: profile.suggestedSlug || slugify(profile.businessName || profile.ownerName || 'my-card'),
    personal: {
      fullName: name,
      email: profile.email || '',
      phone: profile.phone || '',
      whatsapp: profile.whatsapp || profile.phone || '',
      designation: profile.ownerTitle || '',
      company: profile.businessName || '',
      profession: profile.industry || profile.businessType || '',
      address: profile.address || '',
      website: profile.website || social.website || '',
      about: profile.businessDescription || '',
    },
    socialHandles: {
      facebook: social.facebook || undefined,
      instagram: social.instagram || undefined,
      twitter: social.x || social.twitter || undefined,
      linkedin: social.linkedin || undefined,
      youtube: social.youtube || undefined,
      tiktok: social.tiktok || undefined,
      website: social.website || profile.website || undefined,
      whatsapp: social.whatsapp || profile.whatsapp || undefined,
    },
    education: profile.education || [],
    experience: profile.experience || [],
    skills: profile.skills || [],
    services: (profile.services || []).map((s) => ({
      type: mapServiceType(s.title, s.description) as CardBlueprint['services'][number]['type'],
      title: s.title,
      description: s.description || '',
      url: s.url || '',
    })),
    portfolio: profile.portfolio || [],
    reviews: realReviews.map((r) => ({
      author: r.author || 'Client',
      text: r.text || '',
      rating: r.rating || 5,
    })),
    blogs: [],
    faqs: [],
    enabledTabs: recommendedTabNames(tabs),
    recommendedTabs: tabs
      .filter((t) => t.name !== 'Personal')
      .slice(0, 8)
      .map((t) => ({ tab: t.name, reason: t.reason, priority: t.priority })),
  }
}

const CONTENT_SYSTEM = `You write professional vBiz Me card copy from a Master Business Profile.
Rules:
- Creative language is allowed. Creative facts are not.
- Only claim things present in the profile.
- Do not invent reviews, licenses, years, phone numbers, or awards.
- FAQs must be answerable from the profile. If a fact is missing, skip that FAQ.
- Return JSON matching the vCard blueprint shape.
- Put ONLY real testimonials already in the profile into reviews. Never copy suggestedTestimonialTemplates into reviews.
${BLUEPRINT_JSON_INSTRUCTION}`

export async function generateCardContent(input: {
  profile: MasterBusinessProfile
  factBlueprint: Partial<CardBlueprint>
  userId?: string
  sessionId?: string
  instruction?: string
}): Promise<CardBlueprint> {
  const writing = selectModelForTask({ task: 'HIGH_QUALITY_WRITING' })
  const result = await chatJson<unknown>({
    tier: writing.tier === 'vision' ? 'terra' : writing.tier,
    temperature: 0.5,
    system: CONTENT_SYSTEM,
    user: `Write card content from this Master Business Profile. Merge with the factual skeleton. ${input.instruction || ''}\n\nPROFILE:\n${compactProfileForPrompt(input.profile)}\n\nFACT SKELETON:\n${JSON.stringify(input.factBlueprint).slice(0, 12000)}`,
  })
  await logChatMeta('content_generation', result.meta, {
    userId: input.userId,
    sessionId: input.sessionId,
    success: true,
  })
  return result.data as CardBlueprint
}

export async function generateSectionFromProfile(input: {
  section: FillSectionId
  profile: MasterBusinessProfile
  instruction?: string
  currentDraft?: string
  userId?: string
  sessionId?: string
  tier?: AiTier
}): Promise<unknown> {
  const schemaHint = FILL_SECTION_SCHEMA_HINTS[input.section]
  const reviewRule =
    input.section === 'reviews'
      ? 'Only include real testimonials from verifiedReviews/existingTestimonials. Never output suggestedTestimonialTemplates as reviews. If none exist, return { "reviews": [] }.'
      : 'Do not invent facts. Creative wording is fine for about/faq/blogs.'
  const writing = selectModelForTask({
    task:
      input.section === 'faqs' || input.section === 'blogs' || input.section === 'personal'
        ? 'HIGH_QUALITY_WRITING'
        : 'SIMPLE_VOLUME',
  })
  const result = await chatJson<unknown>({
    tier: input.tier || (writing.tier === 'vision' ? 'luna' : writing.tier),
    temperature: input.section === 'reviews' ? 0.1 : 0.5,
    system: `Fill one vCard section from the Master Business Profile only. Return ONLY JSON matching: ${schemaHint}. ${reviewRule} For services.type use ONLY: Web Development, App Design, SEO, Marketing, Other.`,
    user: `Section: ${input.section}\nUser instruction: ${input.instruction || '(none)'}\nCurrent draft (partial):\n${(input.currentDraft || '').slice(0, 6000)}\n\nPROFILE:\n${compactProfileForPrompt(input.profile)}`,
  })
  await logChatMeta(`fill_${input.section}`, result.meta, {
    userId: input.userId,
    sessionId: input.sessionId,
    success: true,
  })
  const coerced = input.section === 'services' ? coerceServiceTypes(result.data) : result.data
  return fillSectionSchemas[input.section].parse(coerced)
}
