import { z } from 'zod'

const socialHandlesSchema = z
  .object({
    facebook: z.string().optional(),
    instagram: z.string().optional(),
    twitter: z.string().optional(),
    linkedin: z.string().optional(),
    youtube: z.string().optional(),
    tiktok: z.string().optional(),
    website: z.string().optional(),
    whatsapp: z.string().optional(),
  })
  .partial()

/** Matches the admin Services editor dropdown. */
export const SERVICE_TYPE_VALUES = ['Web Development', 'App Design', 'SEO', 'Marketing', 'Other'] as const

export const serviceTypeSchema = z.enum(SERVICE_TYPE_VALUES)

/** Lenient items for fill-section (AI often omits fields). */
const fillServiceItemSchema = z.object({
  type: serviceTypeSchema.optional().default('Other'),
  title: z.string().optional().default(''),
  description: z.string().optional().default(''),
  url: z.string().optional().default(''),
})

const fillPortfolioItemSchema = z.object({
  title: z.string().optional().default(''),
  description: z.string().optional().default(''),
  url: z.string().optional().default(''),
})

const fillReviewItemSchema = z.object({
  author: z.string().optional().default(''),
  text: z.string().optional().default(''),
  rating: z.coerce.number().min(1).max(5).optional().default(5),
})

const fillBlogItemSchema = z.object({
  title: z.string().optional().default(''),
  description: z.string().optional().default(''),
  category: z.string().optional().default('News'),
})

const fillSkillItemSchema = z.object({
  type: z.string().optional().default('General'),
  skills: z.array(z.string()).optional().default([]),
})

const fillEducationItemSchema = z.object({
  institute: z.string().optional().default(''),
  degree: z.string().optional().default(''),
  fromDate: z.string().optional().default(''),
  toDate: z.string().optional().default(''),
  tillNow: z.boolean().optional().default(false),
})

const fillExperienceItemSchema = z.object({
  company: z.string().optional().default(''),
  jobTitle: z.string().optional().default(''),
  description: z.string().optional().default(''),
  fromDate: z.string().optional().default(''),
  toDate: z.string().optional().default(''),
  tillNow: z.boolean().optional().default(false),
})

const fillFaqItemSchema = z.object({
  question: z.string().optional().default(''),
  answer: z.string().optional().default(''),
})

const personalFillSchema = z.object({
  fullName: z.string().optional().default(''),
  email: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  designation: z.string().optional().default(''),
  company: z.string().optional().default(''),
  about: z.string().optional().default(''),
  website: z.string().optional().default(''),
  address: z.string().optional().default(''),
})

/** Per-section Zod schemas for fill-section responses. */
export const fillSectionSchemas = {
  services: z.object({ services: z.array(fillServiceItemSchema).default([]) }),
  blogs: z.object({ blogs: z.array(fillBlogItemSchema).default([]) }),
  portfolio: z.object({ portfolio: z.array(fillPortfolioItemSchema).default([]) }),
  reviews: z.object({ reviews: z.array(fillReviewItemSchema).default([]) }),
  skills: z.object({ skills: z.array(fillSkillItemSchema).default([]) }),
  education: z.object({ education: z.array(fillEducationItemSchema).default([]) }),
  experience: z.object({ experience: z.array(fillExperienceItemSchema).default([]) }),
  faqs: z.object({ faqs: z.array(fillFaqItemSchema).default([]) }),
  personal: z.object({
    personal: personalFillSchema.default({}),
    socialHandles: socialHandlesSchema.optional().default({}),
  }),
} as const

export type FillSectionId = keyof typeof fillSectionSchemas

export const FILL_SECTION_SCHEMA_HINTS: Record<FillSectionId, string> = {
  services: `{ "services": [{ "type": "Web Development"|"App Design"|"SEO"|"Marketing"|"Other", "title": "", "description": "", "url": "" }] }`,
  blogs: `{ "blogs": [{ "title": "", "description": "", "category": "News" }] }`,
  portfolio: `{ "portfolio": [{ "title": "", "description": "", "url": "" }] }`,
  reviews: `{ "reviews": [{ "author": "", "text": "", "rating": 5 }] }`,
  skills: `{ "skills": [{ "type": "Core", "skills": [""] }] }`,
  education: `{ "education": [{ "institute": "", "degree": "", "fromDate": "", "toDate": "", "tillNow": false }] }`,
  experience: `{ "experience": [{ "company": "", "jobTitle": "", "description": "", "fromDate": "", "toDate": "", "tillNow": false }] }`,
  faqs: `{ "faqs": [{ "question": "", "answer": "" }] }`,
  personal: `{ "personal": { "fullName": "", "email": "", "phone": "", "designation": "", "company": "", "about": "", "website": "", "address": "" }, "socialHandles": {} }`,
}

export function countFillEntries(section: FillSectionId, payload: Record<string, unknown>): number {
  if (section === 'personal') {
    const personal = payload.personal
    if (!personal || typeof personal !== 'object') return 0
    return Object.values(personal as Record<string, unknown>).some((v) => String(v || '').trim()) ? 1 : 0
  }
  const rows = payload[section]
  if (!Array.isArray(rows)) return 0
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false
    const r = row as Record<string, unknown>
    if (section === 'reviews') return Boolean(String(r.author || '').trim() || String(r.text || '').trim())
    if (section === 'faqs') return Boolean(String(r.question || '').trim() || String(r.answer || '').trim())
    if (section === 'education') return Boolean(String(r.institute || '').trim() || String(r.degree || '').trim())
    if (section === 'experience') {
      return Boolean(
        String(r.company || '').trim() || String(r.jobTitle || '').trim() || String(r.description || '').trim()
      )
    }
    if (section === 'skills') {
      const skills = Array.isArray(r.skills) ? r.skills : []
      return Boolean(String(r.type || '').trim() || skills.some((s) => String(s || '').trim()))
    }
    return Boolean(String(r.title || '').trim() || String(r.description || '').trim())
  }).length
}

/** Stricter items for full-card analyze blueprint. */
const blueprintServiceItemSchema = z.object({
  type: serviceTypeSchema.optional().default('Other'),
  title: z.string(),
  description: z.string().optional().default(''),
  url: z.string().optional().default(''),
})

const blueprintPortfolioItemSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(''),
  url: z.string().optional().default(''),
})

const blueprintReviewItemSchema = z.object({
  author: z.string(),
  text: z.string(),
  rating: z.number().min(1).max(5).optional().default(5),
})

const blueprintBlogItemSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(''),
  category: z.string().optional().default('News'),
})

const blueprintSkillItemSchema = z.object({
  type: z.string(),
  skills: z.array(z.string()),
})

const blueprintEducationItemSchema = z.object({
  institute: z.string(),
  degree: z.string(),
  fromDate: z.string().optional().default(''),
  toDate: z.string().optional().default(''),
  tillNow: z.boolean().optional().default(false),
})

const blueprintExperienceItemSchema = z.object({
  company: z.string(),
  jobTitle: z.string(),
  description: z.string().optional().default(''),
  fromDate: z.string().optional().default(''),
  toDate: z.string().optional().default(''),
  tillNow: z.boolean().optional().default(false),
})

const blueprintFaqItemSchema = z.object({
  question: z.string(),
  answer: z.string(),
})

export const cardBlueprintSchema = z.object({
  businessSummary: z.string(),
  suggestedSlug: z.string(),
  personal: z.object({
    fullName: z.string(),
    email: z.string().optional().default(''),
    phone: z.string().optional().default(''),
    whatsapp: z.string().optional().default(''),
    designation: z.string().optional().default(''),
    company: z.string().optional().default(''),
    profession: z.string().optional().default(''),
    address: z.string().optional().default(''),
    website: z.string().optional().default(''),
    about: z.string().optional().default(''),
  }),
  socialHandles: socialHandlesSchema.optional().default({}),
  education: z.array(blueprintEducationItemSchema).optional().default([]),
  experience: z.array(blueprintExperienceItemSchema).optional().default([]),
  skills: z.array(blueprintSkillItemSchema).optional().default([]),
  services: z.array(blueprintServiceItemSchema).optional().default([]),
  portfolio: z.array(blueprintPortfolioItemSchema).optional().default([]),
  reviews: z.array(blueprintReviewItemSchema).optional().default([]),
  blogs: z.array(blueprintBlogItemSchema).optional().default([]),
  faqs: z.array(blueprintFaqItemSchema).optional().default([]),
  enabledTabs: z.array(z.string()).optional().default(['Personal']),
  recommendedTabs: z
    .array(
      z.object({
        tab: z.string(),
        reason: z.string(),
        priority: z.enum(['high', 'medium', 'low']).optional().default('medium'),
      })
    )
    .optional()
    .default([]),
  optionalFeatures: z
    .object({
      aiAssistance: z.boolean().optional().default(true),
      canva: z.boolean().optional().default(true),
      seo: z.boolean().optional().default(true),
      pushNotifications: z.boolean().optional().default(true),
      emailNotifications: z.boolean().optional().default(true),
    })
    .optional()
    .default({
      aiAssistance: true,
      canva: true,
      seo: true,
      pushNotifications: true,
      emailNotifications: true,
    }),
})

export type CardBlueprint = z.infer<typeof cardBlueprintSchema>

export const BLUEPRINT_JSON_INSTRUCTION = `Return a single JSON object matching this shape:
{
  "businessSummary": "2-3 sentence summary",
  "suggestedSlug": "url-friendly-slug",
  "personal": {
    "fullName": "", "email": "", "phone": "", "whatsapp": "",
    "designation": "", "company": "", "profession": "",
    "address": "", "website": "", "about": ""
  },
  "socialHandles": { "facebook": "", "instagram": "", "twitter": "", "linkedin": "", "youtube": "", "tiktok": "", "website": "" },
  "education": [{ "institute": "", "degree": "", "fromDate": "YYYY-MM-DD", "toDate": "", "tillNow": false }],
  "experience": [{ "company": "", "jobTitle": "", "description": "", "fromDate": "", "toDate": "", "tillNow": false }],
  "skills": [{ "type": "Core", "skills": ["Skill"] }],
  "services": [{ "type": "Web Development"|"App Design"|"SEO"|"Marketing"|"Other", "title": "", "description": "", "url": "" }],
  "portfolio": [{ "title": "", "description": "", "url": "" }],
  "reviews": [{ "author": "", "text": "", "rating": 5 }],
  "blogs": [{ "title": "", "description": "", "category": "News" }],
  "faqs": [{ "question": "", "answer": "" }],
  "enabledTabs": ["Personal", "Services", "Skill"],
  "recommendedTabs": [{ "tab": "Portfolio", "reason": "why", "priority": "high" }],
  "optionalFeatures": {
    "aiAssistance": true, "canva": true, "seo": true,
    "pushNotifications": true, "emailNotifications": true
  }
}
Only include arrays when you have credible content from the sources. When a website crawl includes services, portfolio, blog, FAQ, or review pages, you MUST populate those arrays with multiple real items. For reviews/testimonials and any slider/carousel/list section, treat REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK labels as separate items and capture ALL distinct items present in the crawl or embedded JSON, not just the first visible slide. If there are many reviews, include every credible review up to 30 and preserve author names/ratings when available. Prefer accurate facts from the source; invent minimal professional placeholders only when needed to make a usable card. Dates as YYYY-MM-DD when known.
For services.type use ONLY: Web Development, App Design, SEO, Marketing, or Other.
enabledTabs = ONLY tabs that have content (do NOT dump a full default tab set). Always imply Personal is present. Never put Global Connection or My Info in enabledTabs — the product pins those last automatically. Use recommendedTabs for useful content tabs still missing data (Education, Experience, Skill, Services, Reviews, News/Blogs, Profile, Portfolio, Certifications/Licenses, FAQ).`

export const TAB_CATALOG = [
  { name: 'Personal', navId: 'home', description: 'Profile, contact details, media & socials (always first)' },
  { name: 'Education', navId: 'education', description: 'Degrees, schools, and years' },
  { name: 'Experience', navId: 'work', description: 'Work history and roles' },
  { name: 'Skill', navId: 'skills', description: 'Skill groups and proficiency' },
  { name: 'Services', navId: 'services', description: 'Offerings, pricing, and delivery (multi-item)' },
  { name: 'Reviews', navId: 'reviews', description: 'Guest & client reviews (multi-item)' },
  { name: 'News/Blogs', navId: 'blog', description: 'Articles, news, and blog posts (multi-item)' },
  { name: 'Profile', navId: 'profile', description: 'Public profile headline, bio & photo' },
  { name: 'Portfolio', navId: 'gallery', description: 'Projects and case studies (multi-item)' },
  { name: 'Certifications/Licenses', navId: 'certificates', description: 'Licenses and certifications' },
  { name: 'Resume', navId: 'resume', description: 'Downloadable resume / CV' },
  { name: 'FAQ', navId: 'faq', description: 'Common questions and answers (multi-item)' },
  {
    name: 'Global Connection',
    navId: 'global-connection',
    description: 'Shared global directory — ALWAYS second-to-last; same list for all cards',
  },
  {
    name: 'My Info',
    navId: 'my-info',
    description: 'Call/text/email actions from personal info — ALWAYS last',
  },
]
