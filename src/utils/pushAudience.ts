/** Push kinds that must arrive even when a card is unpublished or a content toggle is off. */
const OPERATIONAL_PUSH_TYPES = new Set(['meeting_alert', 'viewer_return', 'save_contact'])

export function isOperationalPushType(type: string) {
  return OPERATIONAL_PUSH_TYPES.has(type)
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
