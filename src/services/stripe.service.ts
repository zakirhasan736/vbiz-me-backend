import Stripe from 'stripe'
import config from '../configs/config'
import { RETIRED_PACKAGE_SLUGS } from '../constants/packageAccess'
import {
  parsePackageMaxCards,
  resolveOwnerMode,
  resolveProvisionCardQuantity,
  roleForOwnerMode,
} from '../constants/packageOwnerMode'
import { isStaffRole, toApiRole, toPrismaRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { resolveFirstInvoiceCents, resolveMonthlyCents, resolveSignupFeeCents } from '../utils/billingQuote'
import { isComplimentaryTrialActive } from '../utils/freePeriod'
import logger from '../utils/logger'
import { isPaidAccess } from '../utils/paidAccess'
import { prisma } from '../utils/prisma'
import { buildCheckoutLineItems, checkoutModeForItems, toStripeSubscriptionLineItems } from '../utils/stripeCheckout'
import { decideStripeEvent, stripeOwnerRefs } from '../utils/stripeWebhook'
import { ASSISTANT_SETTING_KEY } from './assistantPolicy'
import { updateConfig as updateAssistantConfig } from './profileAssistant.service'

function quoteAgreement(
  pkg: {
    monthlyPrice: number
    signupFeeCents: number
    slug?: string | null
    name?: string | null
    ownerMode?: string | null
  },
  existing?: { negotiatedMonthlyCents?: number | null; negotiatedSignupFeeCents?: number | null } | null
) {
  const ownerMode = resolveOwnerMode(pkg)
  const monthlyCents = resolveMonthlyCents({
    ownerMode,
    packageMonthlyCents: pkg.monthlyPrice,
    negotiatedMonthlyCents: existing?.negotiatedMonthlyCents ?? null,
    honorNegotiated: existing?.negotiatedMonthlyCents != null,
  })
  const signupFeeCents = resolveSignupFeeCents({
    ownerMode,
    packageSignupFeeCents: pkg.signupFeeCents,
    negotiatedSignupFeeCents: existing?.negotiatedSignupFeeCents ?? null,
    honorNegotiated: existing?.negotiatedSignupFeeCents != null,
  })
  return { ownerMode, monthlyCents, signupFeeCents }
}

function getStripe(): Stripe {
  const key = (config.STRIPE.SECRET_KEY || '').trim()
  if (!key) throw new AppError(503, 'Stripe is not configured.')
  return new Stripe(key)
}

function frontendPath(path: string) {
  return `${String(config.FRONTEND_URL || '').replace(/\/$/, '')}${path}`
}

async function latestSubscription(userId: string) {
  const now = new Date()
  return prisma.subscription.findFirst({
    where: { userId, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

async function loadActivePackage(packageId: string) {
  const pkg = await prisma.package.findFirst({
    where: { id: packageId },
    include: { features: true },
  })
  if (!pkg) throw new AppError(404, 'Package not found')
  if (!pkg.isActive) throw new AppError(400, 'That package is not active')
  const slug = (pkg.slug || '').trim().toLowerCase()
  if ((RETIRED_PACKAGE_SLUGS as readonly string[]).includes(slug)) {
    throw new AppError(400, 'That package is retired.')
  }
  return pkg
}

const assignFreePackage = async (userId: string, packageId: string) => {
  const pkg = await loadActivePackage(packageId)
  const monthly = pkg.monthlyPrice || 0
  const signup = pkg.signupFeeCents || 0
  if (monthly > 0 || signup > 0) {
    throw new AppError(400, 'That package requires Stripe checkout.')
  }

  const existing = await latestSubscription(userId)
  const ownerMode = resolveOwnerMode(pkg)
  const quantity = resolveProvisionCardQuantity({
    ownerMode,
    packageMaxCards: parsePackageMaxCards(pkg.features),
    cardLimit: existing?.quantity,
  })
  const role = roleForOwnerMode(ownerMode)

  if (existing) {
    const updated = await prisma.subscription.update({
      where: { id: existing.id },
      data: {
        packageId: pkg.id,
        name: pkg.name,
        provider: existing.provider || 'admin',
        stripeStatus: 'active',
        endsAt: null,
        negotiatedMonthlyCents: ownerMode === 'corporate' ? existing.negotiatedMonthlyCents : null,
        negotiatedSignupFeeCents: ownerMode === 'corporate' ? existing.negotiatedSignupFeeCents : null,
        ...(quantity != null ? { quantity } : {}),
      },
    })
    await prisma.user.update({ where: { id: userId }, data: { role: toPrismaRole(role) } })
    return updated
  }

  const created = await prisma.subscription.create({
    data: {
      userId,
      packageId: pkg.id,
      name: pkg.name,
      provider: 'admin',
      stripeStatus: 'active',
      endsAt: null,
      ...(quantity != null ? { quantity } : {}),
    },
  })
  await prisma.user.update({ where: { id: userId }, data: { role: toPrismaRole(role) } })
  return created
}

const createCheckoutSession = async (
  userId: string,
  role: string | null | undefined,
  packageId: string,
  options?: { kind?: 'self_serve' | 'admin_payment_link' }
) => {
  if (isStaffRole(role)) throw new AppError(403, 'Staff accounts do not use owner billing.')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, stripeId: true },
  })
  if (!user) throw new AppError(404, 'User not found')

  const pkg = await loadActivePackage(packageId)
  const existing = await latestSubscription(userId)
  const { monthlyCents, signupFeeCents } = quoteAgreement(pkg, existing)
  const includeSignup = !existing?.signupFeeChargedAt
  const items = buildCheckoutLineItems({
    productName: pkg.name,
    monthlyCents,
    signupFeeCents,
    includeSignup,
  })
  const mode = checkoutModeForItems(items)

  if (mode === 'none') {
    await assignFreePackage(userId, pkg.id)
    return { url: null, assigned: true as const, firstInvoiceCents: 0, recurringCents: 0 }
  }

  if (existing && isPaidAccess(existing) && !isComplimentaryTrialActive(existing) && existing.packageId === pkg.id) {
    throw new AppError(400, 'You already have this package.')
  }

  const stripe = getStripe()
  let customerId = user.stripeId || undefined
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    })
    customerId = customer.id
    await prisma.user.update({ where: { id: user.id }, data: { stripeId: customerId } })
  }

  const firstInvoiceCents = resolveFirstInvoiceCents({
    monthlyCents,
    signupFeeCents,
    signupFeeChargedAt: existing?.signupFeeChargedAt,
  })

  const afterPayPath = options?.kind === 'admin_payment_link' ? '/login?billing=success' : '/settings?billing=success'
  const cancelPath = options?.kind === 'admin_payment_link' ? '/login?billing=cancel' : '/settings?billing=cancel'

  const session = await stripe.checkout.sessions.create({
    mode,
    customer: customerId,
    client_reference_id: user.id,
    success_url: frontendPath(afterPayPath),
    cancel_url: frontendPath(cancelPath),
    line_items: toStripeSubscriptionLineItems(items),
    metadata: {
      userId: user.id,
      packageId: pkg.id,
      subscriptionId: existing?.id || '',
      includeSignup: includeSignup ? '1' : '0',
    },
    subscription_data:
      mode === 'subscription'
        ? {
            metadata: {
              userId: user.id,
              packageId: pkg.id,
              subscriptionId: existing?.id || '',
            },
          }
        : undefined,
  })

  if (!session.url) throw new AppError(502, 'Stripe did not return a checkout URL.')
  return {
    url: session.url,
    assigned: false as const,
    firstInvoiceCents,
    recurringCents: monthlyCents,
  }
}

const createPaymentLinkForUser = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  })
  if (!user) throw new AppError(404, 'User not found')
  const role = toApiRole(user.role)
  if (isStaffRole(role)) throw new AppError(400, 'Staff accounts do not use owner billing.')

  const existing = await latestSubscription(userId)
  if (!existing?.packageId) throw new AppError(400, 'Assign a package before generating a payment link.')
  if (isPaidAccess(existing) && !isComplimentaryTrialActive(existing)) {
    throw new AppError(400, 'This account is already paid.')
  }

  return createCheckoutSession(userId, role, existing.packageId, { kind: 'admin_payment_link' })
}

const AI_ASSISTANCE_ADDON = 'ai_assistance'
const AI_ASSISTANCE_FEATURE_KEY = 'allow_ai_assistance'

const createAiAssistanceCheckoutSession = async (
  userId: string,
  role: string | null | undefined,
  options?: { profileId?: string | null; successPath?: string | null; cancelPath?: string | null }
) => {
  if (isStaffRole(role)) throw new AppError(403, 'Staff accounts do not use owner billing.')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, stripeId: true },
  })
  if (!user) throw new AppError(404, 'User not found')

  const entitlements = await prisma.corporateFeatureOverride.findUnique({
    where: { userId_featureKey: { userId, featureKey: AI_ASSISTANCE_FEATURE_KEY } },
  })
  if (entitlements?.featureValue === '1' || entitlements?.featureValue === 'true') {
    throw new AppError(400, 'AI Assistance is already unlocked on your account.')
  }

  const profileId = String(options?.profileId || '').trim()
  if (profileId) {
    const profile = await prisma.profile.findFirst({
      where: {
        id: profileId,
        OR: [{ userId }, { companyUserId: userId }],
      },
      select: { id: true },
    })
    if (!profile) throw new AppError(403, 'You do not have access to that card.')
  }

  const monthlyCents = config.AI_ASSISTANCE_ADDON_PRICE_CENTS
  const stripe = getStripe()
  let customerId = user.stripeId || undefined
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    })
    customerId = customer.id
    await prisma.user.update({ where: { id: user.id }, data: { stripeId: customerId } })
  }

  const successPath =
    String(options?.successPath || '').trim() ||
    (profileId
      ? `/vcards/edit/settings/ai-assistance?cardId=${encodeURIComponent(profileId)}&aiAssistance=success`
      : '/settings?aiAssistance=success')
  const cancelPath =
    String(options?.cancelPath || '').trim() ||
    (profileId
      ? `/vcards/edit/settings/ai-assistance?cardId=${encodeURIComponent(profileId)}&aiAssistance=cancel`
      : '/settings?aiAssistance=cancel')

  const metadata = {
    userId: user.id,
    addon: AI_ASSISTANCE_ADDON,
    profileId,
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    success_url: frontendPath(successPath),
    cancel_url: frontendPath(cancelPath),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: monthlyCents,
          recurring: { interval: 'month' },
          product_data: {
            name: 'AI Assistance',
            description: 'Premium guest AI assistant for your vBiz Me cards ($10 / month).',
          },
        },
      },
    ],
    metadata,
    subscription_data: { metadata },
  })

  if (!session.url) throw new AppError(502, 'Stripe did not return a checkout URL.')
  return {
    url: session.url,
    assigned: false as const,
    firstInvoiceCents: monthlyCents,
    recurringCents: monthlyCents,
  }
}

async function enableAiAssistanceForProfile(profileId: string) {
  const trimmed = profileId.trim()
  if (!trimmed) return
  try {
    await updateAssistantConfig(trimmed, { enabled: true })
  } catch (error) {
    logger.warn('Could not auto-enable AI Assistance on profile after payment', { profileId: trimmed, error })
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: trimmed, key: ASSISTANT_SETTING_KEY } },
      create: { profileId: trimmed, key: ASSISTANT_SETTING_KEY, value: '1' },
      update: { value: '1' },
    })
  }
}

async function activateAiAssistanceAddon(object: Record<string, unknown>) {
  const { userId, profileId } = stripeOwnerRefs(object)
  if (!userId) {
    logger.warn('AI Assistance activate skipped: missing userId metadata')
    return
  }

  await prisma.corporateFeatureOverride.upsert({
    where: { userId_featureKey: { userId, featureKey: AI_ASSISTANCE_FEATURE_KEY } },
    create: { userId, featureKey: AI_ASSISTANCE_FEATURE_KEY, featureValue: '1' },
    update: { featureValue: '1' },
  })

  if (profileId) {
    await enableAiAssistanceForProfile(profileId)
  }

  const amount =
    typeof object.amount_total === 'number'
      ? object.amount_total
      : typeof object.amount_paid === 'number'
        ? object.amount_paid
        : config.AI_ASSISTANCE_ADDON_PRICE_CENTS

  const invoiceId = String(object.id || object.invoice || '')
  if (invoiceId) {
    const recent = await prisma.transaction.findMany({
      where: { userId, provider: 'stripe' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { meta: true },
    })
    const already = recent.some((row) => {
      const meta = row.meta && typeof row.meta === 'object' ? (row.meta as { stripeEventObjectId?: string }) : null
      return meta?.stripeEventObjectId === invoiceId
    })
    if (!already) {
      await prisma.transaction.create({
        data: {
          userId,
          amount,
          currency: 'usd',
          status: 'paid',
          provider: 'stripe',
          meta: { stripeEventObjectId: invoiceId, addon: AI_ASSISTANCE_ADDON, profileId: profileId || null },
        },
      })
    }
  }
}

async function revokeAiAssistanceAddon(object: Record<string, unknown>) {
  const { userId } = stripeOwnerRefs(object)
  if (!userId) return
  await prisma.corporateFeatureOverride.deleteMany({
    where: { userId, featureKey: AI_ASSISTANCE_FEATURE_KEY },
  })
}

async function findSubscriptionFromEvent(object: Record<string, unknown>) {
  const { userId, packageId, subscriptionId: localSubId } = stripeOwnerRefs(object)
  const stripeSubId =
    typeof object.subscription === 'string'
      ? object.subscription
      : object.object === 'subscription'
        ? String(object.id || '')
        : ''

  if (localSubId) {
    const byId = await prisma.subscription.findUnique({ where: { id: localSubId } })
    if (byId) return byId
  }
  if (stripeSubId) {
    const byStripe = await prisma.subscription.findFirst({ where: { stripeId: stripeSubId } })
    if (byStripe) return byStripe
  }
  if (userId) {
    return latestSubscription(userId)
  }
  if (packageId && userId) {
    return prisma.subscription.findFirst({ where: { userId, packageId }, orderBy: { createdAt: 'desc' } })
  }
  return null
}

async function activatePaidAccess(object: Record<string, unknown>, markSignupCharged: boolean) {
  const { userId, packageId } = stripeOwnerRefs(object)
  if (!userId || !packageId) {
    logger.warn('Stripe activate skipped: missing userId or packageId metadata')
    return
  }

  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { features: true },
  })
  if (!pkg) return

  const ownerMode = resolveOwnerMode(pkg)
  const existing = (await findSubscriptionFromEvent(object)) || (await latestSubscription(userId))
  const { monthlyCents, signupFeeCents } = quoteAgreement(pkg, existing)
  const stripeSubId =
    typeof object.subscription === 'string'
      ? object.subscription
      : object.object === 'subscription'
        ? String(object.id || '')
        : existing?.stripeId || undefined
  const quantity = resolveProvisionCardQuantity({
    ownerMode,
    packageMaxCards: parsePackageMaxCards(pkg.features),
    cardLimit: existing?.quantity,
  })
  const amount =
    typeof object.amount_total === 'number'
      ? object.amount_total
      : typeof object.amount_paid === 'number'
        ? object.amount_paid
        : resolveFirstInvoiceCents({
            monthlyCents,
            signupFeeCents: markSignupCharged ? signupFeeCents : 0,
            signupFeeChargedAt: markSignupCharged ? null : existing?.signupFeeChargedAt,
          })

  const data = {
    userId,
    packageId: pkg.id,
    name: pkg.name,
    provider: 'stripe',
    stripeStatus: 'active',
    stripeId: stripeSubId,
    endsAt: null,
    negotiatedMonthlyCents: ownerMode === 'corporate' ? (existing?.negotiatedMonthlyCents ?? null) : null,
    negotiatedSignupFeeCents: ownerMode === 'corporate' ? (existing?.negotiatedSignupFeeCents ?? null) : null,
    ...(quantity != null ? { quantity } : {}),
    ...(markSignupCharged || signupFeeCents <= 0 ? { signupFeeChargedAt: new Date() } : {}),
  }

  const sub = existing
    ? await prisma.subscription.update({ where: { id: existing.id }, data })
    : await prisma.subscription.create({ data })

  await prisma.user.update({
    where: { id: userId },
    data: { role: toPrismaRole(roleForOwnerMode(ownerMode)) },
  })

  const invoiceId = String(object.id || object.invoice || '')
  if (invoiceId) {
    const recent = await prisma.transaction.findMany({
      where: { subscriptionId: sub.id, provider: 'stripe' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { meta: true },
    })
    const already = recent.some((row) => {
      const meta = row.meta && typeof row.meta === 'object' ? (row.meta as { stripeEventObjectId?: string }) : null
      return meta?.stripeEventObjectId === invoiceId
    })
    if (!already) {
      await prisma.transaction.create({
        data: {
          userId,
          subscriptionId: sub.id,
          amount,
          currency: 'usd',
          status: 'paid',
          provider: 'stripe',
          meta: { stripeEventObjectId: invoiceId },
        },
      })
    }
  }
}

async function syncStripeStatus(object: Record<string, unknown>, stripeStatus: string) {
  const sub = await findSubscriptionFromEvent(object)
  if (!sub) return
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      stripeStatus,
      ...(stripeStatus === 'canceled' || stripeStatus === 'unpaid' ? { endsAt: new Date() } : {}),
    },
  })
}

const handleWebhook = async (rawBody: Buffer | string, signature: string | undefined) => {
  const secret = (config.STRIPE.WEBHOOK_SECRET || '').trim()
  if (!secret) throw new AppError(503, 'Stripe webhook is not configured.')
  if (!signature) throw new AppError(400, 'Missing Stripe signature.')

  const stripe = getStripe()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret)
  } catch {
    throw new AppError(400, 'Invalid Stripe signature.')
  }

  const existing = await prisma.stripeEvent.findUnique({ where: { eventId: event.id } })
  if (existing) return { duplicate: true, type: event.type }

  let object = event.data.object as unknown as Record<string, unknown>
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const stripeSubId = typeof object.subscription === 'string' ? object.subscription : ''
    if (stripeSubId && !(object.metadata as { userId?: string } | undefined)?.userId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(stripeSubId)
        object = {
          ...object,
          metadata: subscription.metadata,
        }
      } catch (error) {
        logger.warn('Could not load Stripe subscription metadata for invoice', error)
      }
    }
  }
  if (event.type === 'checkout.session.completed') {
    const refs = stripeOwnerRefs(object)
    const paymentLinkId = typeof object.payment_link === 'string' ? object.payment_link : ''
    if (paymentLinkId && (!refs.userId || !refs.packageId)) {
      try {
        const link = await stripe.paymentLinks.retrieve(paymentLinkId)
        object = {
          ...object,
          metadata: {
            ...(link.metadata || {}),
            ...((object.metadata && typeof object.metadata === 'object' ? object.metadata : {}) as Record<
              string,
              unknown
            >),
          },
        }
      } catch (error) {
        logger.warn('Could not load Stripe payment link metadata', error)
      }
    }
  }

  const decision = decideStripeEvent({
    type: event.type,
    data: { object },
  })

  const refs = stripeOwnerRefs(object)
  const isAiAddon = refs.addon === AI_ASSISTANCE_ADDON

  if (isAiAddon) {
    if (decision.action === 'activate') {
      await activateAiAssistanceAddon(object)
    } else if (
      decision.action === 'sync_status' &&
      (decision.stripeStatus === 'canceled' || decision.stripeStatus === 'unpaid')
    ) {
      await revokeAiAssistanceAddon(object)
    }
  } else if (decision.action === 'activate') {
    await activatePaidAccess(object, decision.markSignupCharged)
  } else if (decision.action === 'sync_status') {
    await syncStripeStatus(object, decision.stripeStatus)
  }

  try {
    await prisma.stripeEvent.create({ data: { eventId: event.id, type: event.type } })
  } catch (error) {
    logger.warn('Stripe event insert raced', { eventId: event.id, error })
  }

  return { duplicate: false, type: event.type, action: decision.action }
}

const stripeService = {
  createCheckoutSession,
  createAiAssistanceCheckoutSession,
  createPaymentLinkForUser,
  assignFreePackage,
  handleWebhook,
}

export default stripeService
