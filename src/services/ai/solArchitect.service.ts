import { z } from 'zod'
import { logChatMeta } from './aiUsageLog.service'
import {
  MASTER_PROFILE_JSON_INSTRUCTION,
  masterBusinessProfileSchema,
  type MasterBusinessProfile,
} from './businessProfile.schema'
import { TAB_CATALOG } from './cardBlueprint.schema'
import { detectSourceConflicts } from './conflictDetection'
import { selectModelForTask } from './modelRouter.service'
import { chatJson } from './openai.client'
import type { NormalizedSourceData } from './sourceNormalizer.service'
import { decideRecommendedTabs, type RecommendedTab } from './tabDecision.service'

const solEnvelopeSchema = z.object({
  masterBusinessProfile: masterBusinessProfileSchema,
  recommendedNavIds: z.array(z.string()).optional().default([]),
  tabReasons: z
    .array(z.object({ navId: z.string(), reason: z.string() }))
    .optional()
    .default([]),
})

const CATALOG_NAV = new Set(TAB_CATALOG.map((t) => t.navId))

export type SolArchitecture = {
  masterBusinessProfile: MasterBusinessProfile
  recommendedTabs: RecommendedTab[]
  sourceMap: Array<{ fieldKey: string; value: unknown; source?: string; sourceUrl?: string }>
}

function sourcePrompt(normalized: NormalizedSourceData): string {
  return normalized.extractedText.slice(0, 28000)
}

function existingCardPrompt(existingCard?: unknown): string {
  if (!existingCard) return ''
  try {
    return `\nEXISTING CARD (already on file — prefer these facts when they do not conflict):\n${JSON.stringify(existingCard).slice(0, 8000)}\n`
  } catch {
    return ''
  }
}

/** One SOL architecture call after extraction. Do not call again unless sources change. */
export async function runSolArchitect(input: {
  normalized: NormalizedSourceData
  userId?: string
  sessionId?: string
  existingCard?: unknown
}): Promise<SolArchitecture> {
  const route = selectModelForTask({ task: 'CARD_ARCHITECTURE' })
  const catalog = TAB_CATALOG.filter((t) => t.navId !== 'global-connection' && t.navId !== 'my-info')
    .map((t) => `${t.navId} = ${t.name}: ${t.description}`)
    .join('\n')

  const result = await chatJson<unknown>({
    tier: route.tier,
    temperature: 0.2,
    system: `You are the vBiz Me card architect. ${MASTER_PROFILE_JSON_INSTRUCTION}

Also return recommendedNavIds using ONLY these ids:
${catalog}

Return JSON:
{
  "masterBusinessProfile": { ...profile shape above },
  "recommendedNavIds": ["home", "services"],
  "tabReasons": [{ "navId": "services", "reason": "short why" }]
}

Never invent tabs. Never invent phones, emails, licenses, awards, reviews, projects, or years in business.`,
    user: `${existingCardPrompt(input.existingCard)}\nAnalyze sources and design the best card from supported tabs only.\n\n${sourcePrompt(input.normalized)}`,
    images: input.normalized.images.slice(0, 4),
  })
  await logChatMeta('sol_architecture', result.meta, {
    userId: input.userId,
    sessionId: input.sessionId,
    jobId: input.sessionId,
    stage: 'ARCHITECTING',
    success: true,
  })

  const parsed = solEnvelopeSchema.parse(result.data)
  let profile = parsed.masterBusinessProfile
  const heuristicConflicts = detectSourceConflicts({
    websiteText: input.normalized.website.pages.map((p) => p.text).join('\n'),
    documentTexts: [...input.normalized.documents, ...input.normalized.ocrResults].map((d) => ({
      label: d.label,
      text: d.text,
    })),
    manualText: `${input.normalized.manualText}\n${input.normalized.userInstructions}`,
    profile,
  })
  if (heuristicConflicts.length && !profile.conflicts.length) {
    profile = { ...profile, conflicts: heuristicConflicts }
  }

  const codeTabs = decideRecommendedTabs(profile)
  const solNav = parsed.recommendedNavIds.filter(
    (id) => CATALOG_NAV.has(id) && id !== 'global-connection' && id !== 'my-info'
  )
  const reasonByNav = Object.fromEntries(parsed.tabReasons.map((row) => [row.navId, row.reason]))
  const mergedNav = [...new Set(['home', ...solNav, ...codeTabs.map((t) => t.navId)])]
  const recommendedTabs: RecommendedTab[] = mergedNav
    .map((navId, index) => {
      const catalog = TAB_CATALOG.find((t) => t.navId === navId)
      const fromCode = codeTabs.find((t) => t.navId === navId)
      if (!catalog) return null
      const tab: RecommendedTab = {
        type: navId,
        navId,
        name: catalog.name,
        enabled: true,
        order: index + 1,
        reason: reasonByNav[navId] || fromCode?.reason || `Fits this business — add ${catalog.name}.`,
        priority: fromCode?.priority || (index < 4 ? 'high' : 'medium'),
      }
      return tab
    })
    .filter((row): row is RecommendedTab => row !== null)

  const sourceMap: SolArchitecture['sourceMap'] = [
    { fieldKey: 'businessName', value: profile.businessName, source: 'WEBSITE' },
    { fieldKey: 'phone', value: profile.phone, source: 'WEBSITE' },
    { fieldKey: 'email', value: profile.email, source: 'WEBSITE' },
    { fieldKey: 'website', value: profile.website, source: 'WEBSITE' },
  ].filter((row) => row.value)

  return { masterBusinessProfile: profile, recommendedTabs, sourceMap }
}
