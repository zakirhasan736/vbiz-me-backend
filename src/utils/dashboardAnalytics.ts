export const SOCIAL_CHANNELS = [
  'facebook',
  'twitter',
  'instagram',
  'whatsapp',
  'linkedin',
  'youtube',
  'tiktok',
  'truth',
  'rumble',
  'pinterest',
  'website',
] as const

export type SocialChannel = (typeof SOCIAL_CHANNELS)[number]

export const SOCIAL_CHANNEL_LABELS: Record<SocialChannel, string> = {
  facebook: 'Facebook',
  twitter: 'Twitter',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  truth: 'Truth Social',
  rumble: 'Rumble',
  pinterest: 'Pinterest',
  website: 'Website',
}

/** Map public vCard display labels → canonical channel keys. */
export const SOCIAL_LABEL_TO_CHANNEL: Record<string, SocialChannel> = {
  facebook: 'facebook',
  FaceBook: 'facebook',
  Facebook: 'facebook',
  Twitter: 'twitter',
  twitter: 'twitter',
  Instagram: 'instagram',
  instagram: 'instagram',
  Whatsapp: 'whatsapp',
  WhatsApp: 'whatsapp',
  whatsapp: 'whatsapp',
  LinkedIn: 'linkedin',
  linkedin: 'linkedin',
  Youtube: 'youtube',
  YouTube: 'youtube',
  youtube: 'youtube',
  TikTok: 'tiktok',
  tiktok: 'tiktok',
  Truth: 'truth',
  'Truth Social': 'truth',
  truth: 'truth',
  Rumble: 'rumble',
  rumble: 'rumble',
  Pinterest: 'pinterest',
  pinterest: 'pinterest',
  Website: 'website',
  website: 'website',
}

export function isSocialChannel(value: unknown): value is SocialChannel {
  return typeof value === 'string' && (SOCIAL_CHANNELS as readonly string[]).includes(value)
}

export function parsePlatformFromUa(userAgent?: string | null): string {
  if (!userAgent) return 'Desktop'
  const ua = userAgent.toLowerCase()
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(userAgent)) return 'Tablet'
  if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry/i.test(ua)) return 'Mobile'
  return 'Desktop'
}

export function formatRelativeTime(date: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (seconds < 60) return `${Math.max(1, seconds)} secs ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

export function trendPercent(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function shortDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export type DashboardPeriod = 'all' | '7' | '30' | '90'

export const DASHBOARD_PERIOD_DAYS: Record<Exclude<DashboardPeriod, 'all'>, number> = {
  '7': 7,
  '30': 30,
  '90': 90,
}

/** Chart day cap when period=all (keeps response size bounded). */
export const DASHBOARD_ALL_CHART_DAYS = 90

export function resolveDashboardWindowDays(period: DashboardPeriod = 'all'): number | null {
  if (period === 'all') return null
  return DASHBOARD_PERIOD_DAYS[period]
}

export function buildDailyPoints(
  end: Date,
  days: number,
  countsByDay: Map<string, number>
): Array<{ name: string; total: number }> {
  // Inclusive window ending on `end`'s UTC calendar day (includes today).
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  const points: Array<{ name: string; total: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endUtc - i * 24 * 60 * 60 * 1000)
    const key = dayKey(d)
    points.push({ name: shortDayLabel(d), total: countsByDay.get(key) || 0 })
  }
  return points
}

export function eventTypeLabel(eventType: string, payload?: Record<string, unknown> | null): string {
  switch (eventType) {
    case 'profile_view':
      return 'Profile Viewed'
    case 'save_guest_user':
      return 'Guest Saved'
    case 'save_contact_download':
      return 'Contact Saved'
    case 'social_click': {
      const channel = payload?.channel
      if (typeof channel === 'string' && isSocialChannel(channel)) {
        return `${SOCIAL_CHANNEL_LABELS[channel]} Click`
      }
      if (typeof channel === 'string' && channel.trim()) {
        return `${channel.trim()} Click`
      }
      return 'Social Click'
    }
    case 'save_note':
      return 'Note Left'
    default:
      return eventType
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
  }
}

export function viewerFromPayload(eventType: string, payload?: Record<string, unknown> | null): string {
  if (!payload) return 'Guest'
  const candidates = [payload.fullName, payload.full_name, payload.name, payload.viewer, payload.ownerName]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  if (eventType === 'profile_view' || eventType === 'social_click') return 'Guest'
  return 'Guest'
}

export function channelFromPayload(payload: unknown): SocialChannel | null {
  if (!payload || typeof payload !== 'object') return null
  const channel = (payload as Record<string, unknown>).channel
  return isSocialChannel(channel) ? channel : null
}

export function guestIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const guestId = (payload as Record<string, unknown>).guestId
  return typeof guestId === 'string' && guestId.trim() ? guestId.trim() : null
}

/** Unique guests; rows without guestId each count once (legacy). */
export function countDistinctGuests(rows: Array<{ payload: unknown }>): number {
  const seen = new Set<string>()
  let legacy = 0
  for (const row of rows) {
    const guestId = guestIdFromPayload(row.payload)
    if (guestId) seen.add(guestId)
    else legacy += 1
  }
  return seen.size + legacy
}

/** Unique guests per UTC day; legacy rows without guestId each count once that day. */
export function countDistinctGuestsByDay(rows: Array<{ createdAt: Date; payload: unknown }>): Map<string, number> {
  const byDay = new Map<string, { guests: Set<string>; legacy: number }>()
  for (const row of rows) {
    const key = dayKey(row.createdAt)
    let bucket = byDay.get(key)
    if (!bucket) {
      bucket = { guests: new Set(), legacy: 0 }
      byDay.set(key, bucket)
    }
    const guestId = guestIdFromPayload(row.payload)
    if (guestId) bucket.guests.add(guestId)
    else bucket.legacy += 1
  }
  const counts = new Map<string, number>()
  for (const [key, bucket] of byDay) {
    counts.set(key, bucket.guests.size + bucket.legacy)
  }
  return counts
}

/** Unique guests per social channel; legacy rows without guestId each count once. */
export function countDistinctGuestsByChannel(rows: Array<{ payload: unknown }>): Map<SocialChannel, number> {
  const buckets = new Map<SocialChannel, { guests: Set<string>; legacy: number }>()
  for (const channel of SOCIAL_CHANNELS) {
    buckets.set(channel, { guests: new Set(), legacy: 0 })
  }
  for (const row of rows) {
    const channel = channelFromPayload(row.payload)
    if (!channel) continue
    const bucket = buckets.get(channel)!
    const guestId = guestIdFromPayload(row.payload)
    if (guestId) bucket.guests.add(guestId)
    else bucket.legacy += 1
  }
  const counts = new Map<SocialChannel, number>()
  for (const channel of SOCIAL_CHANNELS) {
    const bucket = buckets.get(channel)!
    counts.set(channel, bucket.guests.size + bucket.legacy)
  }
  return counts
}
