import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { buildFrontendPublicCardUrl } from '../constants/frontendPublicCardPath'
import { isStaffRole, toApiRole } from '../constants/userRole'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { birthdayPersonKey } from '../utils/smsMessage'
import { profileOwnerAllowsPackageAccess } from './entitlement.service'
import { recordNotificationDeliveryAttempt } from './notificationDeliveryAudit.service'
import pushService from './push.service'
import smsService from './sms.service'

type OwnerCandidate = {
  id: string
  email: string
  name: string | null
  role: PrismaUserRole
}

type BirthdayProfile = {
  id: string
  name: string
  slug: string | null
  phone: string | null
  countryCode: string | null
  dob: Date
  addresses?: { country: string | null }[]
  user: OwnerCandidate | null
  companyUser: OwnerCandidate | null
}

export type BirthdayWishRunResult = {
  checked: number
  matched: number
  sent: number
  skipped: number
  errors: number
  year: number
  dateKey: string
  timeZone: string
}

const ownerSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
} as const

const DEFAULT_BIRTHDAY_TZ = 'America/New_York'

function calendarPartsInTz(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)

  const year = Number(parts.find((p) => p.type === 'year')?.value)
  const month = Number(parts.find((p) => p.type === 'month')?.value)
  const day = Number(parts.find((p) => p.type === 'day')?.value)

  if (!year || !month || !day) {
    throw new Error(`Unable to resolve calendar parts for timezone ${timeZone}`)
  }

  return { year, month, day }
}

function dobMonthDay(dob: Date): { month: number; day: number } {
  return { month: dob.getUTCMonth() + 1, day: dob.getUTCDate() }
}

function firstNameFrom(name: string | null | undefined): string {
  const trimmed = name?.trim() || ''
  if (!trimmed) return 'there'
  return trimmed.split(/\s+/)[0] || 'there'
}

function isEligibleOwner(user: OwnerCandidate | null | undefined): user is OwnerCandidate {
  if (!user?.email?.trim()) return false
  const apiRole = toApiRole(user.role)
  if (isStaffRole(apiRole)) return false
  if (apiRole !== 'vcard-owner' && apiRole !== 'corporate-owner') return false
  return true
}

/** Prefer personal owner, then corporate owner. Never staff. Never public contacts. */
function resolveNonStaffOwner(profile: BirthdayProfile): OwnerCandidate | null {
  if (isEligibleOwner(profile.user)) return profile.user
  if (isEligibleOwner(profile.companyUser)) return profile.companyUser
  return null
}

function personRegion(profile: BirthdayProfile) {
  return profile.countryCode?.trim() || profile.addresses?.[0]?.country?.trim() || null
}

function featuredCard(group: BirthdayProfile[]) {
  return [...group].sort((a, b) => {
    if (Boolean(a.slug) !== Boolean(b.slug)) return a.slug ? -1 : 1
    return a.name.localeCompare(b.name)
  })[0]
}

function cardPublicUrl(slug: string | null, profileId: string): string {
  const base = (config.FRONTEND_URL || '').replace(/\/$/, '')
  if (slug?.trim()) return buildFrontendPublicCardUrl(base, slug.trim())
  return `${base}/vcards/edit/home/${profileId}`
}

function eventKeyFor(profileId: string, year: number, dateKey: string) {
  return `birthday_llc:${profileId}:${year}:${dateKey}`
}

async function sendBirthdayEmail(opts: {
  owner: OwnerCandidate
  firstName: string
  eventKey: string
  profileId: string
}) {
  const html = authUtils.applyTemplateVars(authUtils.readTemplate('birthday_wish.html'), {
    first_name: opts.firstName,
    owner_name: opts.firstName,
  })

  try {
    await authUtils.sendEmail({
      receiverMail: opts.owner.email.trim(),
      subject: 'Happy Birthday from vBiz Me LLC!',
      html,
    })
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'email',
      status: 'sent',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      recipientRef: opts.owner.email.trim().toLowerCase(),
      meta: { sender: 'vBiz Me LLC' },
    })
  } catch (error) {
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'email',
      status: 'failed',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      recipientRef: opts.owner.email.trim().toLowerCase(),
      error: error instanceof Error ? error.message : 'email_failed',
    })
    throw error
  }
}

async function sendBirthdayOwnerPush(opts: {
  profileId: string
  firstName: string
  slug: string | null
  eventKey: string
}) {
  const title = `Happy Birthday, ${opts.firstName}! 🎉`
  const body = 'Wishing you a wonderful day and a successful year ahead. With warm wishes from the vBiz Me LLC team.'
  try {
    const result = await pushService.sendToProfile(
      opts.profileId,
      {
        title,
        body,
        type: 'announcement_updates',
        ...(opts.slug ? { slug: opts.slug } : {}),
      },
      {
        audience: 'owners',
        allowPrivate: true,
        includeSavers: false,
      }
    )
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'push',
      status: result.sent > 0 ? 'sent' : 'skipped',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      error: result.sent > 0 ? null : 'no_eligible_owner_subscription',
      meta: { sent: result.sent, sender: 'vBiz Me LLC' },
    })
  } catch (error) {
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'push',
      status: 'failed',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      error: error instanceof Error ? error.message : 'push_failed',
    })
  }
}

async function createOwnerInboxNotice(opts: {
  ownerEmail: string
  ownerUserId?: string | null
  firstName: string
  profileId: string
  slug: string | null
  eventKey: string
}) {
  const title = `Happy Birthday, ${opts.firstName}!`
  const body =
    'Happy Birthday from all of us at vBiz Me LLC! We hope your special day brings you happiness, success, and wonderful new opportunities.'

  try {
    await prisma.announcement.create({
      data: {
        kind: 'announcement',
        type: 'success',
        title,
        body,
        status: 'active',
        targetType: 'specific',
        targetEmails: [opts.ownerEmail.trim().toLowerCase()],
        meta: {
          channel: 'inbox',
          kind: 'birthday',
          sender: 'vBiz Me LLC',
          showPublic: '0',
          onlyBackoffice: '1',
          profileId: opts.profileId,
          ...(opts.ownerUserId?.trim() ? { userId: opts.ownerUserId.trim() } : {}),
          ...(opts.slug ? { slug: opts.slug } : {}),
        },
        createdById: null,
      },
    })
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'inbox',
      status: 'sent',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      recipientRef: opts.ownerEmail.trim().toLowerCase(),
    })
  } catch (error) {
    await recordNotificationDeliveryAttempt({
      eventKey: opts.eventKey,
      channel: 'inbox',
      status: 'failed',
      profileId: opts.profileId,
      recipientRole: 'card_owner',
      error: error instanceof Error ? error.message : 'inbox_failed',
    })
    throw error
  }
}

const runDailyBirthdayWishes = async (opts?: { timeZone?: string }): Promise<BirthdayWishRunResult> => {
  const timeZone = (opts?.timeZone || config.BIRTHDAY_CRON.TZ || DEFAULT_BIRTHDAY_TZ).trim() || DEFAULT_BIRTHDAY_TZ
  const today = calendarPartsInTz(new Date(), timeZone)
  const dateKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
  const wishDateLabel = new Date(Date.UTC(today.year, today.month - 1, today.day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const result: BirthdayWishRunResult = {
    checked: 0,
    matched: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    year: today.year,
    dateKey,
    timeZone,
  }

  // Audience: eligible card owners only (personal or corporate). Never public saved contacts.
  const profiles = (await prisma.profile.findMany({
    where: { dob: { not: null } },
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      countryCode: true,
      dob: true,
      addresses: { orderBy: { isPrimary: 'desc' }, select: { country: true }, take: 1 },
      user: { select: ownerSelect },
      companyUser: { select: ownerSelect },
    },
  })) as BirthdayProfile[]

  result.checked = profiles.length

  const due: BirthdayProfile[] = []
  for (const profile of profiles) {
    if (!profile.dob) {
      result.skipped += 1
      continue
    }
    const { month, day } = dobMonthDay(profile.dob)
    if (month !== today.month || day !== today.day) continue
    result.matched += 1
    if (!resolveNonStaffOwner(profile)) {
      result.skipped += 1
      continue
    }
    due.push(profile)
  }

  const existingLogs = due.length
    ? await prisma.birthdayWishLog.findMany({
        where: { year: today.year, profileId: { in: due.map((profile) => profile.id) } },
        select: { profileId: true },
      })
    : []
  const alreadyWished = new Set(existingLogs.map((row) => row.profileId))

  const groups = new Map<string, BirthdayProfile[]>()
  for (const profile of due) {
    const { month, day } = dobMonthDay(profile.dob)
    const key = birthdayPersonKey(profile.phone, personRegion(profile), month, day) ?? `card:${profile.id}`
    const list = groups.get(key) ?? []
    list.push(profile)
    groups.set(key, list)
  }

  const deliverCard = async (profile: BirthdayProfile) => {
    const owner = resolveNonStaffOwner(profile)
    if (!owner) {
      result.skipped += 1
      return false
    }
    const eventKey = eventKeyFor(profile.id, today.year, dateKey)
    const firstName = firstNameFrom(owner.name || profile.name)

    try {
      await prisma.birthdayWishLog.create({
        data: { profileId: profile.id, year: today.year },
      })
    } catch {
      result.skipped += 1
      await recordNotificationDeliveryAttempt({
        eventKey,
        channel: 'inbox',
        status: 'skipped',
        profileId: profile.id,
        recipientRole: 'card_owner',
        error: 'already_sent_this_year',
      })
      return false
    }

    try {
      const allowEmail = await profileOwnerAllowsPackageAccess(profile.id, 'allow_email_notification')
      if (allowEmail) {
        await sendBirthdayEmail({ owner, firstName, eventKey, profileId: profile.id })
      } else {
        await recordNotificationDeliveryAttempt({
          eventKey,
          channel: 'email',
          status: 'skipped',
          profileId: profile.id,
          recipientRole: 'card_owner',
          error: 'package_disallows_email',
        })
      }

      await createOwnerInboxNotice({
        ownerEmail: owner.email,
        ownerUserId: owner.id,
        firstName,
        profileId: profile.id,
        slug: profile.slug,
        eventKey,
      })

      // Owner push only — never followers / public savers.
      await sendBirthdayOwnerPush({
        profileId: profile.id,
        firstName,
        slug: profile.slug,
        eventKey,
      })

      result.sent += 1
      return true
    } catch (error) {
      result.errors += 1
      logger.error(`Birthday wish failed for profile ${profile.id}`, error)
      await prisma.birthdayWishLog
        .delete({ where: { profileId_year: { profileId: profile.id, year: today.year } } })
        .catch(() => {})
      return false
    }
  }

  for (const [key, group] of groups) {
    const fresh = group.filter((profile) => !alreadyWished.has(profile.id))
    result.skipped += group.length - fresh.length
    if (!fresh.length) continue

    let delivered = 0
    for (const profile of fresh) {
      if (await deliverCard(profile)) delivered += 1
    }

    const personKey = !key.startsWith('card:')
    const alreadyTexted = group.some((profile) => alreadyWished.has(profile.id))
    if (!personKey || delivered < 1 || alreadyTexted) continue

    const card = featuredCard(group)
    const count = group.length
    const smsEventKey = eventKeyFor(card.id, today.year, dateKey)
    if (!card.phone?.trim()) {
      await recordNotificationDeliveryAttempt({
        eventKey: smsEventKey,
        channel: 'sms',
        status: 'skipped',
        profileId: card.id,
        recipientRole: 'card_owner',
        error: 'missing_phone',
        meta: { sender: 'vBiz Me LLC' },
      })
      continue
    }
    smsService.sendTopicSms({
      to: card.phone,
      countryCode: personRegion(card),
      topic: 'Birthday',
      cardName: card.name.trim() || 'your card',
      cardUrl: cardPublicUrl(card.slug, card.id),
      detail:
        count > 1
          ? `Happy Birthday from vBiz Me LLC! Today is ${wishDateLabel}. This number is on ${count} cards with this birthday.`
          : `Happy Birthday from vBiz Me LLC! Today is ${wishDateLabel}.`,
    })
    await recordNotificationDeliveryAttempt({
      eventKey: smsEventKey,
      channel: 'sms',
      status: 'queued',
      profileId: card.id,
      recipientRole: 'card_owner',
      recipientRef: card.phone,
      meta: { sender: 'vBiz Me LLC' },
    })
  }

  logger.info(
    `Birthday wishes run complete tz=${result.timeZone} date=${result.dateKey} checked=${result.checked} matched=${result.matched} sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`
  )

  return result
}

const birthdayWishService = {
  runDailyBirthdayWishes,
}

export default birthdayWishService
