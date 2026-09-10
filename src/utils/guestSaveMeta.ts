/**
 * Enrich / normalize guest-save metadata for device, browser, and approximate location.
 * Improves both new saves and display of older rows that only stored raw userAgent.
 */

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function parseBrowserFromUa(ua: string): string {
  if (!ua) return ''
  if (/Edg(?:e|A|iOS)?\//i.test(ua) || /EdgiOS\//i.test(ua)) return 'Microsoft Edge'
  if (/CriOS\//i.test(ua)) return 'Chrome'
  if (/FxiOS\//i.test(ua)) return 'Firefox'
  if (/OPiOS\//i.test(ua) || /OPR\//i.test(ua)) return 'Opera'
  if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet'
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome'
  if (/Firefox\//i.test(ua)) return 'Firefox'
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua) && !/CriOS\//i.test(ua)) return 'Safari'
  return 'Unknown browser'
}

export function parseDeviceFromUa(ua: string): string {
  if (!ua) return ''
  if (/iPhone/i.test(ua)) {
    const ios = ua.match(/OS (\d+)[._](\d+)/i)
    return ios ? `iPhone · iOS ${ios[1]}.${ios[2]}` : 'iPhone'
  }
  if (/iPad/i.test(ua)) {
    const ios = ua.match(/OS (\d+)[._](\d+)/i)
    return ios ? `iPad · iOS ${ios[1]}.${ios[2]}` : 'iPad'
  }
  if (/iPod/i.test(ua)) return 'iPod'
  if (/Android/i.test(ua)) {
    const ver = ua.match(/Android (\d+(?:\.\d+)?)/i)
    const model = ua.match(/;\s*([^;)]+)\s*Build\//i)
    const kind = /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet'
    const parts = [kind]
    if (ver) parts.push(`Android ${ver[1]}`)
    if (model?.[1] && !/wv|Linux/i.test(model[1])) parts.push(model[1].trim())
    return parts.join(' · ')
  }
  if (/Windows Phone/i.test(ua)) return 'Windows Phone'
  if (/Windows NT/i.test(ua)) return 'Windows PC'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
  if (/CrOS/i.test(ua)) return 'Chromebook'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Unknown device'
}

const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Dhaka': 'Dhaka, Bangladesh',
  'Asia/Kolkata': 'India',
  'Asia/Calcutta': 'India',
  'Asia/Karachi': 'Pakistan',
  'Asia/Dubai': 'Dubai, UAE',
  'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Singapore': 'Singapore',
  'Asia/Kuala_Lumpur': 'Malaysia',
  'Asia/Jakarta': 'Jakarta, Indonesia',
  'Asia/Bangkok': 'Bangkok, Thailand',
  'Asia/Shanghai': 'China',
  'Asia/Hong_Kong': 'Hong Kong',
  'Asia/Tokyo': 'Tokyo, Japan',
  'Asia/Seoul': 'Seoul, South Korea',
  'Asia/Manila': 'Philippines',
  'Europe/London': 'London, UK',
  'Europe/Paris': 'Paris, France',
  'Europe/Berlin': 'Berlin, Germany',
  'Europe/Amsterdam': 'Netherlands',
  'Europe/Madrid': 'Madrid, Spain',
  'Europe/Rome': 'Rome, Italy',
  'America/New_York': 'Eastern USA',
  'America/Chicago': 'Central USA',
  'America/Denver': 'Mountain USA',
  'America/Los_Angeles': 'Western USA',
  'America/Toronto': 'Toronto, Canada',
  'America/Vancouver': 'Vancouver, Canada',
  'America/Sao_Paulo': 'São Paulo, Brazil',
  'Australia/Sydney': 'Sydney, Australia',
  'Australia/Melbourne': 'Melbourne, Australia',
  'Pacific/Auckland': 'Auckland, New Zealand',
  UTC: 'UTC',
}

export function locationFromTimezone(timezone: string, language?: string): string {
  const tz = timezone.trim()
  if (!tz) return language?.trim() ? `Locale ${language.trim()}` : ''
  if (TIMEZONE_LABELS[tz]) return `${TIMEZONE_LABELS[tz]} (${tz})`
  const city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : tz
  return `${city} (${tz})`
}

export type EnrichedGuestMeta = {
  userAgent: string
  language: string
  platform: string
  browser: string
  device: string
  screen: string
  timezone: string
  approximateLocation: string
  referrer: string
  ip?: string
}

/** Merge client meta + request headers into a consistent guest-save meta payload. */
export function enrichGuestSaveMeta(
  clientMeta: Record<string, unknown>,
  request?: { ip?: string | null; userAgent?: string | null; cfCity?: string | null; cfCountry?: string | null }
): Record<string, unknown> {
  const ua = str(request?.userAgent) || str(clientMeta.userAgent)
  const timezone = str(clientMeta.timezone)
  const language = str(clientMeta.language)
  const browser = str(clientMeta.browser) || parseBrowserFromUa(ua)
  const device = str(clientMeta.device) || parseDeviceFromUa(ua)
  const platform = str(clientMeta.platform) || device || 'web'

  const cfCity = str(request?.cfCity)
  const cfCountry = str(request?.cfCountry)
  const cfLocation = [cfCity, cfCountry].filter(Boolean).join(', ')

  let approximateLocation = str(clientMeta.approximateLocation) || str(clientMeta.location)
  if (!approximateLocation || approximateLocation === 'Unknown' || approximateLocation.startsWith('Approx.')) {
    approximateLocation = cfLocation || locationFromTimezone(timezone, language) || ''
  }

  let referrer = str(clientMeta.referrer)
  if (!referrer) {
    const utm = str(clientMeta.utmSource)
    referrer = utm ? `Campaign / ${utm}` : 'Direct / QR'
  }

  return {
    ...clientMeta,
    userAgent: ua || null,
    language: language || null,
    platform: platform || null,
    browser: browser || null,
    device: device || null,
    screen: str(clientMeta.screen) || null,
    timezone: timezone || null,
    approximateLocation: approximateLocation || null,
    referrer,
    ip: request?.ip || clientMeta.ip || null,
    cfCity: cfCity || null,
    cfCountry: cfCountry || null,
  }
}

/** Normalize meta for admin/CRM display chips (also repairs older incomplete rows). */
export function leadMetadataFromGuestMeta(meta: unknown): {
  userAgent: string
  language: string
  platform: string
  browser: string
  device: string
  screen: string
  timezone: string
  approximateLocation: string
  referrer: string
} {
  const m = asRecord(meta)
  const ua = str(m.userAgent)
  const timezone = str(m.timezone)
  const language = str(m.language)
  const browser = str(m.browser) || parseBrowserFromUa(ua) || '—'
  const device = str(m.device) || parseDeviceFromUa(ua) || str(m.platform) || '—'
  const platform = str(m.platform) || device

  let approximateLocation = str(m.approximateLocation) || str(m.location)
  if (!approximateLocation || approximateLocation === 'Unknown' || approximateLocation.startsWith('Approx.')) {
    const cf = [str(m.cfCity), str(m.cfCountry)].filter(Boolean).join(', ')
    approximateLocation = cf || locationFromTimezone(timezone, language) || 'Unknown'
  }

  return {
    userAgent: ua,
    language,
    platform,
    browser,
    device,
    screen: str(m.screen),
    timezone,
    approximateLocation,
    referrer: str(m.referrer) || 'Direct / QR',
  }
}
