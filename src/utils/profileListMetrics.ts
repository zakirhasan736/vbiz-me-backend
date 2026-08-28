import {
  countDistinctGuestsByChannel,
  SOCIAL_CHANNEL_LABELS,
  SOCIAL_CHANNELS,
  type SocialChannel,
} from './dashboardAnalytics'
import { prisma } from './prisma'

export type ProfileSocialClickRow = {
  channel: string
  label: string
  clickCount: number
}

export type ProfileEngagementMetrics = {
  clickCount: number
  saveCount: number
  shareCount: number
  socialClicks: ProfileSocialClickRow[]
}

/** Batch engagement metrics for profile list/card faces (aligned with sidebar APIs). */
export async function loadProfileEngagementMetrics(
  profileIds: string[]
): Promise<Map<string, ProfileEngagementMetrics>> {
  const metrics = new Map<string, ProfileEngagementMetrics>()
  for (const id of profileIds) {
    metrics.set(id, { clickCount: 0, saveCount: 0, shareCount: 0, socialClicks: [] })
  }
  if (!profileIds.length) return metrics

  const [socialEvents, guests] = await Promise.all([
    prisma.eventLog.findMany({
      where: { profileId: { in: profileIds }, eventType: 'social_click' },
      select: { profileId: true, payload: true },
    }),
    prisma.guestUserData.groupBy({
      by: ['profileId'],
      where: { profileId: { in: profileIds } },
      _count: { _all: true },
    }),
  ])

  const eventsByProfile = new Map<string, Array<{ payload: unknown }>>()
  for (const row of socialEvents) {
    if (!row.profileId) continue
    const list = eventsByProfile.get(row.profileId) || []
    list.push({ payload: row.payload })
    eventsByProfile.set(row.profileId, list)
  }

  for (const [profileId, rows] of eventsByProfile) {
    const m = metrics.get(profileId)
    if (!m) continue
    const counts = countDistinctGuestsByChannel(rows)
    const socialClicks: ProfileSocialClickRow[] = []
    let clickCount = 0
    for (const channel of SOCIAL_CHANNELS) {
      const n = counts.get(channel as SocialChannel) || 0
      if (n <= 0) continue
      clickCount += n
      socialClicks.push({
        channel,
        label: SOCIAL_CHANNEL_LABELS[channel as SocialChannel],
        clickCount: n,
      })
    }
    socialClicks.sort((a, b) => b.clickCount - a.clickCount)
    m.clickCount = clickCount
    m.shareCount = clickCount
    m.socialClicks = socialClicks
  }

  for (const g of guests) {
    const m = metrics.get(g.profileId)
    if (m) m.saveCount += g._count._all
  }

  return metrics
}
