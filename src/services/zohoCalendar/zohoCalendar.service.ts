import config from '../../configs/config'
import logger from '../../utils/logger'

export type CalendarMeetingInput = {
  summary: string
  description?: string | null
  date: string
  time: string
  durationMinutes?: number
  attendeeEmail?: string | null
}

export type CalendarMeetingResult = {
  /** Zoho stores `uid::etag` so later update/delete can send the required etag. */
  eventId: string
  meetLink: string | null
  htmlLink: string | null
}

function isConfigured(): boolean {
  return Boolean(
    config.ZOHO_CALENDAR.CLIENT_ID &&
    config.ZOHO_CALENDAR.CLIENT_SECRET &&
    config.ZOHO_CALENDAR.REFRESH_TOKEN &&
    config.ZOHO_CALENDAR.CALENDAR_UID
  )
}

function parseTimeParts(time: string): { hours: number; minutes: number } {
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

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function encodeCalendarUid(uid: string) {
  return encodeURIComponent(uid)
}

/** Zoho event UIDs contain `@zoho.com` — keep `@` unencoded in the path (docs use raw `@`). */
function encodeEventUid(uid: string) {
  return encodeURIComponent(uid).replace(/%40/g, '@')
}

/** Build Zoho dateandtime string yyyyMMdd'T'HHmmss in configured timezone (local wall clock). */
function buildZohoDateTime(date: string, time: string, addMinutes = 0): string {
  const { hours, minutes } = parseTimeParts(time)
  const total = hours * 60 + minutes + addMinutes
  const dayOffset = Math.floor(total / (24 * 60))
  const rem = ((total % (24 * 60)) + 24 * 60) % (24 * 60)
  const endH = Math.floor(rem / 60)
  const endM = rem % 60

  const [y, m, d] = date.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return `${base.getUTCFullYear()}${pad2(base.getUTCMonth() + 1)}${pad2(base.getUTCDate())}T${pad2(endH)}${pad2(endM)}00`
}

function parseStoredEventId(stored: string): { uid: string; etag: string | null } {
  const trimmed = stored.trim()
  const sep = trimmed.indexOf('::')
  if (sep > 0) {
    return { uid: trimmed.slice(0, sep), etag: trimmed.slice(sep + 2) || null }
  }
  return { uid: trimmed, etag: null }
}

function packEventId(uid: string, etag?: string | number | null) {
  if (etag == null || etag === '') return uid
  return `${uid}::${etag}`
}

async function getAccessToken(): Promise<string | null> {
  if (!isConfigured()) {
    logger.warn('Zoho Calendar skipped: missing ZOHO_CLIENT_ID/SECRET, ZOHO_REFRESH_TOKEN, or ZOHO_CALENDAR_UID')
    return null
  }

  const accountsDomain = config.ZOHO_CALENDAR.ACCOUNTS_DOMAIN
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.ZOHO_CALENDAR.CLIENT_ID!,
    client_secret: config.ZOHO_CALENDAR.CLIENT_SECRET!,
    refresh_token: config.ZOHO_CALENDAR.REFRESH_TOKEN!,
  })

  try {
    const response = await fetch(`https://${accountsDomain}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const data = (await response.json()) as { access_token?: string; error?: string }
    if (!response.ok || !data.access_token) {
      logger.error('Zoho Calendar token refresh failed', data)
      return null
    }
    return data.access_token
  } catch (error) {
    logger.error('Zoho Calendar token refresh failed', error)
    return null
  }
}

function extractMeetLink(event: Record<string, unknown>): string | null {
  const appData = event.app_data as { meetingdata?: { meetinglink?: string } } | undefined
  if (appData?.meetingdata?.meetinglink) return appData.meetingdata.meetinglink

  const conferenceData = event.conference_data as
    { meetingdata?: { meeting_link?: string; meetinglink?: string } } | undefined
  const link = conferenceData?.meetingdata?.meeting_link || conferenceData?.meetingdata?.meetinglink
  return link || null
}

function eventPayload(input: CalendarMeetingInput, includeConference: boolean) {
  const duration = input.durationMinutes ?? 30
  const timezone = config.ZOHO_CALENDAR.TIMEZONE
  const start = buildZohoDateTime(input.date, input.time, 0)
  const end = buildZohoDateTime(input.date, input.time, duration)

  const payload: Record<string, unknown> = {
    title: input.summary,
    description: input.description || undefined,
    dateandtime: { timezone, start, end },
    notifyType: 1,
  }

  if (input.attendeeEmail?.trim()) {
    payload.attendees = [{ email: input.attendeeEmail.trim(), status: 'NEEDS-ACTION' }]
  }

  if (includeConference) {
    payload.conference = 'zmeeting'
  }

  return payload
}

async function zohoFetch(
  path: string,
  init: RequestInit & { accessToken: string; etag?: string | null }
): Promise<unknown> {
  const apiDomain = config.ZOHO_CALENDAR.API_DOMAIN
  const url = `https://${apiDomain}/api/v1${path}`
  const { accessToken, etag, ...rest } = init

  const response = await fetch(url, {
    ...rest,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...(etag ? { etag: String(etag) } : {}),
      ...(rest.headers || {}),
    },
  })

  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data && 'message' in data
        ? String((data as { message: unknown }).message)
        : text || response.statusText
    throw new Error(`Zoho Calendar API ${response.status}: ${message}`)
  }

  return data
}

async function fetchEventEtag(accessToken: string, uid: string): Promise<string | null> {
  const calendarUid = encodeCalendarUid(config.ZOHO_CALENDAR.CALENDAR_UID!)
  const encodedEventId = encodeEventUid(uid)
  try {
    const data = (await zohoFetch(`/calendars/${calendarUid}/events/${encodedEventId}`, {
      method: 'GET',
      accessToken,
    })) as { events?: Array<Record<string, unknown>> }
    const etag = data?.events?.[0]?.etag
    return etag == null ? null : String(etag)
  } catch (error) {
    logger.warn('Zoho Calendar fetch etag failed', error)
    return null
  }
}

const createMeetingEvent = async (input: CalendarMeetingInput): Promise<CalendarMeetingResult | null> => {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return null

    const calendarUid = encodeCalendarUid(config.ZOHO_CALENDAR.CALENDAR_UID!)
    const eventdata = encodeURIComponent(JSON.stringify(eventPayload(input, true)))
    const data = (await zohoFetch(`/calendars/${calendarUid}/events?eventdata=${eventdata}`, {
      method: 'POST',
      accessToken,
    })) as { events?: Array<Record<string, unknown>> }

    const event = data?.events?.[0]
    if (!event) {
      logger.warn('Zoho Calendar create returned no event')
      return null
    }

    const uid = (event.uid as string) || (event.id as string)
    if (!uid) {
      logger.warn('Zoho Calendar create returned no event id')
      return null
    }

    const meetLink = extractMeetLink(event)
    const htmlLink = (event.viewEventURL as string) || null
    const eventId = packEventId(uid, event.etag as string | number | undefined)

    logger.info('Zoho Calendar event created', { eventId: uid, hasMeetLink: Boolean(meetLink) })

    return { eventId, meetLink, htmlLink }
  } catch (error) {
    logger.error('Zoho Calendar createMeetingEvent failed', error)
    return null
  }
}

const updateMeetingEvent = async (
  eventId: string,
  input: CalendarMeetingInput
): Promise<CalendarMeetingResult | null> => {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return null

    const { uid, etag: storedEtag } = parseStoredEventId(eventId)
    const etag = storedEtag || (await fetchEventEtag(accessToken, uid))
    if (!etag) {
      logger.warn('Zoho Calendar update skipped: missing etag', { uid })
      return null
    }

    const calendarUid = encodeCalendarUid(config.ZOHO_CALENDAR.CALENDAR_UID!)
    const encodedEventId = encodeEventUid(uid)
    const payload = { uid, etag, ...eventPayload(input, false) }
    const eventdata = encodeURIComponent(JSON.stringify(payload))

    const data = (await zohoFetch(`/calendars/${calendarUid}/events/${encodedEventId}?eventdata=${eventdata}`, {
      method: 'PUT',
      accessToken,
      etag,
    })) as { events?: Array<Record<string, unknown>> }

    const event = data?.events?.[0]
    const nextUid = (event?.uid as string) || uid
    const nextEtag = (event?.etag as string | number | undefined) || etag
    return {
      eventId: packEventId(nextUid, nextEtag),
      meetLink: event ? extractMeetLink(event) : null,
      htmlLink: event ? (event.viewEventURL as string) || null : null,
    }
  } catch (error) {
    logger.error('Zoho Calendar updateMeetingEvent failed', error)
    return null
  }
}

const deleteMeetingEvent = async (eventId: string): Promise<boolean> => {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return false

    const { uid, etag: storedEtag } = parseStoredEventId(eventId)
    const etag = storedEtag || (await fetchEventEtag(accessToken, uid))
    if (!etag) {
      logger.warn('Zoho Calendar delete skipped: missing etag', { uid })
      return false
    }

    const calendarUid = encodeCalendarUid(config.ZOHO_CALENDAR.CALENDAR_UID!)
    const encodedEventId = encodeEventUid(uid)
    const eventdata = encodeURIComponent(JSON.stringify({ uid, etag }))

    await zohoFetch(`/calendars/${calendarUid}/events/${encodedEventId}?eventdata=${eventdata}`, {
      method: 'DELETE',
      accessToken,
      etag,
    })
    return true
  } catch (error) {
    logger.error('Zoho Calendar deleteMeetingEvent failed', error)
    return false
  }
}

const zohoCalendarService = {
  isConfigured,
  createMeetingEvent,
  updateMeetingEvent,
  deleteMeetingEvent,
}

export default zohoCalendarService
