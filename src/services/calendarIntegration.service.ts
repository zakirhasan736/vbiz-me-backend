import config from '../configs/config'
import logger from '../utils/logger'
import googleCalendarService from './googleCalendar/googleCalendar.service'
import zohoCalendarService from './zohoCalendar/zohoCalendar.service'

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
  provider: 'zoho' | 'google'
}

export type CalendarProvider = 'zoho' | 'google' | 'none'

function resolveProvider(): CalendarProvider {
  const pref = (config.CALENDAR.PROVIDER || 'auto').toLowerCase()
  if (pref === 'zoho') return zohoCalendarService.isConfigured() ? 'zoho' : 'none'
  if (pref === 'google') return googleCalendarService.isConfigured() ? 'google' : 'none'
  if (zohoCalendarService.isConfigured()) return 'zoho'
  if (googleCalendarService.isConfigured()) return 'google'
  return 'none'
}

function providerForEventId(eventId: string | null | undefined): CalendarProvider {
  if (!eventId) return resolveProvider()
  if (eventId.includes('@zoho.com') || eventId.includes('::')) return 'zoho'
  return 'google'
}

function meetLabel(provider: CalendarProvider): string {
  if (provider === 'zoho') return 'Zoho Meeting'
  if (provider === 'google') return 'Google Meet'
  return 'Meeting'
}

const createMeetingEvent = async (input: CalendarMeetingInput): Promise<CalendarMeetingResult | null> => {
  const provider = resolveProvider()
  if (provider === 'none') {
    logger.warn('No calendar provider configured — meeting saved without calendar event')
    return null
  }

  if (provider === 'zoho') {
    const result = await zohoCalendarService.createMeetingEvent(input)
    return result ? { ...result, provider: 'zoho' } : null
  }

  const result = await googleCalendarService.createMeetingEvent(input)
  return result ? { ...result, provider: 'google' } : null
}

const updateMeetingEvent = async (
  eventId: string,
  input: CalendarMeetingInput
): Promise<CalendarMeetingResult | null> => {
  const provider = providerForEventId(eventId)
  if (provider === 'zoho') {
    const result = await zohoCalendarService.updateMeetingEvent(eventId, input)
    return result ? { ...result, provider: 'zoho' } : null
  }
  const result = await googleCalendarService.updateMeetingEvent(eventId, input)
  return result ? { ...result, provider: 'google' } : null
}

const deleteMeetingEvent = async (eventId: string): Promise<boolean> => {
  const provider = providerForEventId(eventId)
  if (provider === 'zoho') return zohoCalendarService.deleteMeetingEvent(eventId)
  return googleCalendarService.deleteMeetingEvent(eventId)
}

const calendarIntegrationService = {
  resolveProvider,
  meetLabel,
  createMeetingEvent,
  updateMeetingEvent,
  deleteMeetingEvent,
}

export default calendarIntegrationService
