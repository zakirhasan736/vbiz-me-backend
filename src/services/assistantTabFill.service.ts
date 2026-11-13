import AppError from '../error/AppError'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { coerceServiceTypes, countFillEntries, fillSectionSchemas } from './ai/cardBlueprint.schema'
import { extractTextFromBuffer, type UploadedPart } from './ai/extractDocumentText'
import { getModelForTier, selectFillSectionModel } from './ai/modelRouter.service'
import { normalizeFillPayload } from './ai/normalizeFillPayload'
import { chatJson } from './ai/openai.client'
import { preferFullPastedBodies } from './ai/preferFullPastedBodies'
import {
  buildTabFillSystemPrompt,
  parseSupportedTabScope,
  parseTabFillBodyMode,
  type TabFillBodyMode,
} from './assistantPolicy'
import { extractWithOcrFallback, needsServerOcr } from './documentOcr.service'

export async function prepareTabFillSources(files: UploadedPart[]) {
  const textParts: string[] = []
  for (const file of files) {
    const extracted = await extractTextFromBuffer(file)
    if (extracted.extractionMethod === 'unsupported') {
      throw new AppError(400, `Unsupported file type for “${file.name}”.`)
    }
    const text = needsServerOcr(extracted)
      ? await extractWithOcrFallback(file, extracted.extractionMethod === 'ocr_needed' ? 'scanned PDF' : 'image')
      : extracted.text.trim()
    if (text) textParts.push(`DOCUMENT “${extracted.label}”:\n${text}`)
  }
  return { textParts }
}

export async function fillProfileSection(input: {
  profileId: string
  scope: unknown
  text?: string
  files?: UploadedPart[]
  /** as_written (default) keeps full pasted body; summarize asks AI for a short polished body. */
  bodyMode?: unknown
}) {
  const scope = parseSupportedTabScope(input.scope)
  const bodyMode: TabFillBodyMode = parseTabFillBodyMode(input.bodyMode)
  const pastedText = String(input.text || '').trim()
  const files = input.files || []
  if (!pastedText && !files.length) throw new AppError(400, 'Provide pasted text and/or supported files.')

  const currentProfile = await prisma.profile.findUnique({
    where: { id: input.profileId },
    select: {
      name: true,
      lastName: true,
      prof: true,
      designation: true,
      companyName: true,
      website: true,
      address: true,
      about: true,
    },
  })
  if (!currentProfile) throw new AppError(404, 'Profile not found')

  const prepared = await prepareTabFillSources(files)
  const system = buildTabFillSystemPrompt(scope, bodyMode)
  const userText = [
    `CURRENT PUBLIC CARD (context only; output remains limited to "${scope}"):\n${JSON.stringify(currentProfile)}`,
    `BODY MODE: ${bodyMode === 'summarize' ? 'summarize (short polished body)' : 'as_written (keep full pasted wording)'}`,
    pastedText ? `PASTED TEXT:\n${pastedText}` : '',
    ...prepared.textParts,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, 50_000)

  if (!userText.trim()) {
    throw new AppError(422, 'Could not read text from this source. Add clearer text or another file.')
  }

  const fillRoute = selectFillSectionModel(scope)
  const schema = fillSectionSchemas[scope]
  const parseModelOutput = (raw: unknown) => {
    const normalized = normalizeFillPayload(scope, raw)
    return schema.safeParse(scope === 'services' ? coerceServiceTypes(normalized) : normalized)
  }

  const first = await chatJson<unknown>({
    tier: fillRoute.tier,
    temperature: bodyMode === 'summarize' ? 0.35 : 0.2,
    system,
    user: userText,
  })
  let outcome = parseModelOutput(first.data)

  if (!outcome.success) {
    // The shape was beyond repair. Ask once more, strictly, before bothering the owner.
    logger.warn('fill-section: model output did not match the section shape; retrying', {
      scope,
      bodyMode,
      issues: outcome.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      sample: JSON.stringify(first.data ?? null).slice(0, 600),
    })
    const retry = await chatJson<unknown>({
      tier: fillRoute.tier,
      temperature: 0,
      system,
      user: `${userText}\n\n---\n\nIMPORTANT: Your previous answer did not match the required JSON shape. Return ONLY the JSON object in the exact shape from the instructions: same key names, strings for text ("" when unknown, never null), "rating" as a whole number from 1 to 5.`,
    })
    outcome = parseModelOutput(retry.data)
    if (!outcome.success) {
      logger.error('fill-section: model output invalid after retry', {
        scope,
        bodyMode,
        issues: outcome.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        sample: JSON.stringify(retry.data ?? null).slice(0, 600),
      })
      throw new AppError(502, `AI returned an invalid structure for the ${scope} section.`)
    }
  }

  const parsedRaw = outcome.data as Record<string, unknown>
  // Only restore the owner's full paste when they chose "as I wrote".
  const parsed =
    bodyMode === 'as_written'
      ? preferFullPastedBodies(scope, pastedText, parsedRaw)
      : preferFullPastedBodies(scope, '', parsedRaw)
  if (scope === 'faqs' || scope === 'blogs' || scope === 'reviews') {
    parsed[scope] = Array.isArray(parsed[scope]) ? parsed[scope] : []
  }
  const count = countFillEntries(scope, parsed)
  if (count === 0 && files.length > 0 && !pastedText) {
    throw new AppError(422, `No usable data was found for the ${scope} section.`)
  }
  return {
    section: scope,
    payload: parsed,
    count,
    model: getModelForTier(fillRoute.tier),
    requiresReview: true,
  }
}

export { needsServerOcr }
