import s3Utils from '../../utils/s3'
import { extractWithOcrFallback, needsServerOcr } from '../documentOcr.service'
import type { MasterBusinessProfile } from './businessProfile.schema'
import {
  crawlWebsiteDeep,
  extractTextFromBuffer,
  type UploadedPart,
  type WebsitePageCategory,
} from './extractDocumentText'
import { normalizeWebsiteUrl } from './sourceUrl'

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
    pages: Array<{ url: string; category: WebsitePageCategory; text: string; title?: string; imageUrls?: string[] }>
    scrapeFailed?: boolean
    scrapeError?: string
  }
  documents: NormalizedDocument[]
  ocrResults: NormalizedDocument[]
  extractedText: string
  images: Array<{ mimeType: string; base64: string }>
  warnings: string[]
}

export function emptyNormalizedSources(websiteUrl = ''): NormalizedSourceData {
  return {
    userInstructions: '',
    manualText: '',
    website: { url: websiteUrl, pages: [] },
    documents: [],
    ocrResults: [],
    extractedText: '',
    images: [],
    warnings: [],
  }
}

function splitInstructions(businessText: string): { userInstructions: string; manualText: string } {
  const text = businessText.trim()
  if (!text) return { userInstructions: '', manualText: '' }
  if (/^(please|make|rewrite|focus|emphasize|tone|do not|don't|use|write)\b/i.test(text) && text.length < 800) {
    return { userInstructions: text, manualText: '' }
  }
  return { userInstructions: '', manualText: text }
}

function isListingPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
    return /^\/?(blog|blogs|news|articles|posts|press|portfolio|projects|gallery|work|our-work)$/i.test(path)
  } catch {
    return false
  }
}

function excerptForCard(text: string, max = 700): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max).replace(/\s+\S*$/, '')}…`
}

/** If SOL missed real site articles/projects, copy them onto the card from the crawl. */
export function seedProfileFromCrawledPages(
  profile: MasterBusinessProfile,
  pages: NormalizedSourceData['website']['pages']
): MasterBusinessProfile {
  const next = { ...profile }
  if (!(next.blogs || []).length) {
    const articles = pages
      .filter((page) => page.category === 'blog' && !isListingPath(page.url))
      .slice(0, 8)
      .map((page) => ({
        title: (page.title || page.url).slice(0, 180),
        description: excerptForCard(page.text),
        url: page.url,
        imageUrl: page.imageUrls?.[0] || '',
        category: 'News',
      }))
      .filter((item) => item.title.trim())
    if (articles.length) next.blogs = articles
  }
  if (!(next.portfolio || []).length) {
    const projects = pages
      .filter((page) => page.category === 'portfolio' && !isListingPath(page.url))
      .slice(0, 12)
      .map((page) => ({
        title: (page.title || page.url).slice(0, 180),
        description: excerptForCard(page.text),
        url: page.url,
        imageUrl: page.imageUrls?.[0] || '',
      }))
      .filter((item) => item.title.trim())
    if (projects.length) next.portfolio = projects
  }
  return next
}

function articleBlock(
  pages: Array<{ url: string; category: WebsitePageCategory; text: string; title?: string; imageUrls?: string[] }>,
  category: 'blog' | 'portfolio'
): string {
  const items = pages.filter((page) => page.category === category)
  if (!items.length) return ''
  const label =
    category === 'blog' ? 'EXTRACTED SITE ARTICLES (place on News/Blogs)' : 'EXTRACTED PORTFOLIO / PROJECT PAGES'
  return `${label}:\n${items
    .slice(0, 12)
    .map((page, index) => {
      const image = page.imageUrls?.[0] ? `\n  IMAGE: ${page.imageUrls[0]}` : ''
      const title = page.title || page.url
      return `${index + 1}. TITLE: ${title}\n  URL: ${page.url}${image}\n  CONTENT: ${excerptForCard(page.text, 900)}`
    })
    .join('\n')}`
}

async function mirrorRemoteImages(urls: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(urls.filter(Boolean))].slice(0, 8)
  const mapped = new Map<string, string>()
  for (const url of unique) {
    try {
      const uploaded = await Promise.race([
        s3Utils.uploadFromUrl(url, { folder: 'vbizme/ai-source', resourceType: 'image' }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('image mirror timeout')), 15_000)
        }),
      ])
      mapped.set(url, uploaded.url)
    } catch {
      mapped.set(url, url)
    }
  }
  return mapped
}

async function extractFileWithOcr(file: UploadedPart) {
  const extracted = await extractTextFromBuffer(file)
  if (!needsServerOcr(extracted)) return extracted
  try {
    const purpose = extracted.extractionMethod === 'ocr_needed' ? 'scanned PDF' : 'image'
    const text = await extractWithOcrFallback(file, purpose)
    return {
      ...extracted,
      text: text.slice(0, 24_000),
      extractionMethod: 'ocr' as const,
      warning: undefined,
    }
  } catch (error) {
    return {
      ...extracted,
      warning:
        extracted.warning ||
        (error instanceof Error ? error.message : 'OCR could not read this file. Other sources will still be used.'),
    }
  }
}

export async function normalizeSources(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  sectionFocus?: string
}): Promise<NormalizedSourceData> {
  const rawUrl = (input.websiteUrl || '').trim()
  const websiteUrl = rawUrl ? normalizeWebsiteUrl(rawUrl) : ''
  const { userInstructions, manualText } = splitInstructions(input.businessText || '')
  const warnings: string[] = []
  const documents: NormalizedDocument[] = []
  const ocrResults: NormalizedDocument[] = []
  const images: Array<{ mimeType: string; base64: string }> = []
  const textParts: string[] = []
  const website: NormalizedSourceData['website'] = { url: websiteUrl, pages: [] }

  const websiteTask = websiteUrl
    ? crawlWebsiteDeep(websiteUrl, input.sectionFocus).then(
        (crawled) => ({ ok: true as const, crawled }),
        (error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : 'Website could not be read',
        })
      )
    : Promise.resolve(null)

  const filesTask = Promise.all((input.files || []).map((file) => extractFileWithOcr(file)))

  const [websiteResult, fileResults] = await Promise.all([websiteTask, filesTask])

  if (websiteResult?.ok) {
    const crawled = websiteResult.crawled
    const imageCandidates = crawled.pages.flatMap((page) =>
      page.category === 'blog' || page.category === 'portfolio' ? page.imageUrls || [] : []
    )
    const mirrored = await mirrorRemoteImages(imageCandidates)
    website.pages = crawled.pages.map((page) => ({
      ...page,
      imageUrls: (page.imageUrls || []).map((url) => mirrored.get(url) || url),
    }))
    textParts.push(`WEBSITE URL: ${websiteUrl}\nCRAWLED ${website.pages.length} PAGE(S):\n${crawled.combined}`)
    const articles = articleBlock(website.pages, 'blog')
    const projects = articleBlock(website.pages, 'portfolio')
    if (articles) textParts.push(articles)
    if (projects) textParts.push(projects)
  } else if (websiteResult && !websiteResult.ok) {
    website.scrapeFailed = true
    website.scrapeError = 'WEBSITE_FETCH_FAILED'
    warnings.push('The website could not be read. Other sources will still be used.')
    textParts.push(`WEBSITE URL: ${websiteUrl}\n(Could not crawl the public pages.)`)
  }

  if (userInstructions) textParts.push(`USER INSTRUCTIONS (high-trust owner direction):\n${userInstructions}`)
  if (manualText) {
    textParts.push(
      `OWNER-PROVIDED BUSINESS INFORMATION (high-trust; prefer these facts over weaker website guesses):\n${manualText}`
    )
  }

  for (const [index, extracted] of fileResults.entries()) {
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

export function compactProfileForPrompt(profile: MasterBusinessProfile, max = 20000): string {
  const json = JSON.stringify(profile)
  if (json.length <= max) return json
  return `${json.slice(0, max)}\n[truncated profile]`
}
