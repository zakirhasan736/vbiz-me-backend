import AppError from '../error/AppError'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { collectProfileNotificationEmails, resolveDirectOwnerUserId } from '../utils/profileNotificationEmails'
import type { SmsTopic } from '../utils/smsMessage'
import announcementService from './announcement.service'
import pushService, { type PushPayload } from './push.service'
import smsService from './sms.service'

type Actor = { id: string; email: string; name?: string | null }

export type ExactCardOwner = {
  profileId: string
  slug: string | null
  cardName: string
  ownerUserId: string | null
  emails: string[]
  displayName: string
}

async function systemActor(): Promise<Actor> {
  const admin = await prisma.user.findFirst({
    where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, deletedAt: null },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
  if (admin?.email) {
    return { id: admin.id, email: admin.email, name: admin.name }
  }
  return { id: 'system', email: 'system@vbizme.com', name: 'System' }
}

/** Resolve the direct card owner only — never the corporate parent of a member card. */
export async function resolveExactCardOwner(profileId: string): Promise<ExactCardOwner | null> {
  const id = profileId.trim()
  if (!id) return null

  const profile = await prisma.profile.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      email: true,
      userId: true,
      companyUserId: true,
      user: { select: { email: true, name: true } },
      companyUser: { select: { email: true, name: true } },
    },
  })
  if (!profile) return null

  const ownerUserId = resolveDirectOwnerUserId({
    userId: profile.userId,
    companyUserId: profile.companyUserId,
  })
  const emails = collectProfileNotificationEmails({
    profileEmail: profile.email,
    userEmail: profile.user?.email,
    companyUserEmail: profile.companyUser?.email,
  })

  return {
    profileId: profile.id,
    slug: profile.slug,
    cardName: profile.name?.trim() || profile.slug || 'your card',
    ownerUserId,
    emails,
    displayName: profile.user?.name?.trim() || profile.name?.trim() || 'vCard owner',
  }
}

/**
 * In-app (inbox) + optional Web Push to the exact card owner.
 * Does not send SMS/email — callers keep using existing sms/email helpers.
 */
export async function notifyExactCardOwnerInbox(opts: {
  actor?: Actor
  profileId: string
  title: string
  body: string
  category?: string
  /** When true, announcement service also fans push via sendPush meta. Prefer explicit push below. */
  sendPushViaAnnouncement?: boolean
  push?: Pick<PushPayload, 'title' | 'body' | 'type' | 'url'>
}): Promise<{ sent: boolean; ownerUserId: string | null; emails: string[] }> {
  const owner = await resolveExactCardOwner(opts.profileId)
  if (!owner?.emails.length) {
    return { sent: false, ownerUserId: owner?.ownerUserId ?? null, emails: owner?.emails ?? [] }
  }

  const actor = opts.actor || (await systemActor())
  try {
    await announcementService.create(actor, {
      type: 'info',
      kind: 'announcement',
      title: opts.title,
      body: opts.body,
      status: 'active',
      targetType: 'specific',
      targetEmails: owner.emails,
      meta: {
        channel: 'inbox',
        category: opts.category || 'event',
        profileId: owner.profileId,
        ...(owner.ownerUserId ? { userId: owner.ownerUserId } : {}),
        ...(owner.slug ? { slug: owner.slug } : {}),
        sendPush: opts.sendPushViaAnnouncement ? '1' : '0',
      },
    })
  } catch (error) {
    logger.error('Exact owner inbox notice failed', { profileId: opts.profileId, error })
    return { sent: false, ownerUserId: owner.ownerUserId, emails: owner.emails }
  }

  if (opts.push) {
    // Owner-device Web Push only — never public-card savers/followers.
    pushService.notifyProfileUpdate(
      owner.profileId,
      {
        title: opts.push.title,
        body: opts.push.body,
        type: opts.push.type,
        url: opts.push.url,
      },
      { audience: 'owners', allowPrivate: true }
    )
  }

  return { sent: true, ownerUserId: owner.ownerUserId, emails: owner.emails }
}

/** Notify a visitor/requester by email + push on their own cards + SMS when phone present. */
export async function notifyVisitorChannels(opts: {
  email?: string | null
  phone?: string | null
  title: string
  body: string
  emailHtml?: string
  smsTopic?: SmsTopic
  cardName?: string
  cardUrl?: string
  pushType?: string
}): Promise<void> {
  const email = opts.email?.trim().toLowerCase() || ''
  const phone = opts.phone?.trim() || ''

  if (email) {
    if (opts.emailHtml) {
      void authUtils
        .sendEmail({
          receiverMail: email,
          subject: opts.title,
          html: opts.emailHtml,
        })
        .catch((error) => logger.error('Visitor email notify failed', { email, error }))
    }
    for (const profileId of await pushService.profileIdsMatchingEmails([email])) {
      pushService.notifyProfileUpdate(profileId, {
        title: opts.title,
        body: opts.body,
        type: opts.pushType || 'meeting_alert',
      })
    }
  }

  if (phone && opts.smsTopic) {
    smsService.sendTopicSms({
      to: phone,
      topic: opts.smsTopic,
      cardName: opts.cardName || 'vBiz card',
      cardUrl: opts.cardUrl || '',
      detail: opts.body,
    })
  }
}

export async function requireExactCardOwner(profileId: string): Promise<ExactCardOwner> {
  const owner = await resolveExactCardOwner(profileId)
  if (!owner) throw new AppError(404, 'Profile not found')
  return owner
}

const exactOwnerNotifyService = {
  resolveExactCardOwner,
  notifyExactCardOwnerInbox,
  notifyVisitorChannels,
  requireExactCardOwner,
}

export default exactOwnerNotifyService
