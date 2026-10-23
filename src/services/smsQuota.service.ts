import { parseSmsMonthlyLimitFeature, smsMonthlyLimitForPackageSlug } from '../constants/smsEntitlement'
import { toApiRole } from '../constants/userRole'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { findLinkedCorporateParentUserId, getEffectiveEntitlements } from './entitlement.service'

export type SmsQuotaDecision = {
  allowed: boolean
  reason?: 'no_owner' | 'sms_not_included' | 'sms_quota_exceeded'
  limit: number
  used: number
  remaining: number
  billingUserId: string | null
  monthKey: string
}

function utcMonthBounds(at = new Date()) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  const monthKey = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`
  return { start, end, monthKey }
}

async function resolveBillingUserIdForProfile(profileId: string): Promise<{
  billingUserId: string | null
  role: string | null
}> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      userId: true,
      companyUserId: true,
      user: { select: { role: true } },
      companyUser: { select: { role: true } },
    },
  })
  if (!profile) return { billingUserId: null, role: null }

  // Seat pool: linked members share the corporate parent's SMS quota.
  const directUserId = profile.userId?.trim() || null
  if (directUserId) {
    const parentId = await findLinkedCorporateParentUserId(directUserId)
    if (parentId) {
      const parent = await prisma.user.findFirst({
        where: { id: parentId, deletedAt: null },
        select: { role: true },
      })
      return { billingUserId: parentId, role: parent ? toApiRole(parent.role) : 'corporate-owner' }
    }
    return {
      billingUserId: directUserId,
      role: profile.user ? toApiRole(profile.user.role) : null,
    }
  }

  if (profile.companyUserId) {
    return {
      billingUserId: profile.companyUserId,
      role: profile.companyUser ? toApiRole(profile.companyUser.role) : 'corporate-owner',
    }
  }

  return { billingUserId: null, role: null }
}

async function resolveLimit(billingUserId: string, role: string | null): Promise<number> {
  const entitlements = await getEffectiveEntitlements(billingUserId, role)
  const feature = entitlements.features.find((row) => row.featureKey.trim().toLowerCase() === 'sms_monthly_limit')
  const fromFeature = parseSmsMonthlyLimitFeature(feature?.featureValue)
  if (fromFeature != null) return fromFeature
  return smsMonthlyLimitForPackageSlug(entitlements.packageSlug)
}

async function countSentOwnerSms(billingUserId: string, start: Date, end: Date): Promise<number> {
  // Count successful owner SMS for every card in this seat pool this UTC month.
  const profiles = await prisma.profile.findMany({
    where: { OR: [{ userId: billingUserId }, { companyUserId: billingUserId }] },
    select: { id: true },
    take: 500,
  })
  const profileIds = profiles.map((row) => row.id)
  if (!profileIds.length) return 0

  return prisma.notificationDeliveryAttempt.count({
    where: {
      channel: 'sms',
      status: 'sent',
      recipientRole: 'card_owner',
      profileId: { in: profileIds },
      createdAt: { gte: start, lt: end },
    },
  })
}

/**
 * Decide whether this card's owner seat still has SMS capacity this month.
 * Free / exhausted → allowed=false (callers keep push + email).
 */
export async function evaluateOwnerSmsQuota(profileId: string): Promise<SmsQuotaDecision> {
  const { start, end, monthKey } = utcMonthBounds()
  const { billingUserId, role } = await resolveBillingUserIdForProfile(profileId)
  if (!billingUserId) {
    return {
      allowed: false,
      reason: 'no_owner',
      limit: 0,
      used: 0,
      remaining: 0,
      billingUserId: null,
      monthKey,
    }
  }

  const limit = await resolveLimit(billingUserId, role)
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      allowed: false,
      reason: 'sms_not_included',
      limit: 0,
      used: 0,
      remaining: 0,
      billingUserId,
      monthKey,
    }
  }

  const used = await countSentOwnerSms(billingUserId, start, end)
  const remaining = Math.max(0, limit - used)
  if (remaining <= 0) {
    logger.info('Owner SMS skipped: monthly limit reached', { profileId, billingUserId, limit, used, monthKey })
    return {
      allowed: false,
      reason: 'sms_quota_exceeded',
      limit,
      used,
      remaining: 0,
      billingUserId,
      monthKey,
    }
  }

  return {
    allowed: true,
    limit,
    used,
    remaining,
    billingUserId,
    monthKey,
  }
}

const smsQuotaService = {
  evaluateOwnerSmsQuota,
  utcMonthBounds,
}

export default smsQuotaService
