import logger from '../../utils/logger'
import { chatJson } from './openai.client'

const CHUNK_SIZE = 12_000
const CHUNK_OVERLAP = 500
/** Documents longer than this are read in sequential chunks before card planning. */
export const LONG_DOCUMENT_THRESHOLD = 35_000
const MAX_CHUNKS = 24
const MERGE_EXCERPT_HEAD = 8_000
const MERGE_EXCERPT_TAIL = 6_000

export type DocumentChunkFacts = {
  personal: string[]
  business: string[]
  services: string[]
  contact: string[]
  faqs: string[]
  about: string
  other: string[]
}

function emptyFacts(): DocumentChunkFacts {
  return { personal: [], business: [], services: [], contact: [], faqs: [], about: '', other: [] }
}

/** Split long document text into overlapping chunks so every section is read. */
export function splitDocumentChunks(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.split('\0').join('').trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(clean.length, start + size)
    chunks.push(clean.slice(start, end))
    if (end >= clean.length) break
    start = Math.max(0, end - overlap)
  }
  if (chunks.length >= MAX_CHUNKS && start + size < clean.length) {
    // Always keep the document ending (contact / closing) when we hit the chunk cap.
    chunks[chunks.length - 1] = clean.slice(-size)
  }
  return chunks
}

function uniqueLines(values: string[], limit = 40): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const line = value.replace(/\s+/g, ' ').trim()
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= limit) break
  }
  return out
}

function mergeFacts(parts: DocumentChunkFacts[]): DocumentChunkFacts {
  const merged = emptyFacts()
  const aboutParts: string[] = []
  for (const part of parts) {
    merged.personal.push(...(part.personal || []))
    merged.business.push(...(part.business || []))
    merged.services.push(...(part.services || []))
    merged.contact.push(...(part.contact || []))
    merged.faqs.push(...(part.faqs || []))
    merged.other.push(...(part.other || []))
    if (part.about?.trim()) aboutParts.push(part.about.trim())
  }
  return {
    personal: uniqueLines(merged.personal, 30),
    business: uniqueLines(merged.business, 40),
    services: uniqueLines(merged.services, 40),
    contact: uniqueLines(merged.contact, 30),
    faqs: uniqueLines(merged.faqs, 20),
    about: aboutParts.join('\n\n').slice(0, 6_000),
    other: uniqueLines(merged.other, 40),
  }
}

function formatFactsBlock(
  label: string,
  facts: DocumentChunkFacts,
  chunksRead: number,
  originalLength: number
): string {
  const lines = [
    `FULL DOCUMENT READ COMPLETE for “${label}” (${originalLength} chars across ${chunksRead} section(s)).`,
    'These facts were extracted by reading the entire document in order — use them for the card.',
    facts.personal.length ? `PERSONAL / PEOPLE:\n- ${facts.personal.join('\n- ')}` : '',
    facts.contact.length ? `CONTACT:\n- ${facts.contact.join('\n- ')}` : '',
    facts.business.length ? `BUSINESS FACTS:\n- ${facts.business.join('\n- ')}` : '',
    facts.services.length ? `SERVICES / OFFERS:\n- ${facts.services.join('\n- ')}` : '',
    facts.about ? `ABOUT / STORY:\n${facts.about}` : '',
    facts.faqs.length ? `FAQ CANDIDATES:\n- ${facts.faqs.join('\n- ')}` : '',
    facts.other.length ? `OTHER USEFUL FACTS:\n- ${facts.other.join('\n- ')}` : '',
  ]
  return lines.filter(Boolean).join('\n\n')
}

function documentBookends(text: string): string {
  if (text.length <= MERGE_EXCERPT_HEAD + MERGE_EXCERPT_TAIL) return text
  return `${text.slice(0, MERGE_EXCERPT_HEAD)}\n\n[…middle kept in section reads above…]\n\n${text.slice(-MERGE_EXCERPT_TAIL)}`
}

async function extractFactsFromChunk(input: {
  label: string
  chunkIndex: number
  chunkTotal: number
  chunk: string
}): Promise<DocumentChunkFacts> {
  try {
    const result = await chatJson<DocumentChunkFacts>({
      tier: 'luna',
      temperature: 0,
      maxCompletionTokens: 1_800,
      system: `You extract factual business-card material from one section of a longer document.
Return JSON only with keys: personal (string[]), business (string[]), services (string[]), contact (string[]), faqs (string[]), about (string), other (string[]).
Capture names, titles, emails, phones, addresses, company, services, pricing mentions, about/story, and FAQ-like Q&A.
Do not invent facts. Empty arrays/strings when nothing is present in THIS section.`,
      user: `Document “${input.label}” — section ${input.chunkIndex + 1} of ${input.chunkTotal}:\n\n${input.chunk}`,
    })
    const data = result.data || emptyFacts()
    return {
      personal: Array.isArray(data.personal) ? data.personal.map(String) : [],
      business: Array.isArray(data.business) ? data.business.map(String) : [],
      services: Array.isArray(data.services) ? data.services.map(String) : [],
      contact: Array.isArray(data.contact) ? data.contact.map(String) : [],
      faqs: Array.isArray(data.faqs) ? data.faqs.map(String) : [],
      about: typeof data.about === 'string' ? data.about : '',
      other: Array.isArray(data.other) ? data.other.map(String) : [],
    }
  } catch (error) {
    logger.warn('document_chunk_read_failed', {
      label: input.label,
      chunkIndex: input.chunkIndex,
      error: error instanceof Error ? error.message : String(error),
    })
    return emptyFacts()
  }
}

/**
 * Read an entire long PDF/text document in chunks, then produce a planner-ready
 * synthesis. Short documents are returned unchanged.
 */
export async function readDocumentFullyForCardBuilder(input: {
  label: string
  text: string
}): Promise<{ text: string; fullyRead: boolean; chunksRead: number }> {
  const raw = input.text.split('\0').join('').trim()
  if (!raw) return { text: '', fullyRead: false, chunksRead: 0 }
  if (raw.length <= LONG_DOCUMENT_THRESHOLD) {
    return { text: raw, fullyRead: true, chunksRead: 1 }
  }

  const chunks = splitDocumentChunks(raw)
  logger.info('document_full_read_start', {
    label: input.label,
    chars: raw.length,
    chunks: chunks.length,
  })

  const factsParts: DocumentChunkFacts[] = []
  // Sequential reads keep order and avoid rate-limit bursts on large PDFs.
  for (let i = 0; i < chunks.length; i += 1) {
    factsParts.push(
      await extractFactsFromChunk({
        label: input.label,
        chunkIndex: i,
        chunkTotal: chunks.length,
        chunk: chunks[i],
      })
    )
  }

  const merged = mergeFacts(factsParts)
  const synthesis = formatFactsBlock(input.label, merged, chunks.length, raw.length)
  const bookends = documentBookends(raw)
  const text = `${synthesis}\n\n---\nORIGINAL DOCUMENT BOOKENDS (beginning + ending):\n${bookends}`

  logger.info('document_full_read_complete', {
    label: input.label,
    chars: raw.length,
    chunks: chunks.length,
    synthesisChars: text.length,
  })

  return { text, fullyRead: true, chunksRead: chunks.length }
}
