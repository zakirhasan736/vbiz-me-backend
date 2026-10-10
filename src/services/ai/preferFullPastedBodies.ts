/** Escape plain text for safe HTML paragraph wrapping. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Turn plain pasted paragraphs into rich-text HTML the card editor expects. */
export function plainTextToRichHtml(value: string): string {
  const text = value.replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  if (/<[a-z][\s\S]*>/i.test(text)) return text

  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  if (blocks.length <= 1) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  }

  return blocks.map((block) => `<p>${escapeHtml(block.replace(/\n+/g, ' '))}</p>`).join('')
}

/** Body after the title line when the paste is one article / item. */
export function bodyFromPastedText(pasted: string, titleHint: string): string {
  const lines = pasted.replace(/\r\n/g, '\n').trim().split('\n')
  if (!lines.length) return ''
  const first = (lines[0] || '').trim()
  const title = titleHint.trim()
  const firstNorm = first.toLowerCase()
  const titleNorm = title.toLowerCase()
  let start = 0
  if (
    titleNorm &&
    firstNorm &&
    (firstNorm === titleNorm || firstNorm.includes(titleNorm) || titleNorm.includes(firstNorm))
  ) {
    start = 1
  } else if (first.length > 0 && first.length < 140 && lines.length > 1) {
    start = 1
  }
  return lines.slice(start).join('\n').trim()
}

type BodyScope = 'blogs' | 'services' | 'portfolio' | 'faqs' | 'reviews'

const BODY_FIELD: Record<BodyScope, string> = {
  blogs: 'description',
  services: 'description',
  portfolio: 'description',
  faqs: 'answer',
  reviews: 'text',
}

const TITLE_FIELD: Record<BodyScope, string> = {
  blogs: 'title',
  services: 'title',
  portfolio: 'title',
  faqs: 'question',
  reviews: 'author',
}

function isBodyScope(scope: string): scope is BodyScope {
  return scope in BODY_FIELD
}

/**
 * When the model returns a short summary for a single pasted article/item,
 * restore the owner's full pasted body into the rich-text field.
 * Also wraps plain text bodies as HTML paragraphs for the editor.
 */
export function preferFullPastedBodies(
  scope: string,
  pastedText: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (!isBodyScope(scope)) return payload
  const items = payload[scope]
  if (!Array.isArray(items) || !items.length) return payload

  const bodyKey = BODY_FIELD[scope]
  const titleKey = TITLE_FIELD[scope]
  const paste = pastedText.replace(/\r\n/g, '\n').trim()

  if (paste && items.length === 1) {
    const item = items[0] as Record<string, unknown>
    const title = String(item[titleKey] || '')
    const aiBody = stripTags(String(item[bodyKey] || ''))
    const pasteBody = bodyFromPastedText(paste, title)
    if (
      pasteBody &&
      (pasteBody.length > aiBody.length + 40 ||
        (aiBody.length < 280 && pasteBody.length > Math.max(aiBody.length * 1.15, aiBody.length + 1)))
    ) {
      item[bodyKey] = plainTextToRichHtml(pasteBody)
      return payload
    }
  }

  for (const row of items) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const body = String(item[bodyKey] || '').trim()
    if (body && !/<[a-z][\s\S]*>/i.test(body)) {
      item[bodyKey] = plainTextToRichHtml(body)
    }
  }
  return payload
}
