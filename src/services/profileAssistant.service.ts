import { DIRECT_SECTION_LOADERS, isGenericDirectStorage } from '../constants/directSectionStorage'
import { NAV_CHECKBOX_TO_TAB_KEY, NAV_ID_TO_TAB_KEY, TAB_REGISTRY } from '../constants/tabRegistry'
import AppError from '../error/AppError'
import { publicReadableWhere } from '../utils/cardStatus'
import { prisma } from '../utils/prisma'
import { safePrismaQuery } from '../utils/prismaErrors'
import { extractTextFromBuffer, type UploadedPart } from './ai/extractDocumentText'
import {
  ASSISTANT_SETTING_KEY,
  boundKnowledgeContext,
  isAssistantEnabled,
  MAX_ASSISTANT_CONTEXT_CHARS,
  MAX_BUSINESS_BRIEF_CHARS,
  MAX_KNOWLEDGE_TEXT_CHARS,
  parseAssistantEnabled,
  parseSupportedTabScope,
  sanitizePromptAddendum,
} from './assistantPolicy'
import { extractWithOcrFallback, needsServerOcr } from './documentOcr.service'

const cleanText = (value: unknown, max: number): string =>
  String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max)

async function loadAssistantExtras(profileId: string) {
  const [assistantConfig, assistantKnowledge] = await Promise.all([
    safePrismaQuery(() => prisma.profileAssistantConfig.findUnique({ where: { profileId } }), null),
    safePrismaQuery(
      () =>
        prisma.profileAssistantKnowledge.findMany({
          where: { profileId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true,
            profileId: true,
            label: true,
            tabScope: true,
            extractedText: true,
            createdAt: true,
          },
        }),
      []
    ),
  ])
  return { assistantConfig, assistantKnowledge }
}

async function legacyEnabled(profileId: string): Promise<boolean> {
  const setting = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: ASSISTANT_SETTING_KEY } },
    select: { value: true },
  })
  return parseAssistantEnabled(setting?.value)
}

export async function getConfig(profileId: string) {
  const [stored, legacy, profile] = await Promise.all([
    safePrismaQuery(() => prisma.profileAssistantConfig.findUnique({ where: { profileId } }), null),
    legacyEnabled(profileId),
    prisma.profile.findUnique({ where: { id: profileId }, select: { slug: true } }),
  ])
  return {
    profileId,
    enabled: isAssistantEnabled(stored?.enabled, legacy, profile?.slug),
    businessBrief: stored?.businessBrief || '',
    systemPromptAddendum: stored?.systemPromptAddendum || null,
    createdAt: stored?.createdAt || null,
    updatedAt: stored?.updatedAt || null,
  }
}

export async function updateConfig(
  profileId: string,
  input: { enabled?: unknown; businessBrief?: unknown; systemPromptAddendum?: unknown }
) {
  const data: { enabled?: boolean; businessBrief?: string; systemPromptAddendum?: string | null } = {}
  if (input.enabled !== undefined) data.enabled = parseAssistantEnabled(input.enabled)
  if (input.businessBrief !== undefined) {
    const brief = cleanText(input.businessBrief, MAX_BUSINESS_BRIEF_CHARS + 1)
    if (brief.length > MAX_BUSINESS_BRIEF_CHARS) {
      throw new AppError(400, `Business brief must be at most ${MAX_BUSINESS_BRIEF_CHARS} characters.`)
    }
    data.businessBrief = brief
  }
  if (input.systemPromptAddendum !== undefined) {
    data.systemPromptAddendum = sanitizePromptAddendum(input.systemPromptAddendum)
  }
  if (!Object.keys(data).length) throw new AppError(400, 'Provide at least one assistant config field.')

  const stored = await prisma.$transaction(async (tx) => {
    const config = await tx.profileAssistantConfig.upsert({
      where: { profileId },
      create: { profileId, enabled: data.enabled ?? false, businessBrief: data.businessBrief ?? '', ...data },
      update: data,
    })
    if (data.enabled !== undefined) {
      await tx.setting.upsert({
        where: { profileId_key: { profileId, key: ASSISTANT_SETTING_KEY } },
        create: { profileId, key: ASSISTANT_SETTING_KEY, value: data.enabled ? '1' : '0' },
        update: { value: data.enabled ? '1' : '0' },
      })
    }
    return config
  })
  return { ...stored, enabled: data.enabled ?? stored.enabled }
}

export async function listKnowledge(profileId: string) {
  const items = await prisma.profileAssistantKnowledge.findMany({
    where: { profileId },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  })
  return {
    items,
    lastTrainedAt: items[0]?.createdAt || null,
    total: items.length,
  }
}

export async function extractAndStoreKnowledge(input: {
  profileId: string
  businessText?: string
  about?: string
  tabScope?: string
  files?: UploadedPart[]
}) {
  const tabScope = input.tabScope ? parseSupportedTabScope(input.tabScope) : null
  const rows: Array<{
    sourceType: string
    tabScope: string | null
    label: string
    sha256?: string
    extractedText: string
    extractionMethod: string
  }> = []
  const manualText = cleanText(input.businessText || input.about, MAX_KNOWLEDGE_TEXT_CHARS)
  if (manualText) {
    rows.push({
      sourceType: 'manual',
      tabScope,
      label: input.about && !input.businessText ? 'About' : 'Business text',
      extractedText: manualText,
      extractionMethod: 'manual',
    })
  }

  for (const file of input.files || []) {
    const extracted = await extractTextFromBuffer(file)
    if (extracted.extractionMethod === 'unsupported') {
      throw new AppError(400, `Unsupported file type for “${file.name}”.`)
    }
    const text = needsServerOcr(extracted)
      ? await extractWithOcrFallback(file, extracted.extractionMethod === 'ocr_needed' ? 'scanned PDF' : 'image')
      : extracted.text.trim()
    if (!text) {
      throw new AppError(422, `No readable text was found in “${file.name}”.`)
    }
    rows.push({
      sourceType: file.mimeType.startsWith('image/')
        ? 'image'
        : file.mimeType === 'application/pdf'
          ? 'pdf'
          : 'document',
      tabScope,
      label: extracted.label,
      sha256: extracted.sha256,
      extractedText: text.slice(0, MAX_KNOWLEDGE_TEXT_CHARS),
      extractionMethod: needsServerOcr(extracted) ? 'ocr' : extracted.extractionMethod,
    })
  }

  if (!rows.length) throw new AppError(400, 'Provide businessText/about and/or at least one supported file.')
  const created = await prisma.$transaction(
    rows.map((row) =>
      prisma.profileAssistantKnowledge.create({
        data: { profileId: input.profileId, ...row },
      })
    )
  )
  return {
    items: created,
    summary: `${created.length} knowledge source${created.length === 1 ? '' : 's'} trained`,
    lastTrainedAt: created.reduce(
      (latest, row) => (row.createdAt > latest ? row.createdAt : latest),
      created[0].createdAt
    ),
  }
}

export async function deleteKnowledge(profileId: string, id: string) {
  const found = await prisma.profileAssistantKnowledge.findFirst({ where: { id, profileId }, select: { id: true } })
  if (!found) throw new AppError(404, 'Knowledge source not found')
  await prisma.profileAssistantKnowledge.delete({ where: { id } })
  return { id }
}

function enabledPublicTabKeys(settings: Array<{ key: string; value: string | null }>): {
  tabKeys: string[]
  navIds: string[]
} {
  const map = Object.fromEntries(settings.map((setting) => [setting.key, setting.value || '']))
  const tabKeys = new Set<string>()
  for (const [checkbox, tabKey] of Object.entries(NAV_CHECKBOX_TO_TAB_KEY)) {
    if (parseAssistantEnabled(map[checkbox])) tabKeys.add(tabKey)
  }
  const navIds: string[] = []
  try {
    const parsed = JSON.parse(map.display_settings_json || '{}') as { editorNavOrder?: unknown }
    for (const id of Array.isArray(parsed.editorNavOrder) ? parsed.editorNavOrder : []) {
      if (typeof id !== 'string') continue
      navIds.push(id)
      const tabKey = NAV_ID_TO_TAB_KEY[id] || id
      if (TAB_REGISTRY[tabKey]) tabKeys.add(tabKey)
    }
  } catch {
    // Invalid legacy display settings are ignored.
  }
  return { tabKeys: [...tabKeys].sort(), navIds }
}

export async function getPublicAssistantState(profileId: string) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...publicReadableWhere() },
    select: {
      id: true,
      slug: true,
      name: true,
      lastName: true,
      prof: true,
      designation: true,
      companyName: true,
      website: true,
      address: true,
      about: true,
      email: true,
      phone: true,
      whatsapp: true,
      settings: { select: { key: true, value: true } },
      aboutMe: { select: { title: true, description: true, status: true } },
      education: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { institute: true, degree: true, fromDate: true, toDate: true, tillNow: true },
      },
      experiences: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { company: true, jobTitle: true, description: true, fromDate: true, toDate: true, tillNow: true },
      },
      skillTags: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { name: true, level: true },
      },
      services: {
        where: { status: 1 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { title: true, description: true, reviewUrl: true },
      },
      reviews: {
        where: { status: 1 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { author: true, text: true, rating: true },
      },
      galleries: {
        where: { status: '1', deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { title: true, description: true, url: true },
      },
      blogs: {
        where: { status: '1', deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { title: true, description: true, url: true },
      },
      tabItems: {
        where: { status: '1', deletedAt: null },
        orderBy: [{ tabKey: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        select: { tabKey: true, title: true, description: true, url: true, metas: true },
      },
      customTabs: {
        where: { isEnabled: true, isPublic: true, status: '1' },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          label: true,
          description: true,
          items: {
            where: { status: '1' },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: { title: true, description: true, url: true, data: true },
          },
        },
      },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const { assistantConfig, assistantKnowledge } = await loadAssistantExtras(profileId)
  const legacyValue = profile.settings.find((setting) => setting.key === ASSISTANT_SETTING_KEY)?.value
  const enabled = isAssistantEnabled(assistantConfig?.enabled, legacyValue, profile.slug)
  const knowledgeText = enabled ? boundKnowledgeContext(profileId, assistantKnowledge) : ''
  const { tabKeys, navIds } = enabledPublicTabKeys(profile.settings)
  const visibleTabSet = new Set(tabKeys)
  const directSections = await Promise.all(
    tabKeys.map(async (tabKey) => {
      const tab = TAB_REGISTRY[tabKey]
      if (!tab || !isGenericDirectStorage(tab.storage)) return null
      const rows = await DIRECT_SECTION_LOADERS[tab.storage](profileId, 30)
      return rows.length ? ([tabKey, rows] as const) : null
    })
  )
  const sections: Record<string, unknown> = {}
  if (profile.aboutMe?.status === '1') sections.about_me = profile.aboutMe
  if (visibleTabSet.has('services')) sections.services = profile.services
  if (visibleTabSet.has('reviews')) sections.reviews = profile.reviews
  if (visibleTabSet.has('gallery')) sections.gallery = profile.galleries
  if (visibleTabSet.has('blogs')) sections.blogs = profile.blogs
  if (navIds.includes('education')) sections.education = profile.education
  if (navIds.includes('work')) sections.experience = profile.experiences
  if (navIds.includes('skills')) sections.skills = profile.skillTags
  for (const tabKey of tabKeys) {
    const rows = profile.tabItems.filter((row) => row.tabKey === tabKey)
    if (rows.length) sections[tabKey] = rows
  }
  for (const entry of directSections) {
    if (entry) sections[entry[0]] = entry[1]
  }
  if (profile.customTabs.length) sections.customTabs = profile.customTabs

  const publicCard = {
    name: [profile.name, profile.lastName].filter(Boolean).join(' '),
    title: profile.prof || profile.designation,
    company: profile.companyName,
    website: profile.website,
    address: profile.address,
    about: profile.about,
    email: profile.email,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    sections,
  }
  const context = [
    'PUBLIC CARD FACTS:',
    JSON.stringify(publicCard),
    assistantConfig?.businessBrief ? `BUSINESS BRIEF:\n${assistantConfig.businessBrief}` : '',
    knowledgeText ? `OWNER-SUPPLIED PUBLIC KNOWLEDGE:\n${knowledgeText}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_ASSISTANT_CONTEXT_CHARS)

  return {
    profileId,
    enabled,
    modelContext: context,
    businessBrief: enabled ? assistantConfig?.businessBrief || '' : '',
    knowledgeText,
    systemPromptAddendum: enabled ? assistantConfig?.systemPromptAddendum || null : null,
  }
}

export async function getPublicAssistantSupplement(profileId: string) {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      slug: true,
      settings: { where: { key: ASSISTANT_SETTING_KEY }, select: { value: true } },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  const { assistantConfig, assistantKnowledge } = await loadAssistantExtras(profileId)
  const enabled = isAssistantEnabled(assistantConfig?.enabled, profile.settings[0]?.value, profile.slug)
  return enabled
    ? {
        enabled: true,
        businessBrief: assistantConfig?.businessBrief || '',
        knowledgeText: boundKnowledgeContext(profileId, assistantKnowledge),
      }
    : { enabled: false, businessBrief: '', knowledgeText: '' }
}
