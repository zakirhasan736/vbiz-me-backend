import type { MasterBusinessProfile } from './businessProfile.schema'
import { TAB_CATALOG } from './cardBlueprint.schema'
import type { RecommendedTab } from './tabDecision.service'

export type FieldStatus = 'READY' | 'PARTIAL' | 'EMPTY' | 'WAITING_FOR_USER' | 'GENERATING' | 'SKIPPED'
export type FieldSource = 'WEBSITE' | 'DOCUMENT' | 'OCR' | 'USER' | 'AI' | 'EXISTING_CARD' | 'NONE' | 'AI_SAMPLE'
export type RecommendedCopyTier = 'LUNA' | 'TERRA' | 'VISION'

export type AiCardField = {
  id: string
  tabId: string
  sectionId: string
  fieldKey: string
  fieldLabel: string
  required: boolean
  status: FieldStatus
  source: FieldSource
  currentValue?: unknown
  confidence?: number
  aiGenerationAllowed: boolean
  recommendedTier?: RecommendedCopyTier
  userDecision?: boolean
  prompt: string
  special?: 'faq' | 'blog' | 'reviews' | 'portfolio' | 'gallery' | 'credentials' | 'services' | 'news'
}

export type TabPlan = {
  tabId: string
  name: string
  reason: string
  recommended: boolean
  selected: boolean
  percent: number
  ready: number
  partial: number
  empty: number
  skipped: number
  mark: 'ready' | 'needs' | 'empty'
}

export type HierarchicalCompletion = {
  cardPercent: number
  tabs: TabPlan[]
}

function present(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.values(value as object).some(present)
  return true
}

function classify(value: unknown, opts?: { minChars?: number }): { status: FieldStatus; source: FieldSource } {
  if (!present(value)) return { status: 'EMPTY', source: 'NONE' }
  if (typeof value === 'string' && opts?.minChars && value.trim().length < opts.minChars) {
    return { status: 'PARTIAL', source: 'WEBSITE' }
  }
  return { status: 'READY', source: 'WEBSITE' }
}

type FieldDef = {
  tabId: string
  sectionId: string
  fieldKey: string
  fieldLabel: string
  required?: boolean
  aiGenerationAllowed: boolean
  recommendedTier?: RecommendedCopyTier
  special?: AiCardField['special']
  prompt: string
  getValue: (profile: MasterBusinessProfile) => unknown
  minChars?: number
}

const FIELD_DEFS: FieldDef[] = [
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'fullName',
    fieldLabel: 'Name',
    required: true,
    aiGenerationAllowed: false,
    prompt: 'The public name on the card.',
    getValue: (p) => p.ownerName || p.businessName,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'company',
    fieldLabel: 'Business name',
    required: true,
    aiGenerationAllowed: false,
    prompt: 'The business or practice name.',
    getValue: (p) => p.businessName,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'phone',
    fieldLabel: 'Phone',
    required: true,
    aiGenerationAllowed: false,
    prompt: 'A phone number visitors can tap.',
    getValue: (p) => p.phone,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'email',
    fieldLabel: 'Email',
    required: true,
    aiGenerationAllowed: false,
    prompt: 'A public email address.',
    getValue: (p) => p.email,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'dob',
    fieldLabel: 'Date of birth',
    required: true,
    aiGenerationAllowed: false,
    prompt:
      "Required for activation. The owner must be at least 12 years old. Use YYYY-MM-DD only when the source explicitly states the owner's birth date.",
    getValue: (p) => p.dateOfBirth,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'website',
    fieldLabel: 'Website',
    aiGenerationAllowed: false,
    prompt: 'Your website URL.',
    getValue: (p) => p.website || p.socialMedia?.website,
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'address',
    fieldLabel: 'Address or service area',
    aiGenerationAllowed: false,
    prompt: 'Street address or service area. Do not invent a location.',
    getValue: (p) => p.address || (p.serviceAreas || []).join(', '),
  },
  {
    tabId: 'home',
    sectionId: 'personal',
    fieldKey: 'designation',
    fieldLabel: 'Title',
    aiGenerationAllowed: true,
    recommendedTier: 'LUNA',
    prompt: 'A short professional title.',
    getValue: (p) => p.ownerTitle,
  },
  {
    tabId: 'profile',
    sectionId: 'about',
    fieldKey: 'about',
    fieldLabel: 'About',
    aiGenerationAllowed: true,
    recommendedTier: 'TERRA',
    prompt: 'A professional About section from verified business facts only.',
    getValue: (p) => p.businessDescription,
    minChars: 80,
  },
  {
    tabId: 'services',
    sectionId: 'services',
    fieldKey: 'services',
    fieldLabel: 'Services',
    special: 'services',
    aiGenerationAllowed: true,
    recommendedTier: 'TERRA',
    prompt: 'Service names must come from sources. Descriptions may be written from verified facts.',
    getValue: (p) => p.services,
  },
  {
    tabId: 'faq',
    sectionId: 'faqs',
    fieldKey: 'faqs',
    fieldLabel: 'FAQ',
    special: 'faq',
    aiGenerationAllowed: true,
    recommendedTier: 'TERRA',
    prompt: 'FAQs must be answerable from verified facts. Do not invent policies.',
    getValue: (_p) => [],
  },
  {
    tabId: 'blog',
    sectionId: 'blogs',
    fieldKey: 'blogs',
    fieldLabel: 'News / Blog',
    special: 'blog',
    aiGenerationAllowed: true,
    recommendedTier: 'TERRA',
    prompt: 'Write evergreen educational content. Do not invent company news events.',
    getValue: (_p) => [],
  },
  {
    tabId: 'reviews',
    sectionId: 'reviews',
    fieldKey: 'reviews',
    fieldLabel: 'Reviews',
    special: 'reviews',
    aiGenerationAllowed: false,
    prompt: 'Only real customer reviews from sources. Never invent reviewers.',
    getValue: (p) => [...(p.verifiedReviews || []), ...(p.existingTestimonials || [])],
  },
  {
    tabId: 'gallery',
    sectionId: 'portfolio',
    fieldKey: 'portfolio',
    fieldLabel: 'Portfolio',
    special: 'portfolio',
    aiGenerationAllowed: false,
    prompt: 'Do not invent projects. Add real project details or skip.',
    getValue: (p) => p.portfolio,
  },
  {
    tabId: 'certificates',
    sectionId: 'credentials',
    fieldKey: 'licenses',
    fieldLabel: 'Licenses and certifications',
    special: 'credentials',
    aiGenerationAllowed: false,
    prompt: 'Never invent a license, certification, or award.',
    getValue: (p) => [
      ...(p.licenses || []),
      ...(p.certifications || []),
      ...(p.credentials || []),
      ...(p.awards || []),
    ],
  },
  {
    tabId: 'education',
    sectionId: 'education',
    fieldKey: 'education',
    fieldLabel: 'Education',
    aiGenerationAllowed: false,
    prompt: 'Only schools and degrees found in the sources.',
    getValue: (p) => p.education,
  },
  {
    tabId: 'work',
    sectionId: 'experience',
    fieldKey: 'experience',
    fieldLabel: 'Experience',
    aiGenerationAllowed: false,
    prompt: 'Only work history found in the sources.',
    getValue: (p) => p.experience,
  },
  {
    tabId: 'skills',
    sectionId: 'skills',
    fieldKey: 'skills',
    fieldLabel: 'Skills',
    aiGenerationAllowed: true,
    recommendedTier: 'LUNA',
    prompt: 'Skill groups from verified services and experience.',
    getValue: (p) => p.skills,
  },
]

export function buildFieldGraph(input: {
  profile: MasterBusinessProfile
  recommendedTabs: RecommendedTab[]
  selectedNavIds?: string[]
}): AiCardField[] {
  const recommended = new Set(input.recommendedTabs.map((t) => t.navId))
  const selected = new Set(
    input.selectedNavIds?.length ? input.selectedNavIds : ['home', ...input.recommendedTabs.map((t) => t.navId)]
  )
  const catalogIds = new Set(TAB_CATALOG.map((t) => t.navId))

  return FIELD_DEFS.filter(
    (def) => catalogIds.has(def.tabId) && (selected.has(def.tabId) || recommended.has(def.tabId))
  )
    .filter((def) => selected.has(def.tabId) || recommended.has(def.tabId))
    .map((def) => {
      const value = def.getValue(input.profile)
      let { status, source } = classify(value, { minChars: def.minChars })
      if (def.special === 'services' && Array.isArray(value) && value.length) {
        const missingDesc = value.some(
          (row) => row && typeof row === 'object' && !String((row as { description?: string }).description || '').trim()
        )
        status = missingDesc ? 'PARTIAL' : 'READY'
        source = 'WEBSITE'
      }
      if (def.special === 'faq' || def.special === 'blog') {
        status = 'EMPTY'
        source = 'NONE'
      }
      if (def.special === 'reviews') {
        const real = Array.isArray(value)
          ? value.filter(
              (row) => row && typeof row === 'object' && String((row as { text?: string }).text || '').trim()
            )
          : []
        status = real.length ? 'READY' : 'EMPTY'
      }
      if (def.special === 'portfolio') {
        const items = Array.isArray(value) ? value : []
        status = items.length ? 'PARTIAL' : 'EMPTY'
      }
      return {
        id: `${def.tabId}:${def.fieldKey}`,
        tabId: def.tabId,
        sectionId: def.sectionId,
        fieldKey: def.fieldKey,
        fieldLabel: def.fieldLabel,
        required: Boolean(def.required),
        status,
        source,
        currentValue: present(value) ? value : undefined,
        aiGenerationAllowed: def.aiGenerationAllowed,
        recommendedTier: def.recommendedTier,
        prompt: def.prompt,
        special: def.special,
      }
    })
}

export function mergeFieldDecision(fields: AiCardField[], patch: Partial<AiCardField> & { id: string }): AiCardField[] {
  return fields.map((field) => (field.id === patch.id ? { ...field, ...patch } : field))
}

export function nextActionableField(fields: AiCardField[], selectedNavIds: string[]): AiCardField | null {
  const selected = new Set(selectedNavIds)
  return (
    fields.find(
      (field) =>
        selected.has(field.tabId) &&
        (field.status === 'EMPTY' || field.status === 'PARTIAL' || field.status === 'WAITING_FOR_USER')
    ) || null
  )
}

export function buildTabPlan(input: {
  recommendedTabs: RecommendedTab[]
  selectedNavIds: string[]
  fields: AiCardField[]
}): HierarchicalCompletion {
  const byNav = Object.fromEntries(TAB_CATALOG.map((t) => [t.navId, t]))
  const recommended = new Set(input.recommendedTabs.map((t) => t.navId))
  const reasons = Object.fromEntries(input.recommendedTabs.map((t) => [t.navId, t.reason]))
  const navIds = [...new Set(['home', ...input.selectedNavIds, ...input.recommendedTabs.map((t) => t.navId)])].filter(
    (id) => byNav[id]
  )

  const tabs: TabPlan[] = navIds.map((tabId) => {
    const rows = input.fields.filter((f) => f.tabId === tabId)
    const ready = rows.filter((f) => f.status === 'READY').length
    const partial = rows.filter((f) => f.status === 'PARTIAL').length
    const empty = rows.filter((f) => f.status === 'EMPTY' || f.status === 'WAITING_FOR_USER').length
    const skipped = rows.filter((f) => f.status === 'SKIPPED').length
    const counted = rows.filter((f) => f.status !== 'SKIPPED')
    const percent = counted.length
      ? Math.round((ready / counted.length) * 100)
      : input.selectedNavIds.includes(tabId)
        ? 100
        : 0
    const mark: TabPlan['mark'] = percent >= 100 ? 'ready' : ready + partial > 0 ? 'needs' : 'empty'
    return {
      tabId,
      name: byNav[tabId]?.name || tabId,
      reason: reasons[tabId] || '',
      recommended: recommended.has(tabId) || tabId === 'home',
      selected: input.selectedNavIds.includes(tabId),
      percent,
      ready,
      partial,
      empty,
      skipped,
      mark,
    }
  })

  const selectedTabs = tabs.filter((t) => t.selected)
  const cardPercent = selectedTabs.length
    ? Math.round(selectedTabs.reduce((sum, tab) => sum + tab.percent, 0) / selectedTabs.length)
    : 0
  return { cardPercent, tabs }
}

export function fieldsForAddedTab(tabId: string, profile: MasterBusinessProfile): AiCardField[] {
  return buildFieldGraph({
    profile,
    recommendedTabs: [
      {
        type: tabId,
        navId: tabId,
        name: TAB_CATALOG.find((t) => t.navId === tabId)?.name || tabId,
        enabled: true,
        order: 99,
        reason: 'Added by you.',
        priority: 'medium',
      },
    ],
    selectedNavIds: [tabId],
  })
}
