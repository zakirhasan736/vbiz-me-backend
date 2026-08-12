import { OAuth2Client } from 'google-auth-library'
import config from '../../configs/config'
import logger from '../../utils/logger'

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

export type CalendarMeetingInput = {
  summary: string
  description?: string | null
  date: string
  time: string
  durationMinutes?: number
  attendeeEmail?: string | null
}

export type CalendarMeetingResult = {
  eventId: string
  meetLink: string | null
  htmlLink: string | null
}

function isConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_CALENDAR.REFRESH_TOKEN)
}

async function getAccessToken(): Promise<string | null> {
  if (!isConfigured()) {
    logger.warn(
      'Google Calendar skipped: missing client id/secret or refresh token (set GOOGLE_CALENDAR_REFRESH_TOKEN)'
    )
    return null
  }

  try {
    const client = new OAuth2Client(config.GOOGLE_CLIENT_ID?.trim(), config.GOOGLE_CLIENT_SECRET?.trim())
    client.setCredentials({ refresh_token: config.GOOGLE_CALENDAR.REFRESH_TOKEN })
    const { token } = await client.getAccessToken()
    if (!token) {
      logger.warn('Google Calendar skipped: failed to refresh access token (empty token)')
      return null
    }
    return token
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/invalid_grant/i.test(message)) {
      logger.error(
        'Google Calendar token refresh failed (invalid_grant). Regenerated refresh token must match GOOGLE_CLIENT_ID/SECRET, include calendar.events scope, and not be revoked. Also remove duplicate GOOGLE_CLIENT_* lines in .env (first value wins).',
        error
      )
    } else {
      logger.error('Google Calendar token refresh failed', error)
    }
    return null
  }
}

/** Parse display time like "10:00 AM" / "14:30" into hours/minutes. */
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

function buildDateTimeLocal(date: string, time: string, addMinutes = 0): string {
  const { hours, minutes } = parseTimeParts(time)
  const total = hours * 60 + minutes + addMinutes
  const dayOffset = Math.floor(total / (24 * 60))
  const rem = ((total % (24 * 60)) + 24 * 60) % (24 * 60)
  const endH = Math.floor(rem / 60)
  const endM = rem % 60

  const [y, m, d] = date.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCDate(base.getUTCDate() + dayOffset)
  const yy = base.getUTCFullYear()
  const mm = pad2(base.getUTCMonth() + 1)
  const dd = pad2(base.getUTCDate())
  return `${yy}-${mm}-${dd}T${pad2(endH)}:${pad2(endM)}:00`
}

function eventBody(input: CalendarMeetingInput, includeConference: boolean) {
  const duration = input.durationMinutes ?? 30
  const timeZone = config.GOOGLE_CALENDAR.TIMEZONE
  const start = buildDateTimeLocal(input.date, input.time, 0)
  const end = buildDateTimeLocal(input.date, input.time, duration)

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description || undefined,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  }

  if (input.attendeeEmail?.trim()) {
    body.attendees = [{ email: input.attendeeEmail.trim() }]
  }

  if (includeConference) {
    body.conferenceData = {
      createRequest: {
        requestId: `vbiz-meet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    }
  }

  return body
}

function extractMeetLink(event: {
  hangoutLink?: string
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
}): string | null {
  if (event.hangoutLink) return event.hangoutLink
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
  return video?.uri || null
}

async function calendarFetch(
  path: string,
  init: RequestInit & { accessToken: string; conferenceDataVersion?: number }
): Promise<unknown> {
  const calendarId = encodeURIComponent(config.GOOGLE_CALENDAR.CALENDAR_ID)
  const url = new URL(`${CALENDAR_API}/calendars/${calendarId}${path}`)
  if (init.conferenceDataVersion !== undefined) {
    url.searchParams.set('conferenceDataVersion', String(init.conferenceDataVersion))
  }

  const { accessToken, conferenceDataVersion: _c, ...rest } = init
  const response = await fetch(url.toString(), {
    ...rest,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(rest.headers || {}),
    },
  })

  const text = await response.text()
  const data = parseCalendarResponseBody(text)

  if (!response.ok) {
    const message =
      typeof data === 'object' && data && 'error' in data
        ? JSON.stringify((data as { error: unknown }).error)
        : text || response.statusText
    throw new Error(`Google Calendar API ${response.status}: ${message}`)
  }

  return data
}

function parseCalendarResponseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

const createMeetingEvent = async (input: CalendarMeetingInput): Promise<CalendarMeetingResult | null> => {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return null

    const tryCreate = async (withAttendee: boolean) => {
      const payload = eventBody(
        {
          ...input,
          attendeeEmail: withAttendee ? input.attendeeEmail : null,
        },
        true
      )
      return (await calendarFetch('/events', {
        method: 'POST',
        accessToken,
        conferenceDataVersion: 1,
        body: JSON.stringify(payload),
      })) as {
        id?: string
        hangoutLink?: string
        htmlLink?: string
        conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
      }
    }

    let data: Awaited<ReturnType<typeof tryCreate>>
    try {
      data = await tryCreate(Boolean(input.attendeeEmail?.trim()))
    } catch (firstError) {
      if (input.attendeeEmail?.trim()) {
        logger.warn('Google Calendar create with attendee failed; retrying without attendee', firstError)
        data = await tryCreate(false)
      } else {
        throw firstError
      }
    }

    if (!data?.id) {
      logger.warn('Google Calendar create returned no event id')
      return null
    }

    const meetLink = extractMeetLink(data)
    if (!meetLink) {
      logger.warn('Google Calendar event created without Meet link', {
        eventId: data.id,
        hasHangoutLink: Boolean(data.hangoutLink),
        conferenceEntryPoints: data.conferenceData?.entryPoints?.length ?? 0,
      })
    } else {
      logger.info('Google Calendar event created', { eventId: data.id, hasMeetLink: true })
    }

    return {
      eventId: data.id,
      meetLink,
      htmlLink: data.htmlLink || null,
    }
  } catch (error) {
    logger.error('Google Calendar createMeetingEvent failed', error)
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

    const data = (await calendarFetch(`/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      accessToken,
      body: JSON.stringify(eventBody(input, false)),
    })) as {
      id?: string
      hangoutLink?: string
      htmlLink?: string
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
    }

    return {
      eventId: data.id || eventId,
      meetLink: extractMeetLink(data),
      htmlLink: data.htmlLink || null,
    }
  } catch (error) {
    logger.error('Google Calendar updateMeetingEvent failed', error)
    return null
  }
}

const deleteMeetingEvent = async (eventId: string): Promise<boolean> => {
  try {
    const accessToken = await getAccessToken()
    if (!accessToken) return false

    await calendarFetch(`/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      accessToken,
    })
    return true
  } catch (error) {
    logger.error('Google Calendar deleteMeetingEvent failed', error)
    return false
  }
}

const googleCalendarService = {
  isConfigured,
  createMeetingEvent,
  updateMeetingEvent,
  deleteMeetingEvent,
}

export default googleCalendarService
