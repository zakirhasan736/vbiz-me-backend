/** Calendar-day dedupe (Eastern). Same viewer → one owner alert per day; next day can notify again. */
export const RETURNING_VIEW_DISPLAY_TZ = 'America/New_York'

export const RETURNING_SAVED_GUEST_EVENT = 'returning_saved_guest'

/**
 * Short race window only — same-day uniqueness is enforced with `returningGuestDayKey`.
 * @deprecated Prefer day-key claims; kept for concurrent create races.
 */
export const RETURNING_SAVED_GUEST_COOLDOWN_MS = 2 * 60 * 1000

export function formatReturningViewWhen(at: Date = new Date(), timeZone = RETURNING_VIEW_DISPLAY_TZ): string {
  return at.toLocaleString('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** YYYY-MM-DD in the display timezone — one owner alert (SMS/email/push/inbox) per viewer per this day. */
export function returningGuestDayKey(at: Date = new Date(), timeZone = RETURNING_VIEW_DISPLAY_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

export function buildReturningViewCopy(input: { guestName: string; when: string }) {
  const guestName = input.guestName.trim() || 'A visitor'
  const title = `${guestName} viewed your card again`
  const body = `${guestName} opened your vBiz Me card again on ${input.when}.`
  return { title, body, guestName }
}

export function returningGuestEventKey(profileId: string, guestId: string, eventLogId: string) {
  return `returning_saved_guest:${profileId}:${guestId}:${eventLogId}`
}

/**
 * After concurrent creates, keep only the earliest claim for that day.
 * Returns true when `claimId` won the race.
 */
export function wonReturningGuestClaim(claimId: string, siblingIdsOldestFirst: string[]): boolean {
  if (!claimId || !siblingIdsOldestFirst.length) return false
  return siblingIdsOldestFirst[0] === claimId
}
