import config from '../configs/config'
import AppError from '../error/AppError'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { buildOwnerNotifyEmailHtml, type OwnerNotifyEmailDetail } from '../utils/ownerNotifyEmail'
import { prisma } from '../utils/prisma'
import { collectProfileNotificationEmails, resolveDirectOwnerUserId } from '../utils/profileNotificationEmails'
import { buildOwnerBackofficePath } from '../utils/pushOwnerDeepLink'
import type { SmsTopic } from '../utils/smsMessage'
import announcementService from './announcement.service'
import { recordNotificationDeliveryAttempt } from './notificationDeliveryAudit.service'
import pushService, { type PushPayload } from './push.service'
import smsService from './sms.service'

type Actor = { id: string; email: string; name?: string | null }

export type NotificationTopic = 'card' | 'crm'

export type ExactCardOwner = {
  profileId: string
  slug: string | null
  cardName: string
  ownerUserId: string | null
  /** Corporate parent login when this is a linked member card. */
  companyUserId: string | null
  /** Direct owner + corporate parent emails for linked-card responsible parties. */
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

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
  // Include corporate parent email on linked member cards so HQ gets responsible email too.
  const emails = collectProfileNotificationEmails({
    profileEmail: profile.email,
    userEmail: profile.user?.email,
    companyUserEmail: profile.companyUser?.email,
    includeCompanyUser: Boolean(profile.companyUserId && profile.userId && profile.companyUserId !== profile.userId),
  })

  return {
    profileId: profile.id,
    slug: profile.slug,
    cardName: profile.name?.trim() || profile.slug || 'your card',
    ownerUserId,
    companyUserId: profile.companyUserId?.trim() || null,
    emails,
    displayName: profile.user?.name?.trim() || profile.name?.trim() || 'vCard owner',
  }
}

export type NotifyExactCardOwnerOpts = {
  actor?: Actor
  profileId: string
  title: string
  body: string
  category?: string
  /** card backoffice vs CRM backoffice bell filtering */
  topic?: NotificationTopic
  /** Stable key for delivery audit / idempotency across channels. */
  eventKey?: string
  /** When true, announcement service also fans push via sendPush meta. Prefer explicit push below. */
  sendPushViaAnnouncement?: boolean
  push?: Pick<PushPayload, 'title' | 'body' | 'type' | 'url'>
  /** Email the exact card owner (Zoho when configured). */
  sendEmail?: boolean
  emailSubject?: string
  emailHtml?: string
  /** Extra identity rows in the default owner email (name, phone, etc.). */
  emailDetails?: OwnerNotifyEmailDetail[]
  href?: string
  /** SMS the card phone (owner channel), audited independently. */
  sendSms?: boolean
  smsTopic?: SmsTopic
  smsDetail?: string
}

export type NotifyExactCardOwnerResult = {
  sent: boolean
  ownerUserId: string | null
  emails: string[]
  eventKey: string
  channels: {
    inbox: 'sent' | 'failed' | 'skipped'
    push: 'queued' | 'skipped' | 'failed'
    email: 'sent' | 'failed' | 'skipped' | 'pending'
    sms: 'sent' | 'failed' | 'skipped' | 'pending'
  }
}

/**
 * In-app (inbox) + optional Web Push + optional email + optional SMS to the exact card owner.
 * Never fans out to corporate siblings or public-card savers.
 * Channel failures are independent — inbox failure does not suppress push/email/SMS.
 */
export async function notifyExactCardOwnerInbox(opts: NotifyExactCardOwnerOpts): Promise<NotifyExactCardOwnerResult> {
  const owner = await resolveExactCardOwner(opts.profileId)
  const eventKey = opts.eventKey?.trim() || `exact_owner:${opts.profileId}:${opts.category || 'event'}:${Date.now()}`
  const emptyChannels = {
    inbox: 'skipped' as const,
    push: 'skipped' as const,
    email: 'skipped' as const,
    sms: 'skipped' as const,
  }
  if (!owner) {
    return { sent: false, ownerUserId: null, emails: [], eventKey, channels: emptyChannels }
  }
  // Push + in-app still go out when the card has an owner account but no contact email yet.
  if (!owner.ownerUserId && !owner.emails.length) {
    return { sent: false, ownerUserId: null, emails: [], eventKey, channels: emptyChannels }
  }

  const actor = opts.actor || (await systemActor())
  const topic = opts.topic || (opts.category === 'event' || opts.category === 'note' ? 'crm' : 'card')
  const href = opts.href || (topic === 'crm' ? '/crm' : owner.slug ? `/vcards/edit/home/${owner.profileId}` : '/')
  const channels: NotifyExactCardOwnerResult['channels'] = {
    inbox: 'skipped',
    push: 'skipped',
    email: 'skipped',
    sms: 'skipped',
  }

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
        onlyBackoffice: '1',
        showPublic: '0',
        category: opts.category || 'event',
        topic,
        href,
        profileId: owner.profileId,
        eventKey,
        ...(owner.ownerUserId ? { userId: owner.ownerUserId } : {}),
        ...(owner.slug ? { slug: owner.slug } : {}),
        sendPush: opts.sendPushViaAnnouncement ? '1' : '0',
      },
    })
    channels.inbox = 'sent'
    void recordNotificationDeliveryAttempt({
      eventKey,
      channel: 'inbox',
      status: 'sent',
      profileId: owner.profileId,
      recipientRole: 'card_owner',
      recipientRef: owner.ownerUserId,
      relatedRecordId: owner.profileId,
    })
  } catch (error) {
    logger.error('Exact owner inbox notice failed', { profileId: opts.profileId, error })
    channels.inbox = 'failed'
    void recordNotificationDeliveryAttempt({
      eventKey,
      channel: 'inbox',
      status: 'failed',
      profileId: owner.profileId,
      recipientRole: 'card_owner',
      error: error instanceof Error ? error.message : 'inbox_failed',
    })
    // Continue — push / email / SMS must still run independently.
  }

  if (opts.push) {
    try {
      const pushPayload = {
        title: opts.push.title,
        body: opts.push.body,
        type: opts.push.type,
        // Prefer explicit push URL, then CRM/backoffice href — never silent public-card fallback.
        url: opts.push.url || opts.href || buildOwnerBackofficePath('calendar'),
      }
      // Web Push + SW: delivers after first Allow even when backoffice/card tab is closed.
      const pushTargets = new Set<string>([owner.profileId])
      if (owner.companyUserId) {
        const corpCards = await prisma.profile.findMany({
          where: { userId: owner.companyUserId },
          select: { id: true },
          take: 20,
        })
        for (const row of corpCards) pushTargets.add(row.id)
      }
      let sentCount = 0
      for (const targetProfileId of pushTargets) {
        const pushResult = await pushService.sendToProfile(targetProfileId, pushPayload, {
          audience: 'owners',
          allowPrivate: true,
          includeSavers: false,
        })
        sentCount += pushResult?.sent ?? 0
      }
      channels.push = sentCount > 0 ? 'queued' : 'skipped'
      void recordNotificationDeliveryAttempt({
        eventKey,
        channel: 'push',
        status: sentCount > 0 ? 'queued' : 'skipped',
        profileId: owner.profileId,
        recipientRole: 'card_owner',
        error: sentCount > 0 ? null : 'no_eligible_owner_subscription',
        meta: { type: opts.push.type, sent: sentCount, targets: [...pushTargets] },
      })
    } catch (error) {
      channels.push = 'failed'
      void recordNotificationDeliveryAttempt({
        eventKey,
        channel: 'push',
        status: 'failed',
        profileId: owner.profileId,
        recipientRole: 'card_owner',
        error: error instanceof Error ? error.message : 'push_failed',
        meta: { type: opts.push.type },
      })
    }
  }

  if (opts.sendEmail !== false && owner.emails.length && config.ZOHO_EMAIL_USER && config.ZOHO_EMAIL_PASSWORD) {
    channels.email = 'pending'
    const subject = opts.emailSubject?.trim() || opts.title
    const html =
      opts.emailHtml ||
      buildOwnerNotifyEmailHtml({
        greetingName: owner.displayName,
        title: opts.title,
        body: opts.body,
        topic,
        href,
        cardName: owner.cardName,
        details: opts.emailDetails,
      })
    for (const email of owner.emails) {
      void authUtils
        .sendEmail({ receiverMail: email, subject, html })
        .then(() => {
          channels.email = 'sent'
          return recordNotificationDeliveryAttempt({
            eventKey,
            channel: 'email',
            status: 'sent',
            profileId: owner.profileId,
            recipientRole: 'card_owner',
            recipientRef: email,
          })
        })
        .catch((error) => {
          channels.email = 'failed'
          logger.error('Exact owner email notify failed', { email, error })
          void recordNotificationDeliveryAttempt({
            eventKey,
            channel: 'email',
            status: 'failed',
            profileId: owner.profileId,
            recipientRole: 'card_owner',
            recipientRef: email,
            error: error instanceof Error ? error.message : 'email_failed',
          })
        })
    }
  } else if (opts.sendEmail !== false) {
    channels.email = 'skipped'
    void recordNotificationDeliveryAttempt({
      eventKey,
      channel: 'email',
      status: 'skipped',
      profileId: owner.profileId,
      recipientRole: 'card_owner',
      error: !owner.emails.length ? 'no_owner_email' : 'email_not_configured',
    })
  }

  if (opts.sendSms) {
    channels.sms = 'pending'
    try {
      const smsResult = await smsService.notifyProfilePhone(
        owner.profileId,
        opts.smsTopic || 'Notice',
        opts.smsDetail || opts.body
      )
      channels.sms = smsResult.sent ? 'sent' : 'skipped'
      void recordNotificationDeliveryAttempt({
        eventKey,
        channel: 'sms',
        status: smsResult.sent ? 'sent' : 'skipped',
        profileId: owner.profileId,
        recipientRole: 'card_owner',
        error: smsResult.sent ? null : smsResult.reason || 'sms_not_sent',
        meta: { topic: opts.smsTopic || 'Notice' },
      })
    } catch (error) {
      channels.sms = 'failed'
      void recordNotificationDeliveryAttempt({
        eventKey,
        channel: 'sms',
        status: 'failed',
        profileId: owner.profileId,
        recipientRole: 'card_owner',
        error: error instanceof Error ? error.message : 'sms_failed',
      })
    }
  }

  const anyChannel =
    channels.inbox === 'sent' ||
    channels.push === 'queued' ||
    channels.email === 'sent' ||
    channels.email === 'pending' ||
    channels.sms === 'sent' ||
    channels.sms === 'pending'

  return { sent: anyChannel, ownerUserId: owner.ownerUserId, emails: owner.emails, eventKey, channels }
}

/** In-app + email + owner push for a login user (assignee / partner), not tied to one card. */
export async function notifyUserInbox(opts: {
  actor?: Actor
  userId: string
  title: string
  body: string
  category?: string
  topic?: NotificationTopic
  href?: string
  sendEmail?: boolean
  emailSubject?: string
  emailHtml?: string
  emailDetails?: OwnerNotifyEmailDetail[]
  push?: Pick<PushPayload, 'title' | 'body' | 'type' | 'url'>
}): Promise<{ sent: boolean }> {
  const userId = opts.userId.trim()
  if (!userId) return { sent: false }

  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, email: true, name: true },
  })
  if (!user) return { sent: false }

  const email = user.email?.trim().toLowerCase() || ''
  const actor = opts.actor || (await systemActor())
  const topic = opts.topic || 'crm'
  const href = opts.href || (topic === 'crm' ? '/crm' : '/')

  try {
    await announcementService.create(actor, {
      type: 'info',
      kind: 'announcement',
      title: opts.title,
      body: opts.body,
      status: 'active',
      targetType: 'specific',
      targetEmails: email ? [email] : [],
      meta: {
        channel: 'inbox',
        onlyBackoffice: '1',
        showPublic: '0',
        category: opts.category || 'note',
        topic,
        href,
        userId: user.id,
        sendPush: '0',
      },
    })
  } catch (error) {
    logger.error('User inbox notice failed', { userId, error })
    return { sent: false }
  }

  if (opts.push) {
    const owned = await prisma.profile.findMany({
      where: { userId: user.id },
      select: { id: true },
      take: 20,
    })
    for (const profile of owned) {
      pushService.notifyProfileUpdate(
        profile.id,
        {
          title: opts.push.title,
          body: opts.push.body,
          type: opts.push.type,
          url: opts.push.url || opts.href || buildOwnerBackofficePath('crm_notes'),
        },
        { audience: 'owners', allowPrivate: true }
      )
    }
  }

  if (opts.sendEmail !== false && email && config.ZOHO_EMAIL_USER && config.ZOHO_EMAIL_PASSWORD) {
    const subject = opts.emailSubject?.trim() || opts.title
    const html =
      opts.emailHtml ||
      buildOwnerNotifyEmailHtml({
        greetingName: user.name?.trim() || 'there',
        title: opts.title,
        body: opts.body,
        topic,
        href,
        details: opts.emailDetails,
      })
    void authUtils
      .sendEmail({ receiverMail: email, subject, html })
      .catch((error) => logger.error('User email notify failed', { email, error }))
  }

  return { sent: true }
}

/** Notify a visitor/requester by email (+ optional push/SMS). */
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
  /**
   * When true, push to devices on cards the recipient directly owns (owner audience).
   * Used for scheduled wish delivery to selected leads — not for public card-saver fan-out.
   */
  allowPush?: boolean
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
    if (opts.allowPush) {
      // Recipient's own owner devices only — never follower/saver subscriptions on the card owner's card.
      for (const profileId of await pushService.profileIdsMatchingEmails([email])) {
        pushService.notifyProfileUpdate(
          profileId,
          {
            title: opts.title,
            body: opts.body,
            type: opts.pushType || 'meeting_alert',
          },
          { audience: 'owners', allowPrivate: true }
        )
      }
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
  notifyUserInbox,
  notifyVisitorChannels,
  requireExactCardOwner,
}

export default exactOwnerNotifyService
