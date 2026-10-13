import config from '../configs/config'
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

export type NotificationTopic = 'card' | 'crm'

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

export type NotifyExactCardOwnerOpts = {
  actor?: Actor
  profileId: string
  title: string
  body: string
  category?: string
  /** card backoffice vs CRM backoffice bell filtering */
  topic?: NotificationTopic
  /** When true, announcement service also fans push via sendPush meta. Prefer explicit push below. */
  sendPushViaAnnouncement?: boolean
  push?: Pick<PushPayload, 'title' | 'body' | 'type' | 'url'>
  /** Email the exact card owner (Zoho when configured). */
  sendEmail?: boolean
  emailSubject?: string
  emailHtml?: string
  href?: string
}

/**
 * In-app (inbox) + optional Web Push + optional email to the exact card owner.
 * Never fans out to corporate siblings or public-card savers.
 */
export async function notifyExactCardOwnerInbox(
  opts: NotifyExactCardOwnerOpts
): Promise<{ sent: boolean; ownerUserId: string | null; emails: string[] }> {
  const owner = await resolveExactCardOwner(opts.profileId)
  if (!owner) {
    return { sent: false, ownerUserId: null, emails: [] }
  }
  // Push + in-app still go out when the card has an owner account but no contact email yet.
  if (!owner.ownerUserId && !owner.emails.length) {
    return { sent: false, ownerUserId: null, emails: [] }
  }

  const actor = opts.actor || (await systemActor())
  const topic = opts.topic || (opts.category === 'event' || opts.category === 'note' ? 'crm' : 'card')
  const href = opts.href || (topic === 'crm' ? '/crm' : owner.slug ? `/vcards/edit/home/${owner.profileId}` : '/')

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
        topic,
        href,
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

  if (opts.sendEmail !== false && owner.emails.length && config.ZOHO_EMAIL_USER && config.ZOHO_EMAIL_PASSWORD) {
    const subject = opts.emailSubject?.trim() || opts.title
    const html =
      opts.emailHtml ||
      `<div style="font-family:sans-serif;line-height:1.5"><p>Hello ${escapeHtml(owner.displayName)},</p><p>${escapeHtml(opts.body)}</p><p>vBiz Me</p></div>`
    for (const email of owner.emails) {
      void authUtils
        .sendEmail({ receiverMail: email, subject, html })
        .catch((error) => logger.error('Exact owner email notify failed', { email, error }))
    }
  }

  return { sent: true, ownerUserId: owner.ownerUserId, emails: owner.emails }
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
          url: opts.push.url,
        },
        { audience: 'owners', allowPrivate: true }
      )
    }
  }

  if (opts.sendEmail !== false && email && config.ZOHO_EMAIL_USER && config.ZOHO_EMAIL_PASSWORD) {
    const subject = opts.emailSubject?.trim() || opts.title
    const html =
      opts.emailHtml ||
      `<div style="font-family:sans-serif;line-height:1.5"><p>Hello ${escapeHtml(
        user.name?.trim() || 'there'
      )},</p><p>${escapeHtml(opts.body)}</p><p>vBiz Me</p></div>`
    void authUtils
      .sendEmail({ receiverMail: email, subject, html })
      .catch((error) => logger.error('User email notify failed', { email, error }))
  }

  return { sent: true }
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
    // Guest’s own owner devices only — never follower/saver subscriptions on those cards.
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
