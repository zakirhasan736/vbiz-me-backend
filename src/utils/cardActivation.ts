export const MIN_CARD_AGE_YEARS = 12

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
  reason: 'missing' | 'invalid' | 'underage'
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateOnly(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function minCardAgeCutoffDate(now = new Date()): string {
  return localDateOnly(new Date(now.getFullYear() - MIN_CARD_AGE_YEARS, now.getMonth(), now.getDate()))
}

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

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function birthDateIssueReason(value: unknown): 'invalid' | 'underage' | null {
  const normalized = cardDateOnly(value)
  if (!isCalendarDate(normalized) || normalized > localDateOnly()) return 'invalid'
  if (normalized > minCardAgeCutoffDate()) return 'underage'
  return null
}

export function collectCardActivationIssues(input: CardActivationInput): CardActivationIssue[] {
  const required: Array<[keyof CardActivationInput, string]> = [
    ['slug', 'URL slug'],
    ['name', 'Name'],
    ['email', 'Email'],
    ['dob', 'Date of birth'],
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
  if (cardDateOnly(input.dob)) {
    const reason = birthDateIssueReason(input.dob)
    if (reason) {
      issues.push({ field: 'dob', label: 'Date of birth', reason })
    }
  }
  return issues
}

export function collectCardCreationIssues(input: Pick<CardActivationInput, 'dob'>): CardActivationIssue[] {
  const dob = cardDateOnly(input.dob)
  if (!dob) return [{ field: 'dob', label: 'Date of birth', reason: 'missing' }]
  const reason = birthDateIssueReason(input.dob)
  return reason ? [{ field: 'dob', label: 'Date of birth', reason }] : []
}

export function cardCreationIssueMessage(issue: CardActivationIssue): string {
  if (issue.reason === 'missing') return 'Date of birth is required to create a card.'
  if (issue.reason === 'underage') return 'You must be at least 12 years old to create a card.'
  return 'Enter a valid date of birth in YYYY-MM-DD format.'
}

export function cardActivationIssueMessage(issues: CardActivationIssue[]): string {
  const missing = issues.filter((issue) => issue.reason === 'missing')
  const invalid = issues.filter((issue) => issue.reason === 'invalid')
  const underage = issues.some((issue) => issue.reason === 'underage')

  if (issues.length === 1 && missing.length === 1 && missing[0].field === 'dob') {
    return 'Card cannot be activated. Please enter your date of birth.'
  }

  const missingLabels = missing.map((issue) => issue.label)
  const invalidLabels = invalid.filter((issue) => issue.field !== 'dob').map((issue) => issue.label)
  const dobInvalid = invalid.some((issue) => issue.field === 'dob')

  const pleaseParts: string[] = []
  if (missingLabels.length) pleaseParts.push(`complete ${missingLabels.join(', ')}`)
  if (invalidLabels.length) pleaseParts.push(`correct ${invalidLabels.join(', ')}`)
  if (dobInvalid) pleaseParts.push('enter a valid date of birth')

  const sentences: string[] = []
  if (pleaseParts.length) sentences.push(`Please ${pleaseParts.join(' and ')}.`)
  if (underage) sentences.push('You must be at least 12 years old.')
  return `Card cannot be activated. ${sentences.join(' ')}`.trim()
}
