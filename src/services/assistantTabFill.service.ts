import config from '../configs/config'
import AppError from '../error/AppError'
import { prisma } from '../utils/prisma'
import { coerceServiceTypes, countFillEntries, fillSectionSchemas } from './ai/cardBlueprint.schema'
import { extractTextFromBuffer, type UploadedPart } from './ai/extractDocumentText'
import { chatJson } from './ai/openai.client'
import { buildTabFillSystemPrompt, parseSupportedTabScope } from './assistantPolicy'
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
}) {
  const scope = parseSupportedTabScope(input.scope)
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
  const system = buildTabFillSystemPrompt(scope)
  const userText = [
    `CURRENT PUBLIC CARD (context only; output remains limited to "${scope}"):\n${JSON.stringify(currentProfile)}`,
    pastedText ? `PASTED TEXT:\n${pastedText}` : '',
    ...prepared.textParts,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, 50_000)

  if (!userText.trim()) {
    throw new AppError(422, 'Could not read text from this source. Add clearer text or another file.')
  }

  const result = await chatJson<unknown>({
    model: config.OPENAI_TAB_FILL_MODEL,
    temperature: 0.2,
    system,
    user: userText,
  })
  const raw = result.data

  try {
    const schema = fillSectionSchemas[scope]
    const payload = schema.parse(scope === 'services' ? coerceServiceTypes(raw) : raw) as Record<string, unknown>
    const count = countFillEntries(scope, payload)
    if (count === 0 && files.length > 0 && !pastedText) {
      throw new AppError(422, `No usable data was found for the ${scope} section.`)
    }
    return {
      section: scope,
      payload,
      count,
      model: config.OPENAI_TAB_FILL_MODEL,
      requiresReview: true,
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(502, `GPT-4o returned an invalid structure for the ${scope} section.`)
  }
}

export { needsServerOcr }
