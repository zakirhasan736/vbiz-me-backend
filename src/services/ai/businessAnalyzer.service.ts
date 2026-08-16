import { logChatMeta } from './aiUsageLog.service'
import {
  MASTER_PROFILE_JSON_INSTRUCTION,
  masterBusinessProfileSchema,
  type MasterBusinessProfile,
} from './businessProfile.schema'
import { detectSourceConflicts } from './conflictDetection'
import { assessComplexity, routeAiTier, type AiTier } from './modelRouter.service'
import { chatJson } from './openai.client'
import type { NormalizedSourceData } from './sourceNormalizer.service'

const PROFILE_SOURCE_CAP = 28000

function sourcePrompt(normalized: NormalizedSourceData): string {
  return normalized.extractedText.slice(0, PROFILE_SOURCE_CAP)
}

export async function analyzeMasterProfile(input: {
  normalized: NormalizedSourceData
  userId?: string
  sessionId?: string
}): Promise<{ profile: MasterBusinessProfile; tier: AiTier; escalatedFrom: AiTier | null }> {
  const ocrUsed = input.normalized.ocrResults.length > 0
  const ocrQualityPoor = input.normalized.ocrResults.some(
    (d) => d.extractionMethod === 'ocr_needed' || (d.text || '').length < 80
  )
  const pre = assessComplexity({
    sourceCount: 1 + input.normalized.documents.length + input.normalized.ocrResults.length,
    pageCount: input.normalized.website.pages.length,
    textLength: input.normalized.extractedText.length,
    ocrUsed,
    ocrQualityPoor,
    conflictingSources: false,
  })
  const firstRoute = routeAiTier({
    confidence: 0.92,
    complexity: pre.complexity,
    ocrQualityPoor,
  })

  const run = async (tier: AiTier, extra?: string) => {
    const result = await chatJson<unknown>({
      tier,
      temperature: 0.2,
      system: `You are a factual business analyst for vBiz Me digital cards. ${MASTER_PROFILE_JSON_INSTRUCTION}`,
      user: `${extra || ''}\nAnalyze these sources and extract a Master Business Profile.\n\n${sourcePrompt(input.normalized)}`,
      images: input.normalized.images.slice(0, 4),
    })
    await logChatMeta('business_analysis', result.meta, {
      userId: input.userId,
      sessionId: input.sessionId,
      success: true,
    })
    return masterBusinessProfileSchema.parse(result.data)
  }

  let profile = await run(firstRoute.tier)
  let escalatedFrom: AiTier | null = null
  let tier = firstRoute.tier

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

  const overall = profile.confidence?.overall ?? 0.5
  const needsTerra = overall < 0.9 || profile.conflicts.length > 0 || ocrQualityPoor || firstRoute.tier === 'terra'
  const needsSol = overall < 0.7 || (profile.conflicts.length > 1 && overall < 0.8)

  if (firstRoute.tier === 'luna' && needsTerra) {
    escalatedFrom = 'luna'
    const second = routeAiTier({
      confidence: overall,
      complexity: needsSol ? 'very_complex' : 'complex',
      conflictingSources: profile.conflicts.length > 0,
      ocrQualityPoor,
    })
    try {
      const focused =
        profile.conflicts.length > 0
          ? `Resolve only these conflicting fields if the sources allow; otherwise keep conflicts and leave the field null:\n${JSON.stringify(profile.conflicts)}\nCurrent profile:\n${JSON.stringify(profile).slice(0, 8000)}\n`
          : 'The first pass was uncertain. Re-extract facts only. Do not invent.\n'
      profile = await run(second.tier, focused)
      tier = second.tier
    } catch {
      /* keep Luna profile rather than failing the card */
    }
  } else if (tier === 'terra' && (profile.confidence?.overall ?? 1) < 0.55) {
    escalatedFrom = 'terra'
    try {
      profile = await run(
        'sol',
        'Previous analysis was still uncertain. Extract only facts that are clearly present.\n'
      )
      tier = 'sol'
    } catch {
      /* keep Terra profile */
    }
  }

  return { profile, tier, escalatedFrom }
}
