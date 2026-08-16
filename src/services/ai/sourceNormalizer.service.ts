import type { MasterBusinessProfile } from './businessProfile.schema'
import {
  crawlWebsiteDeep,
  extractTextFromBuffer,
  type UploadedPart,
  type WebsitePageCategory,
} from './extractDocumentText'

export type NormalizedDocument = {
  id: string
  label: string
  extractionMethod: string
  text: string
  warning?: string
  sha256?: string
}

export type NormalizedSourceData = {
  userInstructions: string
  manualText: string
  website: {
    url: string
    pages: Array<{ url: string; category: WebsitePageCategory; text: string }>
    scrapeFailed?: boolean
    scrapeError?: string
  }
  documents: NormalizedDocument[]
  ocrResults: NormalizedDocument[]
  extractedText: string
  images: Array<{ mimeType: string; base64: string }>
  warnings: string[]
}

function splitInstructions(businessText: string): { userInstructions: string; manualText: string } {
  const text = businessText.trim()
  if (!text) return { userInstructions: '', manualText: '' }
  if (/^(please|make|rewrite|focus|emphasize|tone|do not|don't|use|write)\b/i.test(text) && text.length < 800) {
    return { userInstructions: text, manualText: '' }
  }
  return { userInstructions: '', manualText: text }
}

export async function normalizeSources(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  sectionFocus?: string
}): Promise<NormalizedSourceData> {
  const websiteUrl = (input.websiteUrl || '').trim()
  const { userInstructions, manualText } = splitInstructions(input.businessText || '')
  const warnings: string[] = []
  const documents: NormalizedDocument[] = []
  const ocrResults: NormalizedDocument[] = []
  const images: Array<{ mimeType: string; base64: string }> = []
  const textParts: string[] = []

  const website: NormalizedSourceData['website'] = { url: websiteUrl, pages: [] }

  if (websiteUrl) {
    try {
      const crawled = await crawlWebsiteDeep(websiteUrl, input.sectionFocus)
      website.pages = crawled.pages
      textParts.push(`WEBSITE URL: ${websiteUrl}\nCRAWLED ${crawled.pages.length} PAGE(S):\n${crawled.combined}`)
    } catch (e) {
      website.scrapeFailed = true
      website.scrapeError = e instanceof Error ? e.message : 'Website could not be read'
      warnings.push('The website could not be read. Other sources will still be used.')
      textParts.push(`WEBSITE URL: ${websiteUrl}\n(Could not crawl site: ${website.scrapeError}.)`)
    }
  }

  if (userInstructions) textParts.push(`USER INSTRUCTIONS:\n${userInstructions}`)
  if (manualText) textParts.push(`TYPED BUSINESS INFORMATION:\n${manualText}`)

  for (const [index, file] of (input.files || []).entries()) {
    const extracted = await extractTextFromBuffer(file)
    const doc: NormalizedDocument = {
      id: extracted.sha256 || `doc-${index + 1}`,
      label: extracted.label,
      extractionMethod: extracted.extractionMethod,
      text: extracted.text,
      warning: extracted.warning,
      sha256: extracted.sha256,
    }
    if (extracted.warning) warnings.push(extracted.warning)
    images.push(...extracted.images)
    if (extracted.extractionMethod === 'ocr' || extracted.extractionMethod === 'ocr_needed') {
      ocrResults.push(doc)
    } else {
      documents.push(doc)
    }
    textParts.push(`DOCUMENT “${extracted.label}” [${extracted.extractionMethod}]:\n${extracted.text}`)
  }

  return {
    userInstructions,
    manualText,
    website,
    documents,
    ocrResults,
    extractedText: textParts.join('\n\n---\n\n'),
    images,
    warnings,
  }
}

export function compactProfileForPrompt(profile: MasterBusinessProfile, max = 14000): string {
  const json = JSON.stringify(profile)
  if (json.length <= max) return json
  return `${json.slice(0, max)}\n[truncated profile]`
}
