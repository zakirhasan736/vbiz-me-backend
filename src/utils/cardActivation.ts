export type CardActivationInput = {
  slug?: unknown
  name?: unknown
  email?: unknown
  dob?: unknown
  phone?: unknown
}

export type CardActivationIssue = {
  field: keyof CardActivationInput
  label: string
  reason: 'missing' | 'invalid'
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function normalizeCardPhone(value: unknown): string {
  return text(value).replace(/\D/g, '')
}

export function normalizeCardEmail(value: unknown): string {
  return text(value).toLowerCase()
}

export function cardDateOnly(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  }
  return text(value)
}

function isValidBirthDate(value: unknown): boolean {
  const normalized = cardDateOnly(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) return false
  return parsed.getTime() <= Date.now()
}

export function collectCardActivationIssues(input: CardActivationInput): CardActivationIssue[] {
  const required: Array<[keyof CardActivationInput, string]> = [
    ['slug', 'URL slug'],
    ['name', 'Name'],
    ['email', 'Email'],
    ['dob', 'Date of birth'],
    ['phone', 'Phone'],
  ]
  const issues: CardActivationIssue[] = required
    .filter(([field]) => (field === 'dob' ? !cardDateOnly(input[field]) : !text(input[field])))
    .map(([field, label]) => ({ field, label, reason: 'missing' as const }))

  if (text(input.email) && !EMAIL_PATTERN.test(text(input.email))) {
    issues.push({ field: 'email', label: 'Email', reason: 'invalid' })
  }
  const phone = normalizeCardPhone(input.phone)
  if (text(input.phone) && (phone.length < 7 || phone.length > 15)) {
    issues.push({ field: 'phone', label: 'Phone', reason: 'invalid' })
  }
  if (cardDateOnly(input.dob) && !isValidBirthDate(input.dob)) {
    issues.push({ field: 'dob', label: 'Date of birth', reason: 'invalid' })
  }
  return issues
}

export function cardActivationIssueMessage(issues: CardActivationIssue[]): string {
  const missing = issues.filter((issue) => issue.reason === 'missing').map((issue) => issue.label)
  const invalid = issues.filter((issue) => issue.reason === 'invalid').map((issue) => issue.label)
  const parts: string[] = []
  if (missing.length) parts.push(`complete ${missing.join(', ')}`)
  if (invalid.length) parts.push(`correct ${invalid.join(', ')}`)
  return `Card cannot be activated. Please ${parts.join(' and ')}.`
}
