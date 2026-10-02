import config from '../configs/config'
import { buildFrontendPublicCardUrl } from '../constants/frontendPublicCardPath'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { buildVbizSms, toE164, type SmsTopic } from '../utils/smsMessage'

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

const notifyProfilePhone = async (profileId: string, topic: SmsTopic, detail: string) => {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: phoneSelect,
  })
  if (!profile?.phone) return
  sendTopicSms({
    to: profile.phone,
    countryCode: regionHint(profile),
    topic,
    cardName: profile.name?.trim() || 'vBiz card',
    cardUrl: cardUrl(profile.slug),
    detail,
  })
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
  const profiles = await prisma.profile.findMany({
    where: {
      phone: { not: null },
      OR: [
        { email: { in: normalized } },
        ...(userIds.length ? [{ userId: { in: userIds } }, { companyUserId: { in: userIds } }] : []),
      ],
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

function sendScheduleText(
  card: ScheduleCard,
  phone: string | null | undefined,
  countryCode: string | null | undefined,
  detail: string
) {
  if (!phone) return
  sendTopicSms({
    to: phone,
    countryCode: countryCode || regionHint(card),
    topic: 'Schedule',
    cardName: card.name?.trim() || 'vBiz card',
    cardUrl: cardUrl(card.slug),
    detail,
  })
}

/** The saved contact, or the scheduled card when there is no lead. Returns the numbers texted. */
async function notifySchedulePerson(input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  detail: string
}) {
  const sent = new Set<string>()
  const cards = await loadScheduleCards(input.profileId, input.groupProfileIds)
  const card = cards[0] || { name: 'vBiz card', slug: null, phone: null, countryCode: null }
  if (input.guestUserDataId) {
    const guest = await prisma.guestUserData.findUnique({
      where: { id: input.guestUserDataId },
      select: { phone: true },
    })
    const phone = toE164(guest?.phone, regionHint(card))
    if (phone) {
      sendScheduleText(card, phone, card.countryCode, input.detail)
      sent.add(phone)
      return sent
    }
  }
  for (const profile of cards) {
    const phone = toE164(profile.phone, regionHint(profile))
    if (!phone || sent.has(phone)) continue
    sent.add(phone)
    sendScheduleText(profile, phone, profile.countryCode, input.detail)
  }
  return sent
}

async function notifyScheduleSender(
  createdById: string | null | undefined,
  card: ScheduleCard,
  detail: string,
  skip: Set<string> = new Set()
) {
  if (!createdById) return
  const profiles = await prisma.profile.findMany({
    where: {
      phone: { not: null },
      OR: [{ userId: createdById }, { companyUserId: createdById }],
    },
    select: scheduleCardSelect,
    take: 5,
  })
  const seen = new Set<string>()
  const label = card.name?.trim() ? card : profiles[0] || card
  for (const profile of profiles) {
    const phone = toE164(profile.phone, regionHint(profile))
    if (!phone || seen.has(phone) || skip.has(phone)) continue
    seen.add(phone)
    sendScheduleText(label, phone, profile.countryCode, detail)
  }
}

const notifyScheduleCreated = async (input: {
  guestUserDataId?: string | null
  profileId?: string | null
  groupProfileIds?: unknown
  senderName: string
  type: string
  date: string
  time: string
}) => {
  await notifySchedulePerson({
    ...input,
    detail: `${input.senderName} scheduled ${input.type} with you on ${input.date} at ${input.time}.`,
  })
}

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
  const when = `${input.type} with ${input.host} is in about 30 minutes, ${input.date} at ${input.time}.`
  const personPhones = await notifySchedulePerson({ ...input, detail: `Reminder. ${when}` })
  const cards = await loadScheduleCards(input.profileId, input.groupProfileIds)
  const card = cards[0] || { name: input.host, slug: null, phone: null, countryCode: null }
  await notifyScheduleSender(input.createdById, card, `Reminder. Your ${when}`, personPhones)
}

const smsService = {
  sendTopicSms,
  notifyProfilePhone,
  notifyPhonesForEmails,
  notifyGlobalCardPhones,
  notifyScheduleCreated,
  notifyScheduleReminder,
}

export default smsService
