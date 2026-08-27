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
import {
  LUNA_DOCUMENT_FILL_SECTIONS,
  selectFillSectionModel,
  selectModelForTask,
  type AiTier,
} from './modelRouter.service'
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
      dob: profile.dateOfBirth || '',
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
    blogs: (profile.blogs || []).map((post) => ({
      title: post.title,
      description: post.description || '',
      category: post.category || 'News',
      url: post.url || '',
      imageUrl: post.imageUrl || '',
    })),
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
- Do not invent licenses, years, phone numbers, or awards.
- FAQs must be answerable from the profile when possible. If none exist, generate up to 5 from business topics.
- Return JSON matching the vCard blueprint shape.
- Prefer real testimonials already in the profile for reviews. If none exist, write realistic example testimonials from business topics (not suggestedTestimonialTemplates copied as verified quotes).
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
      ? 'If verifiedReviews or existingTestimonials have real quotes, include those first. If they are empty, write realistic example testimonials grounded in business topics (services, industry, audience). Fill remaining slots up to 5. Do not invent licenses, prices, awards, or claim unverified named customers as factual quotes. Never copy suggestedTestimonialTemplates as verified reviews.'
      : input.section === 'faqs'
        ? 'FAQs must be answerable from the profile when possible. If none exist in the profile, generate up to 5 helpful FAQs from business topics. Do not invent prices, hours, guarantees, or certifications. Fill remaining slots up to 5.'
        : input.section === 'blogs'
          ? 'If no articles exist in the profile, draft up to 5 evergreen educational posts from business topics. Do not invent news events, dates, or awards. Fill remaining slots up to 5.'
          : 'Do not invent facts. Creative wording is fine for about/faq/blogs.'
  const seoRule =
    input.section === 'seo'
      ? 'For SEO, write a concise business-specific title and description from verified facts. Return 5-10 high-intent keywords about this business. Do not include vBiz Me platform keywords; those are added automatically. Never invent numeric search-volume claims.'
      : ''
  const writing = LUNA_DOCUMENT_FILL_SECTIONS.has(input.section)
    ? selectFillSectionModel(input.section)
    : selectModelForTask({
        task: input.section === 'personal' ? 'HIGH_QUALITY_WRITING' : 'SIMPLE_VOLUME',
      })
  const result = await chatJson<unknown>({
    tier: input.tier || (writing.tier === 'vision' ? 'luna' : writing.tier),
    temperature: 0.5,
    system: `Fill one vCard section from the Master Business Profile only. Return ONLY JSON matching: ${schemaHint}. ${reviewRule} For services.type use ONLY: Web Development, App Design, SEO, Marketing, Other. ${seoRule}`,
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
