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
import { CARD_BUILDER_MISSION, CARD_BUILDER_MISSION_COMPACT } from './cardBuilderMission'
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
      about: [
        profile.businessDescription,
        profile.missionStatement ? `Mission\n${profile.missionStatement}` : '',
        profile.whyChooseUs ? `Why Choose Us\n${profile.whyChooseUs}` : '',
        profile.suggestedCta ? `CTA: ${profile.suggestedCta}` : '',
      ]
        .map((part) => (part || '').trim())
        .filter(Boolean)
        .join('\n\n'),
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
    services: (() => {
      const fromServices = (profile.services || []).map((s) => ({
        type: mapServiceType(s.title, s.description) as CardBlueprint['services'][number]['type'],
        title: s.title,
        description: s.description || '',
        url: s.url || '',
        // AI must never invent service images — keep empty even if a model hallucinated imageUrl.
      }))
      if (fromServices.length) return fromServices
      return (profile.products || []).slice(0, 12).map((title) => ({
        type: 'Other' as CardBlueprint['services'][number]['type'],
        title: String(title),
        description: '',
        url: '',
      }))
    })(),
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

const CONTENT_SYSTEM = `You write professional vBiz Me card copy from a Master Business Profile (Business Intelligence Profile).

${CARD_BUILDER_MISSION}

Operational constraints for this pass:
- Only claim things present in the profile. Preserve approved/manual contact facts.
- Individual About Me MUST be first person (~100–150 words). Company cards use company voice.
- Include Mission + Why Choose Us + CTA close in about when available.
- Services: polish verified offerings only (emoji title + 40–75 word benefit copy). Do not invent services to fill a quota. NEVER invent service images or image URLs.
- FAQs: keep verified FAQs; aim for 5–8 total without inventing policies.
- Blogs: keep real articles; if none, draft at most 2 evergreen industry posts (not fake news).
- Reviews: real verified testimonials only. If none, return an empty reviews array.
- Honor narrow user instructions — change only the requested section.
- Return JSON matching the vCard blueprint shape.
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
    user: `Write a nearly complete card from this Master Business Profile. Merge with the factual skeleton. Fill polishable marketing fields (About, Services, FAQs). Prefer the skeleton for contact/identity facts; write marketing copy from verified profile evidence. Do not invent services, reviews, or contact details. ${input.instruction || ''}\n\nPROFILE:\n${compactProfileForPrompt(input.profile)}\n\nFACT SKELETON:\n${JSON.stringify(input.factBlueprint).slice(0, 24000)}`,
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
      ? 'If verifiedReviews or existingTestimonials have real quotes, return those (up to 15). If empty, return { "reviews": [] }. Never invent fictional customer reviews or treat examples as authentic testimonials.'
      : input.section === 'faqs'
        ? 'If the profile or sources contain FAQs, return those. If empty or fewer than 5, draft helpful FAQs to reach exactly 5 total when the business is clear. Do not invent prices, hours, guarantees, or certifications.'
        : input.section === 'blogs'
          ? 'If the profile or sources contain articles, return only those, up to 15. If none exist, draft at most 2 evergreen industry posts. Do not invent news events, dates, or awards.'
          : input.section === 'personal'
            ? 'For about: individuals = FIRST PERSON ~100–150 words + Mission + Why Choose Us + CTA close. Company voice for companies. Match brand voice. Do not invent contact facts. Change only fields the user asked to change.'
            : input.section === 'services'
              ? 'If services were found, return those (up to 15), each with an emoji-capable title and a 40–75 word benefit description. If none exist, return { "services": [] } — do not invent services to fill a quota. Unconfirmed ideas belong in needsConfirmation only. Never add imageUrl.'
              : input.section === 'portfolio'
                ? 'If portfolio items were found, return only those, up to 15. If none exist, return { "portfolio": [] }. Do not invent projects, client names, metrics, awards, or prices.'
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
    system: `${CARD_BUILDER_MISSION_COMPACT}\n\nFill one vCard section from the Master Business Profile only. Return ONLY JSON matching: ${schemaHint}. ${reviewRule} For services.type use ONLY: Web Development, App Design, SEO, Marketing, Other. ${seoRule}`,
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
