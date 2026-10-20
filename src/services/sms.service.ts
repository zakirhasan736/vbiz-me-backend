import config from '../configs/config'
import { buildFrontendPublicCardUrl } from '../constants/frontendPublicCardPath'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { buildVbizSms, toE164, type SmsTopic } from '../utils/smsMessage'
import smsQuotaService from './smsQuota.service'

type SendResult = { sent: boolean; reason?: string }

function cardUrl(slug?: string | null) {
  const base = (config.FRONTEND_URL || 'https://vbiz.me').replace(/\/$/, '')
  if (!slug?.trim()) return base
  return buildFrontendPublicCardUrl(base, slug.trim())
}

function twilioReady() {
  return Boolean(
    config.TWILIO.ACCOUNT_SID &&
    config.TWILIO.AUTH_TOKEN &&
    (config.TWILIO.FROM_NUMBER || config.TWILIO.MESSAGING_SERVICE_SID)
  )
}

async function deliverSms(
  to: string | null | undefined,
  body: string,
  countryCode?: string | null
): Promise<SendResult> {
  const phone = toE164(to, countryCode)
  if (!phone) return { sent: false, reason: 'bad_phone' }
  if (!twilioReady()) {
    logger.warn('SMS skipped: Twilio account, token, and from-number are not configured')
    return { sent: false, reason: 'not_configured' }
  }

  const params = new URLSearchParams()
  params.set('To', phone)
  params.set('Body', body)
  if (config.TWILIO.MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', config.TWILIO.MESSAGING_SERVICE_SID)
  else if (config.TWILIO.FROM_NUMBER) params.set('From', config.TWILIO.FROM_NUMBER)

  const sid = config.TWILIO.ACCOUNT_SID
  const token = config.TWILIO.AUTH_TOKEN
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    if (!response.ok) {
      const detail = await response.text()
      logger.error('Twilio SMS failed', { status: response.status, detail: detail.slice(0, 400), to: phone })
      return { sent: false, reason: 'twilio_error' }
    }
    return { sent: true }
  } catch (error) {
    logger.error('Twilio SMS request failed', error)
    return { sent: false, reason: 'network' }
  }
}

const sendTopicSms = (input: {
  to?: string | null
  countryCode?: string | null
  topic: SmsTopic
  cardName: string
  cardUrl: string
  detail: string
}) => {
  const body = buildVbizSms(input)
  void deliverSms(input.to, body, input.countryCode).catch((error) => logger.error('SMS send failed', error))
}

const phoneSelect = {
  phone: true,
  countryCode: true,
  name: true,
  slug: true,
  addresses: { orderBy: { isPrimary: 'desc' as const }, select: { country: true }, take: 1 },
}

function regionHint(profile: { countryCode?: string | null; addresses?: { country: string | null }[] }) {
  return profile.countryCode?.trim() || profile.addresses?.[0]?.country?.trim() || null
}

const notifyProfilePhone = async (
  profileId: string,
  topic: SmsTopic,
  detail: string,
  options?: { linkUrl?: string | null; skipQuota?: boolean }
): Promise<SendResult> => {
  if (!options?.skipQuota) {
    const quota = await smsQuotaService.evaluateOwnerSmsQuota(profileId)
    if (!quota.allowed) {
      return { sent: false, reason: quota.reason || 'sms_not_included' }
    }
  }

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: phoneSelect,
  })
  if (!profile?.phone?.trim()) return { sent: false, reason: 'missing_phone' }
  const link = options?.linkUrl?.trim() || cardUrl(profile.slug)
  const body = buildVbizSms({
    topic,
    cardName: profile.name?.trim() || 'vBiz card',
    cardUrl: link,
    detail,
  })
  return deliverSms(profile.phone, body, regionHint(profile))
}

/** Owner text when a back-office meeting/schedule is booked — never texts staff admins. */
const notifyOwnerScheduleAlert = async (input: {
  profileId?: string | null
  groupProfileIds?: unknown
  detail: string
  linkUrl?: string | null
}): Promise<{ sent: number }> => {
  const ids = scheduleProfileIds(input.profileId, input.groupProfileIds)
  let sent = 0
  for (const profileId of ids) {
    const result = await notifyProfilePhone(profileId, 'Schedule', input.detail, {
      linkUrl: input.linkUrl,
    })
    if (result.sent) sent += 1
  }
  return { sent }
}

const notifyPhonesForEmails = async (
  emails: string[],
  topic: SmsTopic,
  detail: string,
  cardName: string,
  url: string
) => {
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))]
  if (!normalized.length) return
  const users = await prisma.user.findMany({
    where: { email: { in: normalized } },
    select: { id: true },
  })
  const userIds = users.map((user) => user.id)
  // Exact identity: match contact email / direct owner login only — never corporate children.
  const profiles = await prisma.profile.findMany({
    where: {
      phone: { not: null },
      OR: [{ email: { in: normalized } }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])],
    },
    select: phoneSelect,
  })
  const seen = new Set<string>()
  for (const profile of profiles) {
    const phone = toE164(profile.phone, regionHint(profile))
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    sendTopicSms({
      to: phone,
      topic,
      cardName: cardName || profile.name?.trim() || 'vBiz card',
      cardUrl: url || cardUrl(profile.slug),
      detail,
    })
  }
}

const notifyGlobalCardPhones = async (detail: string, topic: SmsTopic = 'Notice') => {
  if (!config.TWILIO.GLOBAL_SMS) {
    logger.info('Global SMS skipped. Set TWILIO_GLOBAL_SMS=true to text every card that has a phone.')
    return
  }
  const profiles = await prisma.profile.findMany({
    where: { isPublic: true, phone: { not: null } },
    select: phoneSelect,
    take: 1000,
  })
  const seen = new Set<string>()
  for (const profile of profiles) {
    const phone = toE164(profile.phone, regionHint(profile))
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    sendTopicSms({
      to: phone,
      topic,
      cardName: profile.name?.trim() || 'vBiz card',
      cardUrl: cardUrl(profile.slug),
      detail,
    })
  }
}

type ScheduleCard = {
  name: string | null
  slug: string | null
  phone: string | null
  countryCode: string | null
  addresses?: { country: string | null }[]
}

const scheduleCardSelect = {
  name: true,
  slug: true,
  phone: true,
  countryCode: true,
  addresses: { orderBy: { isPrimary: 'desc' as const }, select: { country: true }, take: 1 },
}

function scheduleProfileIds(profileId?: string | null, groupProfileIds?: unknown) {
  const ids = new Set<string>()
  if (profileId) ids.add(profileId)
  const rawList = (() => {
    if (Array.isArray(groupProfileIds)) return groupProfileIds
    if (typeof groupProfileIds !== 'string' || !groupProfileIds.trim()) return []
    try {
      const parsed = JSON.parse(groupProfileIds) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()
  for (const id of rawList) {
    if (typeof id === 'string' && id.trim()) ids.add(id.trim())
  }
  return [...ids]
}

async function loadScheduleCards(profileId?: string | null, groupProfileIds?: unknown) {
  const ids = scheduleProfileIds(profileId, groupProfileIds)
  if (!ids.length) return [] as ScheduleCard[]
  return prisma.profile.findMany({
    where: { id: { in: ids } },
    select: scheduleCardSelect,
  })
}

/**
 * Text only the guest/lead phone for a schedule conversation.
 * Never falls back to the card-owner phone — owners use notifyOwnerScheduleAlert (quota).
 */
async function notifyGuestScheduleSms(input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  detail: string
  linkUrl?: string | null
}): Promise<Set<string>> {
  const sent = new Set<string>()
  if (!input.guestUserDataId?.trim()) return sent

  const cards = await loadScheduleCards(input.profileId, input.groupProfileIds)
  const card = cards[0] || { name: 'vBiz card', slug: null, phone: null, countryCode: null }
  const guest = await prisma.guestUserData.findUnique({
    where: { id: input.guestUserDataId },
    select: { phone: true },
  })
  const phone = toE164(guest?.phone, regionHint(card))
  if (!phone) return sent

  sendTopicSms({
    to: phone,
    countryCode: regionHint(card),
    topic: 'Schedule',
    cardName: card.name?.trim() || 'vBiz card',
    cardUrl: input.linkUrl?.trim() || cardUrl(card.slug),
    detail: input.detail,
  })
  sent.add(phone)
  return sent
}

/** @deprecated Use notifyGuestScheduleSms — kept name for existing call sites. */
async function notifySchedulePerson(input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  detail: string
}) {
  return notifyGuestScheduleSms(input)
}

/**
 * Guest/lead only: “someone scheduled with you…”.
 * Card owner is notified separately via notifyOwnerScheduleAlert (tier quota).
 */
const notifyScheduleCreated = async (input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  senderName: string
  type: string
  date: string
  time: string
  linkUrl?: string | null
}) => {
  if (!input.guestUserDataId?.trim()) return
  await notifyGuestScheduleSms({
    guestUserDataId: input.guestUserDataId,
    profileId: input.profileId,
    groupProfileIds: input.groupProfileIds,
    linkUrl: input.linkUrl,
    detail: `${input.senderName} scheduled ${input.type} with you on ${input.date} at ${input.time}.`,
  })
}

/**
 * ~30 min reminder: guest + card owner only (owner quota-gated).
 * Never texts a staff admin booker who is not the card owner.
 */
const notifyScheduleReminder = async (input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  createdById?: string | null
  type: string
  host: string
  date: string
  time: string
}) => {
  void input.createdById
  const when = `${input.type} with ${input.host} is in about 30 minutes, ${input.date} at ${input.time}.`
  await notifyGuestScheduleSms({
    guestUserDataId: input.guestUserDataId,
    profileId: input.profileId,
    groupProfileIds: input.groupProfileIds,
    detail: `Reminder. ${when}`,
  })
  await notifyOwnerScheduleAlert({
    profileId: input.profileId,
    groupProfileIds: input.groupProfileIds,
    detail: `Reminder. Your ${when}`,
  })
}

/** Guest/requester SMS outside owner quota (1-on-1 propose, etc.). */
const notifyGuestPhone = (input: {
  to?: string | null
  countryCode?: string | null
  topic: SmsTopic
  cardName: string
  cardUrl: string
  detail: string
}) => {
  if (!input.to?.trim()) return
  sendTopicSms(input)
}

const smsService = {
  sendTopicSms,
  notifyGuestPhone,
  notifyProfilePhone,
  notifyOwnerScheduleAlert,
  notifyPhonesForEmails,
  notifyGlobalCardPhones,
  notifyScheduleCreated,
  notifyScheduleReminder,
}

export default smsService
