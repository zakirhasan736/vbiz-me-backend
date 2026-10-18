/** Push kinds that must arrive even when a card is unpublished or a content toggle is off. */
const OPERATIONAL_PUSH_TYPES = new Set(['meeting_alert', 'viewer_return', 'save_contact'])

/** Stored on PushSubscription.audience */
export type PushSubscriberKind = 'follower' | 'owner'

/**
 * Who should receive a Web Push for this event type on a card.
 * - followers: visitors who saved contact + allowed notifications on that public card
 * - owners: exact card owner / corporate member backoffice devices for that card
 * - all: every active subscription on that card (rare; e.g. guest receiving on their own card)
 */
export type PushDeliveryAudience = 'followers' | 'owners' | 'all'

export function isOperationalPushType(type: string) {
  return OPERATIONAL_PUSH_TYPES.has(type)
}

/**
 * Staff admins (ADMIN / SUPER_ADMIN) must not receive routine browser push.
 * They may still receive operational owner alerts on cards they personally own
 * (save_contact, viewer_return, meeting_alert).
 */
export function staffAdminAllowsBrowserPush(type: string) {
  return isOperationalPushType(type)
}

/** Notices and operational alerts still go to devices subscribed on an unpublished card. */
export function skipsPublicProfileGate(type: string) {
  return isOperationalPushType(type) || type === 'announcement_updates'
}

/**
 * Card edits notify only devices subscribed on that exact card
 * (and only when that subscription’s preference allows the type).
 * Do not fan out to a saver’s other cards — wrong URL / wrong card.
 */
export function cardChangeAlsoReachesSavers(_type: string) {
  return false
}

/**
 * Default Web Push audience for a push type.
 *
 * Responsibility matrix:
 * - Card content updates → followers (savers who allowed notifications)
 * - save_contact / viewer_return / meeting_alert → owners only (never public-card savers)
 * - announcement_updates → decided by caller (public → followers+owners, inbox → owners)
 *
 * Callers that need every subscription on a guest’s own card may pass audience: 'all'.
 */
export function defaultPushDeliveryAudience(type: string): PushDeliveryAudience {
  if (type === 'save_contact' || type === 'viewer_return' || type === 'meeting_alert') return 'owners'
  if (type === 'announcement_updates') return 'followers'
  return 'followers'
}

export function subscriberKindsForDelivery(audience: PushDeliveryAudience): PushSubscriberKind[] | null {
  if (audience === 'all') return null
  if (audience === 'owners') return ['owner']
  return ['follower']
}

export function mergeAnnouncementPushProfiles(input: {
  targetType: string
  showPublic: boolean
  explicitProfileIds: string[]
  emailMatchedProfileIds: string[]
  activeSubscriptionProfileIds: string[]
}) {
  const ids = new Set<string>()
  for (const id of input.explicitProfileIds) {
    if (id) ids.add(id)
  }
  for (const id of input.emailMatchedProfileIds) {
    if (id) ids.add(id)
  }
  if (input.showPublic && input.targetType === 'all') {
    for (const id of input.activeSubscriptionProfileIds) {
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Owner / member alerts must stay on the exact card profile.
 * Do not merge email-matched sibling cards (corporate parent / shared email).
 */
export function exactOwnerPushProfileIds(input: {
  primaryProfileId?: string | null
  /** Extra cards only when they are explicit invitees (group schedule), never email fan-out. */
  additionalProfileIds?: string[]
}) {
  const ids = new Set<string>()
  const primary = input.primaryProfileId?.trim()
  if (primary) ids.add(primary)
  for (const id of input.additionalProfileIds || []) {
    if (id?.trim()) ids.add(id.trim())
  }
  return [...ids]
}

/**
 * Whether a logged-in user should see a specific-targeted inbox notice.
 * Global (`targetType === 'all'`) is handled separately as a banner for everyone.
 */
export function userMatchesSpecificAnnouncement(input: {
  userId: string
  userEmail: string
  targetEmails: string[]
  metaUserId?: string | null
  metaProfileId?: string | null
  /** Profile ids where this user is the direct card owner (`profile.userId`). */
  ownedProfileIds: string[]
}) {
  const email = input.userEmail.trim().toLowerCase()
  const targetEmails = input.targetEmails.map((value) => value.trim().toLowerCase()).filter(Boolean)
  const metaUserId = input.metaUserId?.trim() || ''
  const metaProfileId = input.metaProfileId?.trim() || ''
  const owned = new Set(input.ownedProfileIds)

  if (metaUserId) return metaUserId === input.userId
  if (metaProfileId) return owned.has(metaProfileId)
  return Boolean(email && targetEmails.includes(email))
}
