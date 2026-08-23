import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { isStaffRole, toApiRole } from '../constants/userRole'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { profileOwnerAllowsPackageAccess } from './entitlement.service'

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
  dob: Date
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
}

const ownerSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
} as const

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

function isEligibleOwner(user: OwnerCandidate | null | undefined): user is OwnerCandidate {
  if (!user?.email?.trim()) return false
  const apiRole = toApiRole(user.role)
  if (isStaffRole(apiRole)) return false
  if (apiRole !== 'vcard-owner' && apiRole !== 'corporate-owner') return false
  return true
}

/** Prefer personal owner, then corporate owner. Never staff. */
function resolveNonStaffOwner(profile: BirthdayProfile): OwnerCandidate | null {
  if (isEligibleOwner(profile.user)) return profile.user
  if (isEligibleOwner(profile.companyUser)) return profile.companyUser
  return null
}

function cardPublicUrl(slug: string | null, profileId: string): string {
  const base = (config.FRONTEND_URL || '').replace(/\/$/, '')
  if (slug?.trim()) return `${base}/v/${encodeURIComponent(slug.trim())}`
  return `${base}/vcards/edit/home/${profileId}`
}

function formatWishDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

async function sendBirthdayEmail(opts: { owner: OwnerCandidate; cardName: string; cardUrl: string; wishDate: string }) {
  const ownerName = opts.owner.name?.trim() || 'there'
  const html = authUtils.applyTemplateVars(authUtils.readTemplate('birthday_wish.html'), {
    owner_name: ownerName,
    card_name: opts.cardName,
    card_url: opts.cardUrl,
    wish_date: opts.wishDate,
  })

  await authUtils.sendEmail({
    receiverMail: opts.owner.email.trim(),
    subject: `Happy Birthday — ${opts.cardName}`,
    html,
  })
}

async function createOwnerInboxNotice(opts: {
  ownerEmail: string
  cardName: string
  profileId: string
  slug: string | null
}) {
  const title = `Happy Birthday — ${opts.cardName}`
  const body = `Today is ${opts.cardName}'s birthday. Send them your best wishes!`

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
        profileId: opts.profileId,
        ...(opts.slug ? { slug: opts.slug } : {}),
      },
      createdById: null,
    },
  })
}

const runDailyBirthdayWishes = async (opts?: { timeZone?: string }): Promise<BirthdayWishRunResult> => {
  const timeZone = (opts?.timeZone || config.BIRTHDAY_CRON.TZ || 'Asia/Dhaka').trim() || 'Asia/Dhaka'
  const today = calendarPartsInTz(new Date(), timeZone)
  const wishDate = formatWishDate(today.year, today.month, today.day)

  const result: BirthdayWishRunResult = {
    checked: 0,
    matched: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    year: today.year,
    dateKey: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
  }

  const profiles = (await prisma.profile.findMany({
    where: { dob: { not: null } },
    select: {
      id: true,
      name: true,
      slug: true,
      dob: true,
      user: { select: ownerSelect },
      companyUser: { select: ownerSelect },
    },
  })) as BirthdayProfile[]

  result.checked = profiles.length

  for (const profile of profiles) {
    if (!profile.dob) {
      result.skipped += 1
      continue
    }

    const { month, day } = dobMonthDay(profile.dob)
    if (month !== today.month || day !== today.day) continue

    result.matched += 1

    const owner = resolveNonStaffOwner(profile)
    if (!owner) {
      result.skipped += 1
      continue
    }

    const already = await prisma.birthdayWishLog.findUnique({
      where: {
        profileId_year: { profileId: profile.id, year: today.year },
      },
      select: { id: true },
    })
    if (already) {
      result.skipped += 1
      continue
    }

    const cardName = profile.name.trim() || 'your card'
    const cardUrl = cardPublicUrl(profile.slug, profile.id)

    try {
      // Claim the log first so concurrent runs cannot double-send.
      await prisma.birthdayWishLog.create({
        data: { profileId: profile.id, year: today.year },
      })
    } catch {
      result.skipped += 1
      continue
    }

    try {
      const allowEmail = await profileOwnerAllowsPackageAccess(profile.id, 'allow_email_notification')
      if (allowEmail) {
        await sendBirthdayEmail({
          owner,
          cardName,
          cardUrl,
          wishDate,
        })
      }
      await createOwnerInboxNotice({
        ownerEmail: owner.email,
        cardName,
        profileId: profile.id,
        slug: profile.slug,
      })
      result.sent += 1
    } catch (error) {
      result.errors += 1
      logger.error(`Birthday wish failed for profile ${profile.id}`, error)
      // Allow a later retry this year if send/inbox failed after claiming the log.
      await prisma.birthdayWishLog
        .delete({ where: { profileId_year: { profileId: profile.id, year: today.year } } })
        .catch(() => {})
    }
  }

  logger.info(
    `Birthday wishes run complete date=${result.dateKey} checked=${result.checked} matched=${result.matched} sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`
  )

  return result
}

const birthdayWishService = {
  runDailyBirthdayWishes,
}

export default birthdayWishService
