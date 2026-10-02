/** Push kinds that must arrive even when a card is unpublished or a content toggle is off. */
const OPERATIONAL_PUSH_TYPES = new Set(['meeting_alert', 'viewer_return', 'save_contact'])

export function isOperationalPushType(type: string) {
  return OPERATIONAL_PUSH_TYPES.has(type)
}

/** Notices and operational alerts still go to devices subscribed on an unpublished card. */
export function skipsPublicProfileGate(type: string) {
  return isOperationalPushType(type) || type === 'announcement_updates'
}

/** Card edits should also reach a saver who allowed push on their own account. */
export function cardChangeAlsoReachesSavers(type: string) {
  return !isOperationalPushType(type)
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
