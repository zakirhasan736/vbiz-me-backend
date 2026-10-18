/** Default campaign / cron timezone for USA-facing schedules. */
export const DEFAULT_CAMPAIGN_TIMEZONE = 'America/New_York'

const USA_TIMEZONES = new Set([
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
])

/** Normalize free-text / IANA zone; falls back to America/New_York. */
export function normalizeIanaTimeZone(timeZone?: string | null): string {
  const raw = (timeZone || '').trim()
  if (!raw) return DEFAULT_CAMPAIGN_TIMEZONE
  if (USA_TIMEZONES.has(raw)) return raw
  try {
    // Throws RangeError for invalid IANA ids.
    Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date())
    return raw
  } catch {
    return DEFAULT_CAMPAIGN_TIMEZONE
  }
}

/** Parse display time like "10:00 AM" / "14:30" into hours/minutes. */
export function parseScheduleTimeParts(time: string): { hours: number; minutes: number } {
  const trimmed = time.trim()
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (ampm) {
    let hours = Number(ampm[1])
    const minutes = Number(ampm[2])
    const period = ampm[3].toUpperCase()
    if (period === 'PM' && hours < 12) hours += 12
    if (period === 'AM' && hours === 12) hours = 0
    return { hours, minutes }
  }
  const twentyFour = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  if (twentyFour) {
    return { hours: Number(twentyFour[1]), minutes: Number(twentyFour[2]) }
  }
  return { hours: 0, minutes: 0 }
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const map: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/**
 * Convert a wall-clock local date+time in an IANA zone to a UTC Date.
 * Handles DST by measuring the zone offset at the guessed instant.
 */
export function zonedLocalDateTimeToUtc(dateYmd: string, time: string, timeZone?: string | null): Date {
  const tz = normalizeIanaTimeZone(timeZone)
  const { hours, minutes } = parseScheduleTimeParts(time)
  const [y, m, d] = dateYmd.split('-').map(Number)
  if (!y || !m || !d) return new Date(NaN)

  // Initial guess: treat wall time as UTC, then correct by zone offset.
  let utcMs = Date.UTC(y, m - 1, d, hours, minutes, 0, 0)
  for (let i = 0; i < 3; i += 1) {
    const asZone = zonedParts(utcMs, tz)
    const asZoneUtc = Date.UTC(asZone.year, asZone.month - 1, asZone.day, asZone.hour, asZone.minute, asZone.second)
    const wantedUtc = Date.UTC(y, m - 1, d, hours, minutes, 0, 0)
    const delta = wantedUtc - asZoneUtc
    if (delta === 0) break
    utcMs += delta
  }
  return new Date(utcMs)
}

/** @deprecated Prefer {@link zonedLocalDateTimeToUtc} with an explicit IANA zone. */
export function computeStartsAt(
  date: string,
  time: string,
  timeZone: string | null | undefined = DEFAULT_CAMPAIGN_TIMEZONE
): Date {
  return zonedLocalDateTimeToUtc(date, time, timeZone)
}
