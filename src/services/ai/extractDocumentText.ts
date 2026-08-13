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

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '-',
    mdash: '-',
  }
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m)
}

function cleanText(text: string): string {
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
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

function collectJsonStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (out.length >= 800) return out
  if (typeof value === 'string') {
    const text = cleanText(value)
    if (text.length >= 3 && text.length <= 1200 && !/^https?:\/\//i.test(text)) out.push(text)
    return out
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, seen)
    return out
  }
  for (const item of Object.values(value as Record<string, unknown>)) collectJsonStrings(item, out, seen)
  return out
}

function extractEmbeddedDataText(html: string): string {
  const chunks: string[] = []
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  for (const match of html.matchAll(scriptRe)) {
    const attrs = match[1] || ''
    const body = decodeHtmlEntities(match[2] || '').trim()
    if (!body) continue
    const isStructured =
      /application\/ld\+json|application\/json/i.test(attrs) || /id=["']__NEXT_DATA__["']/i.test(attrs)
    if (isStructured) {
      try {
        chunks.push(...collectJsonStrings(JSON.parse(body)))
        continue
      } catch {
        chunks.push(body.slice(0, 6000))
        continue
      }
    }
    if (/review|testimonial|service|portfolio|project|faq|question|blog|article|rating/i.test(body)) {
      const quoted = Array.from(body.matchAll(/["'`]([^"'`]{12,500})["'`]/g))
        .map((m) => cleanText(m[1]))
        .filter((text) => /[a-z]{4}/i.test(text) && !/^https?:\/\//i.test(text))
        .slice(0, 120)
      chunks.push(...quoted)
    }
  }
  return chunks.join(' ')
}

function extractAttributeText(html: string): string {
  const chunks: string[] = []
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  if (title) chunks.push(title)

  for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = meta[0]
    if (!/(description|og:title|og:description|twitter:title|twitter:description|review|rating)/i.test(tag)) continue
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1]
    if (content) chunks.push(content)
  }

  for (const attr of html.matchAll(
    /\b(?:alt|aria-label|title|data-title|data-name|data-description|data-content|data-text|data-review|data-testimonial|data-comment|data-author|data-rating)\s*=\s*["']([^"']{3,900})["']/gi
  )) {
    chunks.push(attr[1])
  }
  return chunks.map(cleanText).filter(Boolean).join(' ')
}

function stripHtmlFragment(fragment: string): string {
  return cleanText(
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
}

function extractCarouselAndReviewBlocks(html: string): string {
  const chunks: string[] = []
  const seen = new Set<string>()
  const marker =
    /review|reviews|testimonial|testimonials|rating|ratings|feedback|client|swiper-slide|slick-slide|carousel-item|splide__slide|glide__slide/i
  const blockRe = /<([a-z][\w:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi

  for (const match of html.matchAll(blockRe)) {
    if (chunks.length >= 90) break
    const attrs = match[2] || ''
    if (!marker.test(attrs)) continue

    const text = stripHtmlFragment(match[3] || '')
    if (text.length < 20) continue

    const key = text.toLowerCase().slice(0, 220)
    if (seen.has(key)) continue
    seen.add(key)

    const label = /review|testimonial|rating|feedback/i.test(`${attrs} ${text}`)
      ? 'REVIEW_TESTIMONIAL_BLOCK'
      : 'SLIDER_BLOCK'
    chunks.push(`${label} ${chunks.length + 1}: ${text.slice(0, 1200)}`)
  }

  return chunks.join(' ')
}

function htmlToText(html: string): string {
  const carouselBlocks = extractCarouselAndReviewBlocks(html)
  const embedded = extractEmbeddedDataText(html)
  const attributes = extractAttributeText(html)
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  return cleanText([carouselBlocks, visible, attributes, embedded].filter(Boolean).join(' '))
}

const SECTION_LINK_RE =
  /(?:about|service|services|offer|product|portfolio|project|work|case.?stud|gallery|blog|news|article|post|faq|question|review|testimonial|client|feedback|rating|contact|team|career|pricing|solution|detail|details|success|story|stories)/i

function focusRe(focus?: string): RegExp | null {
  const key = String(focus || '').toLowerCase()
  if (key === 'reviews') return /review|reviews|testimonial|testimonials|rating|ratings|feedback|client/i
  if (key === 'services') return /service|services|offer|offering|solution|product|pricing|package/i
  if (key === 'portfolio') return /portfolio|project|projects|case.?stud|gallery|work|detail/i
  if (key === 'blogs') return /blog|blogs|news|article|articles|post|posts|press/i
  if (key === 'faqs') return /faq|faqs|question|questions|help|support/i
  if (key === 'skills') return /skill|skills|expertise|capabilit|special/i
  if (key === 'education') return /education|school|degree|university|credential/i
  if (key === 'experience') return /experience|work|career|team|about|resume/i
  if (key === 'personal') return /about|contact|team|profile|bio|staff/i
  return null
}

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

function extractSameOriginLinks(html: string, baseUrl: string, focus?: string, limit = 12): string[] {
  const base = new URL(baseUrl)
  const hrefs = Array.from(html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1])
  const scored = new Map<string, number>()
  const focusPattern = focusRe(focus)

  for (const href of hrefs) {
    const abs = absolutize(href, base)
    if (!abs || abs === base.toString()) continue
    const parsed = new URL(abs)
    const path = parsed.pathname.toLowerCase()
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|mp4|mov|zip|css|js|ico|woff2?)$/i.test(path)) continue
    const target = `${path} ${parsed.search} ${href}`
    if (!SECTION_LINK_RE.test(target) && !(focusPattern && focusPattern.test(target))) continue
    let score = 1
    if (focusPattern && focusPattern.test(target)) score += 6
    if (/service|product|offer|pricing|solution/i.test(target)) score += 3
    if (/portfolio|project|gallery|case|detail/i.test(target)) score += 3
    if (/blog|news|article|post/i.test(target)) score += 3
    if (/faq|question/i.test(target)) score += 3
    if (/review|testimonial|rating|feedback/i.test(target)) score += 4
    if (/about|team|contact/i.test(target)) score += 2
    if (/[?&](?:page|p)=\d+/i.test(target) || /\/(?:page\/)?\d+\/?$/i.test(path)) score += 1
    scored.set(abs, Math.max(scored.get(abs) || 0, score))
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, limit)
}

/** Crawl homepage + related section pages (services, portfolio, blog, faq, reviews…). */
export async function crawlWebsiteDeep(
  url: string,
  focus?: string
): Promise<{ pages: Array<{ url: string; text: string }>; combined: string }> {
  const home = url.startsWith('http') ? url : `https://${url}`
  const homeHtml = await fetchHtml(home)
  const homeText = htmlToText(homeHtml)
  const pages: Array<{ url: string; text: string }> = [{ url: home, text: truncate(homeText, 14000) }]
  const visited = new Set<string>([home])
  const maxPages = focus ? 18 : 14

  async function fetchPage(link: string) {
    const html = await fetchHtml(link)
    return { url: link, html, text: truncate(htmlToText(html), focus ? 12000 : 9000) }
  }

  const firstLinks = extractSameOriginLinks(homeHtml, home, focus, focus ? 14 : 10).filter((link) => {
    if (visited.has(link)) return false
    visited.add(link)
    return true
  })

  const firstResults = await Promise.allSettled(firstLinks.map(fetchPage))
  const childLinks: string[] = []
  for (const result of firstResults) {
    if (result.status !== 'fulfilled') continue
    const page = result.value
    if (page.text.length > 80) pages.push({ url: page.url, text: page.text })
    childLinks.push(...extractSameOriginLinks(page.html, page.url, focus, 8))
  }

  const secondLinks = childLinks.filter((link) => {
    if (pages.length >= maxPages || visited.has(link)) return false
    visited.add(link)
    return true
  })

  if (pages.length < maxPages && secondLinks.length) {
    const remaining = secondLinks.slice(0, maxPages - pages.length)
    const secondResults = await Promise.allSettled(remaining.map(fetchPage))
    for (const result of secondResults) {
      if (result.status === 'fulfilled' && result.value.text.length > 80) {
        pages.push({ url: result.value.url, text: result.value.text })
      }
    }
  }

  const combined = pages.map((p, i) => `=== PAGE ${i + 1}: ${p.url} ===\n${p.text}`).join('\n\n')

  return { pages, combined: truncate(combined, focus ? 90000 : 70000) }
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
