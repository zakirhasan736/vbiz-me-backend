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

export function collectCardDobIssues(input: Pick<CardActivationInput, 'dob'>): CardActivationIssue[] {
  const dob = cardDateOnly(input.dob)
  if (!dob) return [{ field: 'dob', label: 'Date of birth', reason: 'missing' }]
  const reason = birthDateIssueReason(input.dob)
  return reason ? [{ field: 'dob', label: 'Date of birth', reason }] : []
}

export function collectCardCreationIssues(
  input: Pick<CardActivationInput, 'email' | 'phone' | 'dob'>
): CardActivationIssue[] {
  const email = text(input.email)
  const phoneRaw = text(input.phone)
  const phone = normalizeCardPhone(input.phone)
  const issues: CardActivationIssue[] = []

  if (!email) issues.push({ field: 'email', label: 'Email', reason: 'missing' })
  else if (!EMAIL_PATTERN.test(email)) issues.push({ field: 'email', label: 'Email', reason: 'invalid' })

  if (!phoneRaw) issues.push({ field: 'phone', label: 'Phone', reason: 'missing' })
  else if (phone.length < 7 || phone.length > 15) {
    issues.push({ field: 'phone', label: 'Phone', reason: 'invalid' })
  }

  issues.push(...collectCardDobIssues(input))
  return issues
}

export function cardCreationIssueMessage(issue: CardActivationIssue): string {
  if (issue.field === 'email') {
    return issue.reason === 'missing'
      ? 'Email is required to create a card.'
      : 'Enter a valid email address to create a card.'
  }
  if (issue.field === 'phone') {
    return issue.reason === 'missing'
      ? 'Phone number is required to create a card.'
      : 'Enter a valid phone number to create a card.'
  }
  if (issue.reason === 'missing') return 'Date of birth is required to create a card.'
  if (issue.reason === 'underage') return 'You must be at least 12 years old to create a card.'
  return 'Enter a valid date of birth in YYYY-MM-DD format.'
}

/** Used only when creating a new card. Edits and already-saved cards are not checked. */
export function findCreateContactConflict(
  input: { email?: unknown; phone?: unknown },
  existing: { email?: string | null; phone?: string | null }
): 'email' | 'phone' | null {
  const email = normalizeCardEmail(input.email)
  const phone = normalizeCardPhone(input.phone)
  if (email && normalizeCardEmail(existing.email) === email) return 'email'
  if (phone && normalizeCardPhone(existing.phone) === phone) return 'phone'
  return null
}

export function createContactConflictMessage(field: 'email' | 'phone'): string {
  if (field === 'email') {
    return 'This email is already used on another card. Use a different email to create a new card.'
  }
  return 'This phone number is already used on another card. Use a different phone number to create a new card.'
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
