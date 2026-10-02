export type SmsTopic =
  | '1-on-1'
  | 'Repeat view'
  | 'Note'
  | 'Birthday'
  | 'Special day'
  | 'Special message'
  | 'Notice'
  | 'Saved contact'
  | 'Schedule'

const MAX_SMS_CHARS = 320

type Region = {
  dial: string
  names: string[]
  min: number
  max: number
}

/** United States, Canada, United Kingdom, India, Pakistan, Bangladesh. */
const REGIONS: Region[] = [
  { dial: '1', names: ['us', 'usa', 'united states', 'united states of america', 'ca', 'canada'], min: 11, max: 11 },
  {
    dial: '44',
    names: ['uk', 'gb', 'gbr', 'united kingdom', 'great britain', 'england', 'scotland', 'wales'],
    min: 11,
    max: 13,
  },
  { dial: '91', names: ['in', 'ind', 'india'], min: 12, max: 12 },
  { dial: '92', names: ['pk', 'pak', 'pakistan'], min: 12, max: 12 },
  { dial: '880', names: ['bd', 'bgd', 'bangladesh'], min: 13, max: 13 },
]

const BY_DIAL = [...REGIONS].sort((a, b) => b.dial.length - a.dial.length)

function regionFromHint(countryCode?: string | null): Region | null {
  const raw = String(countryCode || '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  return REGIONS.find((region) => region.names.includes(raw) || digits === region.dial) ?? null
}

function regionFromDigits(digits: string): Region | null {
  return (
    BY_DIAL.find(
      (region) => digits.startsWith(region.dial) && digits.length >= region.min && digits.length <= region.max
    ) ?? null
  )
}

function asE164(digits: string): string | null {
  const region = regionFromDigits(digits)
  if (!region) return null
  return `+${digits}`
}

function nationalDigits(digits: string, region: Region): string {
  let national = digits
  if (national.startsWith(region.dial) && national.length >= region.min && national.length <= region.max)
    return national
  if (region.dial !== '1' && national.startsWith('0')) national = national.replace(/^0+/, '')
  if (region.dial === '1' && national.length === 11 && national.startsWith('1')) return national
  return `${region.dial}${national}`
}

/**
 * Turn a stored phone into E.164 for the supported regions.
 * A card country (name, ISO code, or dial code) wins over a bare local number.
 * `00` is treated as an international prefix. US and Canada 10-digit numbers use +1.
 */
export function toE164(raw: string | null | undefined, countryCode?: string | null): string | null {
  let trimmed = String(raw || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('00')) trimmed = `+${trimmed.slice(2).trim()}`

  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  if (hasPlus) return asE164(digits)

  const hinted = regionFromHint(countryCode)
  if (hinted) return asE164(nationalDigits(digits, hinted))

  const embedded = regionFromDigits(digits)
  if (embedded) return `+${digits}`

  if (digits.startsWith('0')) {
    const national = digits.replace(/^0+/, '')
    if (/^7\d{9}$/.test(national)) return asE164(`44${national}`)
    if (/^1[3-9]\d{8}$/.test(national)) return asE164(`880${national}`)
    if (/^3\d{9}$/.test(national)) return asE164(`92${national}`)
    return null
  }

  if (digits.length === 10) return asE164(`1${digits}`)
  return null
}

/**
 * One person for a birthday text: the same phone and the same month/day.
 * Ten cards with that pair produce one key, so the run sends one SMS.
 */
export function birthdayPersonKey(
  phone: string | null | undefined,
  countryCode: string | null | undefined,
  month: number,
  day: number
): string | null {
  const e164 = toE164(phone, countryCode)
  if (!e164) return null
  return `${e164}|${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function hasFullSaveContactInfo(input: { name?: string | null; email?: string | null; phone?: string | null }) {
  return Boolean(input.name?.trim() && input.email?.trim() && toE164(input.phone))
}

/** The message name is vBiz Me. Carriers show the Twilio number as the sender. */
export function buildVbizSms(input: { topic: SmsTopic; cardName: string; cardUrl: string; detail: string }) {
  const cardName = input.cardName.replace(/\s+/g, ' ').trim() || 'vBiz card'
  const detail = input.detail.replace(/\s+/g, ' ').trim()
  const url = input.cardUrl.trim()
  const text = `vBiz Me\n${input.topic}: ${detail}\nCard: ${cardName}\n${url}`
  return text.length <= MAX_SMS_CHARS ? text : `${text.slice(0, MAX_SMS_CHARS - 1)}…`
}
