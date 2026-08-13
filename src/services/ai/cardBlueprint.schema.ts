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
  education: z
    .array(
      z.object({
        institute: z.string(),
        degree: z.string(),
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
        company: z.string(),
        jobTitle: z.string(),
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
        type: z.string(),
        skills: z.array(z.string()),
      })
    )
    .optional()
    .default([]),
  services: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        url: z.string().optional().default(''),
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
  reviews: z
    .array(
      z.object({
        author: z.string(),
        text: z.string(),
        rating: z.number().min(1).max(5).optional().default(5),
      })
    )
    .optional()
    .default([]),
  blogs: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional().default(''),
        category: z.string().optional().default('News'),
      })
    )
    .optional()
    .default([]),
  faqs: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
      })
    )
    .optional()
    .default([]),
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
  "services": [{ "title": "", "description": "", "url": "" }],
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
Only include arrays when you have credible content from the sources. When a website crawl includes services, portfolio, blog, FAQ, or review pages, you MUST populate those arrays with multiple real items. For reviews/testimonials and any slider/carousel/list section, capture ALL distinct items present in the crawl or embedded JSON, not just the first visible slide. If there are many reviews, include every credible review up to 30 and preserve author names/ratings when available. Prefer accurate facts from the source; invent minimal professional placeholders only when needed to make a usable card. Dates as YYYY-MM-DD when known.
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
