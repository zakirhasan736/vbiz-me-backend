import type { MasterBusinessProfile } from './businessProfile.schema'
import type { CardBlueprint } from './cardBlueprint.schema'
import type { ValidationIssue } from './validation.service'

const FIRST_PERSON_RE = /\b(i|i'm|i’ve|i've|my|me)\b/i
const COMPANY_VOICE_RE = /\b(we|our|us)\b/i

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordCount(value: string): number {
  const text = stripHtml(value)
  if (!text) return 0
  return text.split(/\s+/).filter(Boolean).length
}

/** Soft quality gates — repair when possible; never invent facts to pass checks. */
export function assessCardQuality(input: { blueprint: CardBlueprint; profile?: MasterBusinessProfile | null }): {
  blueprint: CardBlueprint
  issues: ValidationIssue[]
} {
  const issues: ValidationIssue[] = []
  let blueprint = input.blueprint
  const about = blueprint.personal?.about || ''
  const company = (blueprint.personal?.company || '').trim()
  const fullName = (blueprint.personal?.fullName || '').trim()
  const designation = (blueprint.personal?.designation || '').trim()
  const profession = (blueprint.personal?.profession || '').trim()
  // Person-named cards with a role are individual; company-named cards (name === company) are not.
  const looksIndividual =
    Boolean(fullName) &&
    company.toLowerCase() !== fullName.toLowerCase() &&
    (Boolean(designation) || Boolean(profession) || /\s/.test(fullName))

  if (about && looksIndividual && !FIRST_PERSON_RE.test(about) && COMPANY_VOICE_RE.test(about)) {
    issues.push({
      code: 'about_not_first_person',
      field: 'personal.about',
      message: 'Individual About Me should be first person when the card represents a person.',
    })
  }

  const aboutWords = wordCount(about)
  if (about && (aboutWords < 40 || aboutWords > 220)) {
    issues.push({
      code: 'about_length',
      field: 'personal.about',
      message: `About Me is ${aboutWords} words; target roughly 100–150 for individuals.`,
    })
  }

  const services = (blueprint.services || []).map((service) => {
    const descWords = wordCount(service.description || '')
    if (service.title && descWords > 0 && (descWords < 25 || descWords > 110)) {
      issues.push({
        code: 'service_description_length',
        field: 'services',
        message: `Service “${service.title}” description is ${descWords} words; target 40–75.`,
      })
    }
    // Never keep AI-invented service images on the blueprint.
    return { ...service, url: service.url || '' }
  })
  blueprint = { ...blueprint, services }

  const faqs = blueprint.faqs || []
  if (faqs.length > 0 && faqs.length < 3) {
    issues.push({
      code: 'faq_count_low',
      field: 'faqs',
      message: `Only ${faqs.length} FAQ(s); prefer 5–8 helpful FAQs when the business is clear.`,
    })
  }

  if (
    (blueprint.reviews || []).some((review) =>
      /draft\s*\/\s*sample|\[sample\]/i.test(`${review.author} ${review.text}`)
    )
  ) {
    issues.push({
      code: 'sample_review_in_reviews',
      field: 'reviews',
      message: 'Replace DRAFT / SAMPLE mock reviews with real customer quotes before publishing.',
    })
  } else if (
    (blueprint.reviews || []).length > 0 &&
    (blueprint.reviews || []).every((review) => /^example client/i.test(String(review.author || '').trim()))
  ) {
    issues.push({
      code: 'example_reviews_only',
      field: 'reviews',
      message: 'Reviews are AI examples for an empty site — replace with real testimonials before publishing.',
    })
  }

  const mission = input.profile?.missionStatement || ''
  if (mission) {
    const missionWords = wordCount(mission)
    if (missionWords < 15 || missionWords > 60) {
      issues.push({
        code: 'mission_length',
        field: 'missionStatement',
        message: `Mission is ${missionWords} words; target 25–45.`,
      })
    }
  }

  const theme = input.profile?.themeRecommendation
  if (theme) {
    const hexOk = (value?: string) => Boolean(value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()))
    for (const mode of ['light', 'dark'] as const) {
      const set = theme[mode]
      if (!hexOk(set?.primary) || !hexOk(set?.secondary) || !hexOk(set?.accent)) {
        issues.push({
          code: 'theme_incomplete',
          field: `themeRecommendation.${mode}`,
          message: `${mode} theme needs valid Primary, Secondary, and Accent HEX codes.`,
        })
      }
    }
  }

  return { blueprint, issues }
}

/** Clear AI service image fields while preserving non-service media. */
export function stripAiServiceImages<T extends object>(services: T[]): Array<T & { imageUrl: string }> {
  return services.map((service) => ({ ...service, imageUrl: '' }))
}
