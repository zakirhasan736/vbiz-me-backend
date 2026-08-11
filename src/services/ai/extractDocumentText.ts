import mammoth from 'mammoth'
import AppError from '../../error/AppError'
import { MAX_FILES, MAX_UPLOAD_BYTES } from './openai.client'

export type ExtractedSource = {
  label: string
  text: string
  images: Array<{ mimeType: string; base64: string }>
}

export type UploadedPart = {
  name: string
  mimeType: string
  buffer: Buffer
}

function truncate(text: string, max = 24000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[Truncated…]`
}

export function assertUploadLimits(files: UploadedPart[]) {
  if (files.length > MAX_FILES) {
    throw new AppError(400, `Too many files (max ${MAX_FILES}).`)
  }
  for (const f of files) {
    if (f.buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new AppError(400, `File “${f.name}” exceeds ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit.`)
    }
  }
}

export async function extractTextFromBuffer(file: UploadedPart): Promise<ExtractedSource> {
  const mime = (file.mimeType || '').toLowerCase()
  const name = file.name || 'upload'

  if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv')) {
    return { label: name, text: truncate(file.buffer.toString('utf8')), images: [] }
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer })
    return { label: name, text: truncate(result.value || ''), images: [] }
  }

  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfParseMod = await import('pdf-parse')
    const pdfParse = (pdfParseMod as { default?: (b: Buffer) => Promise<{ text: string }> }).default || pdfParseMod
    const parsed = await (pdfParse as (b: Buffer) => Promise<{ text: string }>)(file.buffer)
    return { label: name, text: truncate(parsed.text || ''), images: [] }
  }

  if (mime.startsWith('image/')) {
    return {
      label: name,
      text: `[Image attached: ${name}. Use vision to OCR / extract business details.]`,
      images: [{ mimeType: mime || 'image/jpeg', base64: file.buffer.toString('base64') }],
    }
  }

  return { label: name, text: truncate(file.buffer.toString('utf8')), images: [] }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'vBizCardAgent/1.0 (+https://vbiz.me)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new AppError(400, `Website fetch failed (${res.status}) for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const SECTION_LINK_RE =
  /(?:about|service|services|offer|product|portfolio|project|work|case.?stud|gallery|blog|news|article|post|faq|question|review|testimonial|client|contact|team|career|pricing|solution)/i

function absolutize(href: string, base: URL): string | null {
  try {
    if (
      !href ||
      href.startsWith('#') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:')
    ) {
      return null
    }
    const abs = new URL(href, base)
    if (abs.hostname !== base.hostname) return null
    abs.hash = ''
    return abs.toString()
  } catch {
    return null
  }
}

function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const hrefs = Array.from(html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1])
  const scored = new Map<string, number>()

  for (const href of hrefs) {
    const abs = absolutize(href, base)
    if (!abs || abs === base.toString()) continue
    const path = new URL(abs).pathname.toLowerCase()
    if (!SECTION_LINK_RE.test(path) && !SECTION_LINK_RE.test(href)) continue
    let score = 1
    if (/service|product|offer|pricing|solution/i.test(path)) score += 3
    if (/portfolio|project|gallery|case/i.test(path)) score += 3
    if (/blog|news|article/i.test(path)) score += 3
    if (/faq|question/i.test(path)) score += 3
    if (/review|testimonial/i.test(path)) score += 3
    if (/about|team|contact/i.test(path)) score += 2
    scored.set(abs, Math.max(scored.get(abs) || 0, score))
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, 8)
}

/** Crawl homepage + related section pages (services, portfolio, blog, faq, reviews…). */
export async function crawlWebsiteDeep(
  url: string
): Promise<{ pages: Array<{ url: string; text: string }>; combined: string }> {
  const home = url.startsWith('http') ? url : `https://${url}`
  const homeHtml = await fetchHtml(home)
  const homeText = htmlToText(homeHtml)
  const pages: Array<{ url: string; text: string }> = [{ url: home, text: truncate(homeText, 12000) }]

  const links = extractSameOriginLinks(homeHtml, home)
  const results = await Promise.allSettled(
    links.map(async (link) => {
      const html = await fetchHtml(link)
      return { url: link, text: truncate(htmlToText(html), 8000) }
    })
  )

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.text.length > 80) {
      pages.push(result.value)
    }
  }

  const combined = pages.map((p, i) => `=== PAGE ${i + 1}: ${p.url} ===\n${p.text}`).join('\n\n')

  return { pages, combined: truncate(combined, 48000) }
}

/** @deprecated Prefer crawlWebsiteDeep for analyze. */
export async function fetchWebsiteText(url: string): Promise<string> {
  const crawled = await crawlWebsiteDeep(url)
  return crawled.combined
}

export function filesFromMulter(files: Express.Multer.File[] | undefined): UploadedPart[] {
  const parts = (files || []).map((f) => ({
    name: f.originalname || 'upload',
    mimeType: f.mimetype || 'application/octet-stream',
    buffer: f.buffer,
  }))
  assertUploadLimits(parts)
  return parts
}
