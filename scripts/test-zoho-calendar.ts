/**
 * Live smoke test for Zoho Calendar + Zoho Meeting.
 * Usage: npx tsx --env-file=.env scripts/test-zoho-calendar.ts
 */
import calendarIntegrationService from '../src/services/calendarIntegration.service'
import zohoCalendarService from '../src/services/zohoCalendar/zohoCalendar.service'

function tomorrowIsoDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function main() {
  const provider = calendarIntegrationService.resolveProvider()
  console.log('calendar provider:', provider)
  console.log('zoho configured:', zohoCalendarService.isConfigured())

  if (provider !== 'zoho') {
    console.error('FAIL: expected provider zoho')
    process.exitCode = 1
    return
  }

  const date = tomorrowIsoDate()
  const created = await calendarIntegrationService.createMeetingEvent({
    summary: 'vBiz Me Zoho smoke test',
    description: 'Temporary test event — safe to delete.',
    date,
    time: '10:15 AM',
    durationMinutes: 15,
  })

  console.log('create result:', {
    eventId: created?.eventId || null,
    meetLink: created?.meetLink || null,
    htmlLink: created?.htmlLink || null,
    provider: created?.provider || null,
  })

  if (!created?.eventId) {
    console.error('FAIL: create returned no eventId')
    process.exitCode = 1
    return
  }

  if (!created.meetLink) {
    console.error('FAIL: create returned no Zoho Meeting link')
    process.exitCode = 2
  } else {
    console.log('PASS: Zoho Meeting link created')
  }

  const deleted = await calendarIntegrationService.deleteMeetingEvent(created.eventId)
  console.log(deleted ? 'PASS: deleted test event' : 'WARN: delete failed (remove smoke events in Zoho Calendar)')
  if (!deleted) process.exitCode = process.exitCode || 3
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exitCode = 1
})
