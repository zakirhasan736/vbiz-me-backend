import { z } from 'zod'

const emptyToNull = (value: unknown) => {
  if (value == null) return null
  if (typeof value === 'string' && !value.trim()) return null
  return value
}

const nullableString = z.preprocess(emptyToNull, z.string().nullable().optional().default(null))

function labeledToString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (!value || typeof value !== 'object') return ''
  const rec = value as Record<string, unknown>
  const title = [rec.title, rec.name, rec.value, rec.label, rec.text, rec.award, rec.credential].find(
    (item): item is string => typeof item === 'string' && Boolean(item.trim())
  )
  const extra = [rec.year, rec.issuer, rec.organization, rec.authority]
    .filter((item) => item != null && String(item).trim())
    .map((item) => String(item).trim())
  return [title?.trim(), ...extra].filter(Boolean).join(' — ')
}

const stringListSchema = z.preprocess(
  (value) => {
    if (value == null) return []
    return Array.isArray(value) ? value : [value]
  },
  z.array(z.unknown()).transform((items) => items.map(labeledToString).filter(Boolean))
)

function clampStarRating(value: unknown, fallback?: number): number | undefined {
  if (value == null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(5, Math.round(n))
}

const optionalStarRating = z.preprocess((value) => clampStarRating(value), z.number().min(1).max(5).optional())
const sampleStarRating = z.preprocess((value) => clampStarRating(value, 5), z.number().min(1).max(5).default(5))

const sourcedFactSchema = z
  .object({
    value: z.union([z.string(), z.number()]),
    source: z.string().optional(),
    sourceUrl: z.string().optional(),
    documentId: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough()

export const conflictSchema = z.object({
  conflict: z.literal(true).optional().default(true),
  field: z.string(),
  values: z.array(
    z.object({
      value: z.union([z.string(), z.number(), z.boolean()]),
      source: z.string().optional().default('unknown'),
      sourceUrl: z.string().optional(),
    })
  ),
})

const reviewFactSchema = z.object({
  author: z.string().optional().default(''),
  text: z.string().optional().default(''),
  rating: optionalStarRating,
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
})

const sampleReviewSchema = z.object({
  author: z.string().optional().default('Sample Client'),
  text: z.string(),
  rating: sampleStarRating,
  isSample: z.literal(true).optional().default(true),
  label: z.string().optional().default('DRAFT / SAMPLE'),
})

export const masterBusinessProfileSchema = z.object({
  businessName: nullableString,
  ownerName: nullableString,
  ownerTitle: nullableString,
  dateOfBirth: nullableString,
  industry: nullableString,
  businessType: nullableString,
  businessDescription: nullableString,
  phone: nullableString,
  email: nullableString,
  website: nullableString,
  address: nullableString,
  whatsapp: nullableString,
  suggestedSlug: z.string().optional().default(''),
  serviceAreas: stringListSchema,
  businessHours: stringListSchema,
  services: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        url: z.string().optional().default(''),
        source: z.string().optional(),
        sourceUrl: z.string().optional(),
      })
    )
    .optional()
    .default([]),
  products: stringListSchema,
  credentials: stringListSchema,
  licenses: stringListSchema,
  certifications: stringListSchema,
  awards: stringListSchema,
  teamMembers: stringListSchema,
  education: z
    .array(
      z.object({
        institute: z.string().optional().default(''),
        degree: z.string().optional().default(''),
        fromDate: z.string().optional().default(''),
        toDate: z.string().optional().default(''),
        tillNow: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  experience: z
    .array(
      z.object({
        company: z.string().optional().default(''),
        jobTitle: z.string().optional().default(''),
        description: z.string().optional().default(''),
        fromDate: z.string().optional().default(''),
        toDate: z.string().optional().default(''),
        tillNow: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  skills: z
    .array(
      z.object({
        type: z.string().optional().default('General'),
        skills: z.array(z.string()).optional().default([]),
      })
    )
    .optional()
    .default([]),
  portfolio: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        url: z.string().optional().default(''),
      })
    )
    .optional()
    .default([]),
  socialMedia: z
    .object({
      facebook: nullableString,
      instagram: nullableString,
      linkedin: nullableString,
      youtube: nullableString,
      tiktok: nullableString,
      x: nullableString,
      twitter: nullableString,
      website: nullableString,
      whatsapp: nullableString,
    })
    .partial()
    .optional()
    .default({}),
  verifiedReviews: z.array(reviewFactSchema).optional().default([]),
  existingTestimonials: z.array(reviewFactSchema).optional().default([]),
  suggestedTestimonialTemplates: z.array(sampleReviewSchema).optional().default([]),
  importantFacts: z
    .array(z.union([z.string(), sourcedFactSchema]))
    .optional()
    .default([]),
  missingInformation: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
  conflicts: z.array(conflictSchema).optional().default([]),
  confidence: z
    .object({
      overall: z.number().min(0).max(1).optional().default(0.5),
      businessIdentity: z.number().min(0).max(1).optional().default(0.5),
      services: z.number().min(0).max(1).optional().default(0.5),
      contactInformation: z.number().min(0).max(1).optional().default(0.5),
      credentials: z.number().min(0).max(1).optional().default(0.5),
    })
    .optional()
    .default({
      overall: 0.5,
      businessIdentity: 0.5,
      services: 0.5,
      contactInformation: 0.5,
      credentials: 0.5,
    }),
})

export type MasterBusinessProfile = z.infer<typeof masterBusinessProfileSchema>

export const MASTER_PROFILE_JSON_INSTRUCTION = `Return ONLY JSON for a Master Business Profile. FACT MODE:
- Extract facts that appear in the sources. Do NOT invent names, birth dates, phones, emails, addresses, licenses, years in business, or reviews.
- Set dateOfBirth only when the source explicitly states the owner's birth date. Format it as YYYY-MM-DD; otherwise use null.
- Unknown facts must be null or [].
- Never write fictional customer reviews into verifiedReviews or existingTestimonials.
- If you find real testimonials/reviews in the source, put them in verifiedReviews or existingTestimonials with author/text when present.
- If no real reviews exist, you MAY add suggestedTestimonialTemplates marked as DRAFT / SAMPLE — never as real reviews.
- If sources disagree, put the disagreement in conflicts and leave the field null rather than guessing.
- Preserve source hints when obvious (website vs document vs instructions).

Shape:
{
  "businessName": null,
  "ownerName": null,
  "ownerTitle": null,
  "dateOfBirth": null,
  "industry": null,
  "businessType": null,
  "businessDescription": null,
  "phone": null,
  "email": null,
  "website": null,
  "address": null,
  "whatsapp": null,
  "suggestedSlug": "",
  "serviceAreas": [],
  "businessHours": [],
  "services": [{ "title": "", "description": "", "url": "", "source": "website", "sourceUrl": "" }],
  "products": [],
  "credentials": [],
  "licenses": [],
  "certifications": [],
  "awards": [],
  "teamMembers": [],
  "education": [],
  "experience": [],
  "skills": [{ "type": "Core", "skills": [] }],
  "portfolio": [{ "title": "", "description": "", "url": "" }],
  "socialMedia": { "facebook": null, "instagram": null, "linkedin": null, "youtube": null, "tiktok": null, "x": null, "website": null, "whatsapp": null },
  "verifiedReviews": [{ "author": "", "text": "", "rating": 5, "source": "website", "sourceUrl": "" }],
  "existingTestimonials": [],
  "suggestedTestimonialTemplates": [],
  "importantFacts": [],
  "missingInformation": [],
  "warnings": [],
  "conflicts": [{ "conflict": true, "field": "", "values": [{ "value": "", "source": "" }] }],
  "confidence": { "overall": 0.0, "businessIdentity": 0.0, "services": 0.0, "contactInformation": 0.0, "credentials": 0.0 }
}`
