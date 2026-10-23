import OpenAI from 'openai'
import config from '../configs/config'
import AppError from '../error/AppError'
import type { ExtractedSource, UploadedPart } from './ai/extractDocumentText'
import { getModelForTier } from './ai/modelRouter.service'
import { createOpenAIClient, MAX_DOCUMENT_EXTRACT_CHARS } from './ai/openai.client'

type ResponseInputContent = OpenAI.Responses.ResponseInputContent

function fileContent(file: UploadedPart): ResponseInputContent {
  if (file.mimeType.startsWith('image/')) {
    return {
      type: 'input_image',
      detail: 'auto',
      image_url: `data:${file.mimeType};base64,${file.buffer.toString('base64')}`,
    }
  }
  return {
    type: 'input_file',
    filename: file.name,
    file_data: `data:${file.mimeType || 'application/pdf'};base64,${file.buffer.toString('base64')}`,
  }
}

export function needsServerOcr(extracted: Pick<ExtractedSource, 'extractionMethod'>): boolean {
  return extracted.extractionMethod === 'ocr' || extracted.extractionMethod === 'ocr_needed'
}

export async function ocrWithFallback(
  run: (model: string) => Promise<string>,
  primaryModel: string,
  fallbackModel: string
): Promise<string> {
  try {
    return await run(primaryModel)
  } catch (primaryError) {
    if (!fallbackModel || fallbackModel === primaryModel) throw primaryError
    return run(fallbackModel)
  }
}

async function extractWithModel(file: UploadedPart, purpose: string, model: string): Promise<string> {
  const client = createOpenAIClient()
  const parts: string[] = []
  // Large scanned PDFs often exceed one OCR pass — continue until the model stops adding content.
  for (let pass = 0; pass < 5; pass += 1) {
    let response: OpenAI.Responses.Response
    try {
      const continueFrom = parts.length
        ? `\nContinue extracting from where this left off (do not repeat prior text):\n"""${parts.join('\n').slice(-1_200)}"""`
        : ''
      response = await client.responses.create({
        model,
        max_output_tokens: 12_000,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Extract all readable factual text from this ${purpose}. Preserve headings and list boundaries. Do not infer missing text and do not add commentary. Cover the full document, not just the first pages.${continueFrom}`,
              },
              fileContent(file),
            ],
          },
        ],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR failed'
      if (parts.length) break
      if (/unsupported|invalid.*file|cannot.*process/i.test(message)) {
        throw new AppError(422, `Could not OCR “${file.name}”. Upload clearer images or paste the text.`)
      }
      throw new AppError(502, `OCR service could not read “${file.name}”. Please try again.`)
    }

    const text = response.output_text.trim()
    if (!text || text.length < 2) {
      if (parts.length) break
      throw new AppError(422, `No readable text was found in “${file.name}”. Upload a clearer file or paste the text.`)
    }
    const prior = parts.join('\n\n')
    // Stop when the model repeats itself or adds only a tiny delta.
    if (prior && (prior.includes(text.slice(0, 200)) || text.length < 400)) break
    parts.push(text)
    if (parts.join('\n\n').length >= MAX_DOCUMENT_EXTRACT_CHARS) break
    if (text.length < 3_500) break
  }

  const merged = parts.join('\n\n').trim()
  if (!merged) {
    throw new AppError(422, `No readable text was found in “${file.name}”. Upload a clearer file or paste the text.`)
  }
  return merged.slice(0, MAX_DOCUMENT_EXTRACT_CHARS)
}

export async function extractWithOcrFallback(file: UploadedPart, purpose: string): Promise<string> {
  return ocrWithFallback(
    (model) => extractWithModel(file, purpose, model),
    config.OPENAI_TAB_FILL_MODEL || 'gpt-4o',
    getModelForTier('terra')
  )
}

export async function extractWithGpt4o(file: UploadedPart, purpose: string): Promise<string> {
  return extractWithOcrFallback(file, purpose)
}
