import type { Prisma } from '../../generated/prisma/client'
import { AccountStatus, AuthProvider, UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { resolveOwnerMode, roleForOwnerMode, type OwnerMode } from '../constants/packageOwnerMode'
import { toApiRole, toPrismaRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import authUtils from '../utils/auth.utils'
import {
  adminAssignBilling,
  resolveFirstInvoiceCents,
  resolveMonthlyCents,
  resolveRecurringInvoiceCents,
  resolveSignupFeeCents,
} from '../utils/billingQuote'
import {
  ensureStatusByName,
  lifecycleStatusFlags,
  normalizeCardStatusName,
  parseAccountLockSnapshot,
  type AccountLockSnapshot,
} from '../utils/cardStatus'
import { buildEffectiveEntitlements } from '../utils/effectiveEntitlements'
import { resolveTrialEndsAt } from '../utils/freePeriod'
import logger from '../utils/logger'
import {
  quoteOwnerBilling,
  sendOwnerPaymentLinkEmail,
  sendOwnerProvisionWelcomeEmail,
} from '../utils/ownerProvisionEmail'
import { resolveSubscriptionAccessStatus, type SubscriptionAccessStatus } from '../utils/paidAccess'
import { prisma } from '../utils/prisma'
import type {
  AccountStatusValue,
  CreateAdminUserBody,
  ListAdminUsersQuery,
  SetAdminUserStatusBody,
  UpdateAdminUserBody,
} from '../zodValidation/adminUser.zod'
import announcementService from './announcement.service'
import { inviteOwnerEmailVerification, inviteOwnerPasswordSetup } from './auth.service'
import {
  replaceCorporateFeatureOverrides,
  setCorporateCardLimit,
  setNegotiatedMonthlyCents,
  setNegotiatedSignupFeeCents,
} from './entitlement.service'
import stripeService from './stripe.service'
import subscriptionService from './subscription.service'

export type AdminUserRow = {
  id: string
  name: string | null
  email: string
  role: string
  companyName: string | null
  registeredCards: number
  ownerMode: OwnerMode | null
  packageId: string | null
  packageName: string | null
  cardLimit: number | null
  packageCardLimit: number | null
  packageMonthlyCents: number | null
  signupFeeCents: number | null
  negotiatedMonthlyCents: number | null
  negotiatedSignupFeeCents: number | null
  monthlyCents: number | null
  firstInvoiceCents: number | null
  recurringInvoiceCents: number | null
  signupFeeChargedAt: Date | null
  trialEndsAt: Date | null
  subscriptionStatus: SubscriptionAccessStatus
  subscriptionProvider: string | null
  stripeStatus: string | null
  paymentLinkUrl?: string | null
  featureOverrides: { featureKey: string; featureValue: string | null }[]
  packageFeatures: { featureKey: string; featureValue: string | null }[]
  accountStatus: AccountStatusValue
  isActive: boolean
  isVerified: boolean
  createdAt: Date
}

export type AdminUserStats = {
  singleOwners: number
  corporateOwners: number
  activeNow: number
  total: number
}

export type AdminUsersListPage = {
  items: AdminUserRow[]
  total: number
  skip: number
  limit: number
}

type ActorContext = {
  actorId: string
  actorEmail?: string | null
  actorName?: string | null
}

function syncIsActive(status: AccountStatusValue): boolean {
  return status === 'ACTIVE'
}

function activeSubscriptionSelect() {
  return {
    where: {
      OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      quantity: true,
      endsAt: true,
      provider: true,
      stripeStatus: true,
      negotiatedMonthlyCents: true,
      negotiatedSignupFeeCents: true,
      signupFeeChargedAt: true,
      trialEndsAt: true,
      package: {
        select: {
          id: true,
          slug: true,
          name: true,
          ownerMode: true,
          monthlyPrice: true,
          signupFeeCents: true,
          features: { select: { featureKey: true, featureValue: true } },
        },
      },
    },
  }
}

function adminUserRowSelect() {
  return {
    id: true,
    name: true,
    email: true,
    role: true,
    companyName: true,
    accountStatus: true,
    isActive: true,
    isVerified: true,
    createdAt: true,
    _count: { select: { profiles: true } },
    subscriptions: activeSubscriptionSelect(),
    featureOverrides: { select: { featureKey: true, featureValue: true } },
  } satisfies Prisma.UserSelect
}

type AdminUserRecord = Prisma.UserGetPayload<{ select: ReturnType<typeof adminUserRowSelect> }>

function mapRow(user: AdminUserRecord): AdminUserRow {
  const apiRole = toApiRole(user.role)
  const subscription = user.subscriptions[0]
  const featureOverrides = (user.featureOverrides || []).map((row) => ({
    featureKey: row.featureKey,
    featureValue: row.featureValue ?? null,
  }))
  const entitlements = buildEffectiveEntitlements({
    role: apiRole,
    pkg: subscription?.package
      ? {
          id: subscription.package.id,
          slug: subscription.package.slug,
          name: subscription.package.name,
          ownerMode: subscription.package.ownerMode,
        }
      : null,
    features: subscription?.package?.features,
    subscription: subscription
      ? {
          id: subscription.id,
          quantity: subscription.quantity,
          endsAt: subscription.endsAt,
          provider: subscription.provider,
          stripeStatus: subscription.stripeStatus,
        }
      : null,
    overrides: featureOverrides,
  })

  const packageMonthlyCents = subscription?.package?.monthlyPrice ?? null
  const signupFeeCents = subscription?.package?.signupFeeCents ?? null
  const negotiatedMonthlyCents = subscription?.negotiatedMonthlyCents ?? null
  const negotiatedSignupFeeCents = subscription?.negotiatedSignupFeeCents ?? null
  const monthlyCents = subscription
    ? resolveMonthlyCents({
        ownerMode: entitlements.ownerMode,
        packageMonthlyCents,
        negotiatedMonthlyCents,
        honorNegotiated: true,
      })
    : null
  const effectiveSignupFeeCents = subscription
    ? resolveSignupFeeCents({
        ownerMode: entitlements.ownerMode,
        packageSignupFeeCents: signupFeeCents,
        negotiatedSignupFeeCents,
        honorNegotiated: true,
      })
    : null
  const firstInvoiceCents =
    monthlyCents == null
      ? null
      : resolveFirstInvoiceCents({
          monthlyCents,
          signupFeeCents: effectiveSignupFeeCents,
          signupFeeChargedAt: subscription?.signupFeeChargedAt ?? null,
        })
  const recurringInvoiceCents = monthlyCents == null ? null : resolveRecurringInvoiceCents(monthlyCents)

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: apiRole,
    companyName: user.companyName,
    registeredCards: user._count.profiles,
    ownerMode: entitlements.ownerMode,
    packageId: subscription?.package?.id ?? null,
    packageName: subscription?.package?.name ?? null,
    cardLimit:
      entitlements.ownerMode === 'corporate'
        ? (subscription?.quantity ?? entitlements.limits.maxCards)
        : entitlements.limits.maxCards,
    packageCardLimit: entitlements.limits.packageMaxCards,
    packageMonthlyCents,
    signupFeeCents,
    negotiatedMonthlyCents,
    negotiatedSignupFeeCents,
    monthlyCents,
    firstInvoiceCents,
    recurringInvoiceCents,
    signupFeeChargedAt: subscription?.signupFeeChargedAt ?? null,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    subscriptionStatus: resolveSubscriptionAccessStatus(
      subscription
        ? {
            endsAt: subscription.endsAt,
            trialEndsAt: subscription.trialEndsAt,
            provider: subscription.provider,
            stripeStatus: subscription.stripeStatus,
          }
        : null
    ),
    subscriptionProvider: subscription?.provider ?? null,
    stripeStatus: subscription?.stripeStatus ?? null,
    featureOverrides,
    packageFeatures: (subscription?.package?.features || []).map((row) => ({
      featureKey: row.featureKey,
      featureValue: row.featureValue ?? null,
    })),
    accountStatus: user.accountStatus,
    isActive: user.isActive,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function cascadeOwnedCardsForAccountStatus(userId: string, accountStatus: AccountStatusValue): Promise<void> {
  const owned = await prisma.profile.findMany({
    where: {
      OR: [{ userId }, { companyUserId: userId }],
    },
    select: {
      id: true,
      isPublic: true,
      isDraft: true,
      status: { select: { name: true } },
    },
  })

  if (!owned.length) return

  if (accountStatus === 'ACTIVE') {
    for (const profile of owned) {
      // accountLockSnapshot isn't present in the generated Prisma types in this
      // workspace, so read it via a raw query to avoid type errors.
      const raw = await prisma.$queryRaw<Array<{ accountLockSnapshot: unknown }>>`
        SELECT "accountLockSnapshot" FROM "Profile" WHERE id = ${profile.id}
      `
      const snap = parseAccountLockSnapshot(raw?.[0]?.accountLockSnapshot)
      if (!snap) continue
      const statusRow = await ensureStatusByName(snap.statusName || 'draft')
      await prisma.profile.update({
        where: { id: profile.id },
        data: {
          status: { connect: { id: statusRow.id } },
          isPublic: snap.isPublic,
          isDraft: snap.isDraft,
        },
      })
      // Clear the JSON snapshot column via raw SQL to avoid Prisma client type issues.
      await prisma.$executeRaw`
        UPDATE "Profile" SET "accountLockSnapshot" = NULL WHERE id = ${profile.id}
      `
    }
    return
  }

  if (accountStatus !== 'PAUSED' && accountStatus !== 'SUSPENDED') return

  const lifecycle = accountStatus === 'PAUSED' ? 'paused' : 'suspended'
  const flags = lifecycleStatusFlags(lifecycle)
  const statusRow = await ensureStatusByName(lifecycle)

  for (const profile of owned) {
    const raw = await prisma.$queryRaw<Array<{ accountLockSnapshot: unknown }>>`
      SELECT "accountLockSnapshot" FROM "Profile" WHERE id = ${profile.id}
    `
    const existingSnap = parseAccountLockSnapshot(raw?.[0]?.accountLockSnapshot)
    const snapshot: AccountLockSnapshot =
      existingSnap ??
      ({
        statusName: normalizeCardStatusName(profile.status?.name) || (profile.isDraft ? 'draft' : 'active'),
        isPublic: profile.isPublic,
        isDraft: profile.isDraft,
      } satisfies AccountLockSnapshot)

    await prisma.profile.update({
      where: { id: profile.id },
      data: {
        status: { connect: { id: statusRow.id } },
        isPublic: flags.isPublic,
        isDraft: flags.isDraft,
      },
    })
    if (!existingSnap) {
      // store the snapshot JSON via raw SQL to avoid Prisma client typing gaps
      await prisma.$executeRaw`
        UPDATE "Profile" SET "accountLockSnapshot" = ${JSON.stringify(snapshot)}::jsonb WHERE id = ${profile.id}
      `
    }
  }
}

async function notifyAccountPausedOrSuspended(
  actor: ActorContext,
  user: { id: string; email: string; name: string | null; role: PrismaUserRole },
  action: 'paused' | 'suspended'
): Promise<void> {
  try {
    const apiRole = toApiRole(user.role)
    const isCorporate = apiRole === 'corporate-owner'
    const ownerEmail = user.email.trim().toLowerCase()
    const actionLabel = action

    const bodyText =
      action === 'paused'
        ? `Your account has been paused by an administrator. Your vCards are no longer public and have been moved to draft. You can still manage account settings (including password). Please contact support to re-enable card publishing.`
        : `Your account has been suspended by an administrator. Your vCards are disabled and account actions are locked. Please contact an administrator to restore access.`

    const subject = `Your VBizMe account has been ${actionLabel}`

    let emailRecipients: string[] = []
    const announcementEmails: string[] = [ownerEmail].filter(Boolean)

    if (isCorporate) {
      const cards = await prisma.profile.findMany({
        where: { OR: [{ userId: user.id }, { companyUserId: user.id }] },
        select: { email: true },
      })
      const cardEmails = cards.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e))
      emailRecipients = [...new Set([ownerEmail, ...cardEmails].filter(Boolean))]
    } else {
      emailRecipients = [...new Set([ownerEmail].filter(Boolean))]
    }

    const html = `<div style="font-family:sans-serif;line-height:1.5"><p>${escapeHtml(bodyText)}</p></div>`

    await Promise.all(
      emailRecipients.map((email) =>
        authUtils.sendEmail({ receiverMail: email, subject, html }).catch((err) => {
          logger.error(`Failed to send account ${action} email`, email, err)
        })
      )
    )

    if (announcementEmails.length) {
      try {
        await announcementService.create(
          {
            id: actor.actorId,
            email: actor.actorEmail || 'admin',
            name: actor.actorName,
          },
          {
            type: 'warning',
            kind: 'warning',
            title: `Account ${actionLabel}`,
            body: bodyText,
            status: 'active',
            targetType: 'specific',
            targetEmails: announcementEmails,
            meta: { userId: user.id, action: actionLabel },
          }
        )
      } catch (error) {
        logger.error(`Failed to create account ${action} announcement`, error)
      }
    }
  } catch (error) {
    logger.error(`Failed to notify account ${action}`, error)
  }
}

async function notifyAccountActivated(
  actor: ActorContext,
  user: { id: string; email: string; name: string | null; role: PrismaUserRole }
): Promise<void> {
  try {
    const ownerEmail = user.email.trim().toLowerCase()
    if (!ownerEmail) return

    await announcementService.archiveLockNotices({ userId: user.id })

    await announcementService.create(
      {
        id: actor.actorId,
        email: actor.actorEmail || 'admin',
        name: actor.actorName,
      },
      {
        type: 'success',
        kind: 'announcement',
        title: 'Account activated',
        body: 'Your account has been reactivated by an administrator. Your vCards have been restored to their previous state.',
        status: 'active',
        targetType: 'specific',
        targetEmails: [ownerEmail],
        meta: { userId: user.id, action: 'activated', channel: 'inbox', sendPush: '1' },
      }
    )
  } catch (error) {
    logger.error('Failed to notify account activated', error)
  }
}

function buildWhere(query: ListAdminUsersQuery): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
  }

  const q = query.q?.trim()
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { companyName: { contains: q, mode: 'insensitive' } },
    ]
  }

  if (query.role) {
    where.role = toPrismaRole(query.role)
  }

  if (query.accountStatus) {
    where.accountStatus = query.accountStatus as AccountStatus
  }

  return where
}

const list = async (query: ListAdminUsersQuery): Promise<AdminUsersListPage> => {
  const where = buildWhere(query)
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip: query.skip,
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      select: adminUserRowSelect(),
    }),
  ])

  return {
    items: rows.map(mapRow),
    total,
    skip: query.skip,
    limit: query.limit,
  }
}

const stats = async (): Promise<AdminUserStats> => {
  const base = { deletedAt: null as null }
  const [singleOwners, corporateOwners, activeNow, total] = await Promise.all([
    prisma.user.count({ where: { ...base, role: PrismaUserRole.VCARD_OWNER } }),
    prisma.user.count({ where: { ...base, role: PrismaUserRole.CORPORATE_OWNER } }),
    prisma.user.count({ where: { ...base, accountStatus: AccountStatus.ACTIVE, isActive: true } }),
    prisma.user.count({ where: base }),
  ])

  return { singleOwners, corporateOwners, activeNow, total }
}

const create = async (body: CreateAdminUserBody, actor: ActorContext): Promise<AdminUserRow> => {
  const email = body.email.trim().toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    throw new AppError(400, 'Email already registered')
  }

  const pkg = await subscriptionService.loadAssignablePackage(body.packageId)
  const ownerMode = resolveOwnerMode(pkg)
  const role = roleForOwnerMode(ownerMode)
  const companyName = body.companyName?.trim() || null
  if (ownerMode === 'corporate' && !companyName) {
    throw new AppError(400, 'Company / organization is required for Corporate accounts')
  }
  if (ownerMode === 'single' && body.featureOverrides?.length) {
    throw new AppError(400, 'Feature overrides apply only to Corporate package accounts.')
  }
  const hashedPassword = body.password ? await authUtils.hashPassword(body.password) : null

  const trialEndsAt = resolveTrialEndsAt({
    amount: body.freePeriodAmount,
    unit: body.freePeriodUnit,
    lifetime: body.freePeriodLifetime,
  })

  const user = await prisma.user.create({
    data: {
      name: body.name.trim(),
      email,
      password: hashedPassword,
      role: toPrismaRole(role),
      provider: AuthProvider.LOCAL,
      isVerified: false,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      companyName,
      createdById: actor.actorId,
    },
    select: adminUserRowSelect(),
  })

  await subscriptionService.assignPackageSubscription(user.id, pkg.id, {
    cardLimit: body.cardLimit,
    negotiatedMonthlyCents: body.negotiatedMonthlyCents,
    negotiatedSignupFeeCents: body.negotiatedSignupFeeCents,
    trialEndsAt,
  })

  if (ownerMode === 'corporate' && body.featureOverrides) {
    await replaceCorporateFeatureOverrides(user.id, role, body.featureOverrides)
  }

  if (hashedPassword) {
    await inviteOwnerEmailVerification(user.email)
  } else {
    await inviteOwnerPasswordSetup({ id: user.id, email: user.email, provider: 'LOCAL' })
  }

  let paymentLinkUrl: string | null = null
  if (body.sendPaymentLinkNow) {
    try {
      const link = await stripeService.createPaymentLinkForUser(user.id)
      paymentLinkUrl = link.url
      if (link.url) {
        const billing = quoteOwnerBilling({
          ownerMode,
          packageMonthlyCents: pkg.monthlyPrice,
          packageSignupFeeCents: pkg.signupFeeCents,
          negotiatedMonthlyCents: body.negotiatedMonthlyCents,
          negotiatedSignupFeeCents: body.negotiatedSignupFeeCents,
        })
        await sendOwnerPaymentLinkEmail({
          email: user.email,
          name: user.name || user.email,
          paymentUrl: link.url,
          firstInvoiceCents: link.firstInvoiceCents ?? billing.firstInvoiceCents,
          recurringCents: link.recurringCents ?? billing.monthlyCents,
        }).catch((error) => logger.warn('Could not email payment link to new owner', error))
      }
    } catch (error) {
      logger.warn('Could not generate Stripe payment link for new owner', {
        userId: user.id,
        error: error instanceof Error ? error.message : error,
      })
    }
  }

  const billing = quoteOwnerBilling({
    ownerMode,
    packageMonthlyCents: pkg.monthlyPrice,
    packageSignupFeeCents: pkg.signupFeeCents,
    negotiatedMonthlyCents: body.negotiatedMonthlyCents,
    negotiatedSignupFeeCents: body.negotiatedSignupFeeCents,
  })
  await sendOwnerProvisionWelcomeEmail({
    email: user.email,
    name: user.name || user.email,
    packageName: pkg.name,
    ownerModeLabel: ownerMode === 'corporate' ? 'Corporate' : 'Single Card Owner',
    loginUrl: `${String(config.FRONTEND_URL || '').replace(/\/$/, '')}/login`,
    trialEndsAt,
    lifetimeFree: Boolean(body.freePeriodLifetime),
    monthlyCents: billing.monthlyCents,
    signupFeeCents: billing.signupFeeCents,
    paymentRequired: billing.monthlyCents > 0 || billing.signupFeeCents > 0,
  }).catch((error) => logger.warn('Could not send owner welcome email', error))

  await writeAuditLog({
    action: 'User Created',
    details: `Provisioned ${pkg.name} account for ${user.name ?? user.email} (${role}, ${ownerMode} back office)`,
    type: 'create',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: {
      userId: user.id,
      email: user.email,
      role,
      ownerMode,
      packageId: pkg.id,
      packageSlug: pkg.slug,
      negotiatedMonthlyCents: ownerMode === 'corporate' ? (body.negotiatedMonthlyCents ?? null) : null,
      negotiatedSignupFeeCents: ownerMode === 'corporate' ? (body.negotiatedSignupFeeCents ?? null) : null,
    },
  })

  const withSubscription = await prisma.user.findFirst({
    where: { id: user.id, deletedAt: null },
    select: adminUserRowSelect(),
  })
  return {
    ...mapRow(withSubscription || user),
    paymentLinkUrl,
  }
}

const update = async (id: string, body: UpdateAdminUserBody, actor: ActorContext): Promise<AdminUserRow> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if ((existing.role === PrismaUserRole.ADMIN || existing.role === PrismaUserRole.SUPER_ADMIN) && body.role) {
    throw new AppError(400, 'Cannot change admin role from this endpoint')
  }

  if (body.packageId && (existing.role === PrismaUserRole.ADMIN || existing.role === PrismaUserRole.SUPER_ADMIN)) {
    throw new AppError(400, 'Cannot change package for admin accounts')
  }

  if (
    body.packageId &&
    existing.role !== PrismaUserRole.VCARD_OWNER &&
    existing.role !== PrismaUserRole.CORPORATE_OWNER
  ) {
    throw new AppError(400, 'Package changes apply only to card owner accounts')
  }

  if (body.packageId) {
    const targetPkg = await subscriptionService.loadAssignablePackage(body.packageId)
    const targetOwnerMode = resolveOwnerMode(targetPkg)
    if (targetOwnerMode === 'corporate') {
      const companyName =
        body.companyName !== undefined ? body.companyName?.trim() || null : existing.companyName?.trim() || null
      if (!companyName) {
        throw new AppError(400, 'Company / organization is required for Corporate accounts')
      }
    }
  }

  if (body.email) {
    const email = body.email.trim().toLowerCase()
    if (email !== existing.email) {
      const conflict = await prisma.user.findUnique({ where: { email } })
      if (conflict) {
        throw new AppError(400, 'Email already registered')
      }
    }
  }

  const data: Prisma.UserUpdateInput = {}
  if (body.name !== undefined) data.name = body.name.trim()
  if (body.email !== undefined) data.email = body.email.trim().toLowerCase()
  if (body.role !== undefined) data.role = toPrismaRole(body.role)
  if (body.companyName !== undefined) data.companyName = body.companyName?.trim() || null

  if (body.password) {
    const emailForCheck = (body.email ?? existing.email).trim().toLowerCase()
    if (body.password.trim().toLowerCase() === emailForCheck) {
      throw new AppError(400, "Password can't be the same as email")
    }
    data.password = await authUtils.hashPassword(body.password)
    data.passwordChangedAt = new Date()
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: adminUserRowSelect(),
  })

  let packageChanged = false
  let targetOwnerMode: OwnerMode | null = null

  if (body.packageId) {
    const currentSubscription = await prisma.subscription.findFirst({
      where: { userId: id, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
      select: { packageId: true },
    })
    packageChanged = currentSubscription?.packageId !== body.packageId

    const pkg = await subscriptionService.loadAssignablePackage(body.packageId)
    targetOwnerMode = resolveOwnerMode(pkg)
    const trialEndsAt =
      body.clearFreePeriod === true
        ? null
        : body.freePeriodAmount !== undefined ||
            body.freePeriodUnit !== undefined ||
            body.freePeriodLifetime !== undefined
          ? resolveTrialEndsAt({
              amount: body.freePeriodAmount,
              unit: body.freePeriodUnit,
              lifetime: body.freePeriodLifetime,
            })
          : undefined

    if (packageChanged) {
      await subscriptionService.changePackageSubscription(user.id, body.packageId, {
        cardLimit: targetOwnerMode === 'corporate' ? body.cardLimit : undefined,
        negotiatedMonthlyCents: targetOwnerMode === 'corporate' ? (body.negotiatedMonthlyCents ?? null) : null,
        negotiatedSignupFeeCents: targetOwnerMode === 'corporate' ? (body.negotiatedSignupFeeCents ?? null) : null,
        ...(trialEndsAt !== undefined ? { trialEndsAt } : {}),
      })
      await prisma.user.update({
        where: { id },
        data: { role: toPrismaRole(roleForOwnerMode(targetOwnerMode)) },
      })
      if (targetOwnerMode === 'single') {
        await prisma.corporateFeatureOverride.deleteMany({ where: { userId: id } })
      } else if (body.featureOverrides !== undefined) {
        await replaceCorporateFeatureOverrides(user.id, roleForOwnerMode(targetOwnerMode), body.featureOverrides)
      }
    }
  }

  const ownerRole = targetOwnerMode ? roleForOwnerMode(targetOwnerMode) : toApiRole(user.role)

  if (!packageChanged) {
    if (body.cardLimit !== undefined) {
      await setCorporateCardLimit(user.id, ownerRole, body.cardLimit)
    }
    if (body.negotiatedMonthlyCents !== undefined) {
      await setNegotiatedMonthlyCents(user.id, ownerRole, body.negotiatedMonthlyCents)
    }
    if (body.negotiatedSignupFeeCents !== undefined) {
      await setNegotiatedSignupFeeCents(user.id, ownerRole, body.negotiatedSignupFeeCents)
    }
    if (body.featureOverrides !== undefined) {
      await replaceCorporateFeatureOverrides(user.id, ownerRole, body.featureOverrides)
    }
  }

  if (
    !body.packageId &&
    (body.clearFreePeriod ||
      body.freePeriodAmount !== undefined ||
      body.freePeriodUnit !== undefined ||
      body.freePeriodLifetime !== undefined)
  ) {
    const subscription = await prisma.subscription.findFirst({
      where: { userId: id, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
      include: { package: true },
    })
    if (subscription?.package) {
      const trialEndsAt = body.clearFreePeriod
        ? null
        : resolveTrialEndsAt({
            amount: body.freePeriodAmount,
            unit: body.freePeriodUnit,
            lifetime: body.freePeriodLifetime,
          })
      const ownerMode = resolveOwnerMode(subscription.package)
      const billing = adminAssignBilling(
        {
          monthlyPrice: subscription.package.monthlyPrice,
          signupFeeCents: subscription.package.signupFeeCents,
          ownerMode,
          negotiatedMonthlyCents: subscription.negotiatedMonthlyCents,
          negotiatedSignupFeeCents: subscription.negotiatedSignupFeeCents,
        },
        { trialEndsAt }
      )
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          trialEndsAt,
          provider: billing.provider,
          stripeStatus: billing.stripeStatus,
        },
      })
    }
  }

  await writeAuditLog({
    action: 'User Modified',
    details: body.password
      ? `Updated parameters and reset password for ${user.name ?? user.email}`
      : `Updated parameters for ${user.name ?? user.email}`,
    type: 'update',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: {
      userId: user.id,
      passwordReset: Boolean(body.password),
      cardLimit: body.cardLimit,
      negotiatedMonthlyCents: body.negotiatedMonthlyCents,
      negotiatedSignupFeeCents: body.negotiatedSignupFeeCents,
      featureOverrideCount: body.featureOverrides?.length,
      packageId: body.packageId,
      packageChanged,
    },
  })

  if (
    packageChanged ||
    body.cardLimit !== undefined ||
    body.negotiatedMonthlyCents !== undefined ||
    body.negotiatedSignupFeeCents !== undefined ||
    body.featureOverrides !== undefined ||
    body.clearFreePeriod ||
    body.freePeriodAmount !== undefined ||
    body.freePeriodUnit !== undefined ||
    body.freePeriodLifetime !== undefined
  ) {
    const refreshed = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: adminUserRowSelect(),
    })
    if (refreshed) return mapRow(refreshed)
  }

  return mapRow(user)
}

const setStatus = async (id: string, body: SetAdminUserStatusBody, actor: ActorContext): Promise<AdminUserRow> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if (existing.id === actor.actorId && body.accountStatus !== 'ACTIVE') {
    throw new AppError(400, 'Cannot pause or suspend your own account')
  }

  const previousStatus = existing.accountStatus
  const nextStatus = body.accountStatus

  const user = await prisma.user.update({
    where: { id },
    data: {
      accountStatus: nextStatus as AccountStatus,
      isActive: syncIsActive(nextStatus),
    },
    select: adminUserRowSelect(),
  })

  await cascadeOwnedCardsForAccountStatus(user.id, nextStatus)

  if ((nextStatus === 'PAUSED' || nextStatus === 'SUSPENDED') && previousStatus !== nextStatus) {
    void notifyAccountPausedOrSuspended(actor, user, nextStatus === 'PAUSED' ? 'paused' : 'suspended')
  }

  if (
    nextStatus === 'ACTIVE' &&
    previousStatus !== nextStatus &&
    (previousStatus === 'PAUSED' || previousStatus === 'SUSPENDED')
  ) {
    void notifyAccountActivated(actor, user)
  }

  await writeAuditLog({
    action: 'User Toggle Status',
    details: `Changed account status for ${user.name ?? user.email} to ${nextStatus}`,
    type: 'status',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, accountStatus: nextStatus },
  })

  return mapRow(user)
}

const remove = async (id: string, actor: ActorContext): Promise<null> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if (existing.id === actor.actorId) {
    throw new AppError(400, 'Cannot delete your own account')
  }

  if (existing.role === PrismaUserRole.SUPER_ADMIN) {
    const superAdminCount = await prisma.user.count({
      where: { role: PrismaUserRole.SUPER_ADMIN, deletedAt: null },
    })
    if (superAdminCount <= 1) {
      throw new AppError(400, 'Cannot delete the last super admin account')
    }
  } else if (existing.role === PrismaUserRole.ADMIN) {
    throw new AppError(400, 'Manage admin accounts from the Admin Team page')
  }

  await prisma.user.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      isActive: false,
      accountStatus: AccountStatus.SUSPENDED,
    },
  })

  await writeAuditLog({
    action: 'User Wiped',
    details: `Deleted user ${existing.name ?? existing.email} and unlinked portfolio access`,
    type: 'delete',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: existing.id, email: existing.email },
  })

  return null
}

const createPaymentLink = async (id: string, actor: ActorContext): Promise<AdminUserRow> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: adminUserRowSelect(),
  })
  if (!existing) throw new AppError(404, 'User not found')

  const link = await stripeService.createPaymentLinkForUser(id)
  if (!link.url) throw new AppError(502, 'Stripe did not return a payment link.')
  await sendOwnerPaymentLinkEmail({
    email: existing.email,
    name: existing.name || existing.email,
    paymentUrl: link.url,
    firstInvoiceCents: link.firstInvoiceCents,
    recurringCents: link.recurringCents,
  }).catch((error) => logger.warn('Could not email payment link to owner', error))
  await writeAuditLog({
    action: 'Payment Link Generated',
    details: `Generated Stripe payment link for ${existing.name ?? existing.email}`,
    type: 'update',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: existing.id, firstInvoiceCents: link.firstInvoiceCents },
  })

  return {
    ...mapRow(existing),
    paymentLinkUrl: link.url,
  }
}

const adminUserService = {
  list,
  stats,
  create,
  update,
  setStatus,
  remove,
  createPaymentLink,
}

export default adminUserService
