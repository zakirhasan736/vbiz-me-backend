/** Same-visit dedupe window. Later visits (same day or another day) still notify. */
export const RETURNING_SAVED_GUEST_COOLDOWN_MS = 30 * 60 * 1000

export const RETURNING_SAVED_GUEST_EVENT = 'returning_saved_guest'

/** Display timezone for return-view copy (USA business default). */
export const RETURNING_VIEW_DISPLAY_TZ = 'America/New_York'

export function formatReturningViewWhen(at: Date = new Date(), timeZone = RETURNING_VIEW_DISPLAY_TZ): string {
  return at.toLocaleString('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
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
 * After concurrent creates, keep only the earliest claim in the cooldown window.
 * Returns true when `claimId` won the race.
 */
export function wonReturningGuestClaim(claimId: string, siblingIdsOldestFirst: string[]): boolean {
  if (!claimId || !siblingIdsOldestFirst.length) return false
  return siblingIdsOldestFirst[0] === claimId
}
