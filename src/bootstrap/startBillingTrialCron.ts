import cron from 'node-cron'
import { resolveOwnerMode } from '../constants/packageOwnerMode'
import stripeService from '../services/stripe.service'
import { adminAssignBilling } from '../utils/billingQuote'
import logger from '../utils/logger'
import { sendOwnerPaymentLinkEmail } from '../utils/ownerProvisionEmail'
import { prisma } from '../utils/prisma'

async function processExpiredComplimentaryTrials() {
  const now = new Date()
  const expired = await prisma.subscription.findMany({
    where: {
      provider: 'admin',
      stripeStatus: { in: ['trialing', 'active'] },
      trialEndsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    include: {
      package: true,
      user: { select: { id: true, email: true, name: true, role: true } },
    },
    take: 50,
  })

  for (const subscription of expired) {
    if (!subscription.package || !subscription.user) continue
    const ownerMode = resolveOwnerMode(subscription.package)
    const billing = adminAssignBilling(
      {
        monthlyPrice: subscription.package.monthlyPrice,
        signupFeeCents: subscription.package.signupFeeCents,
        ownerMode,
        negotiatedMonthlyCents: subscription.negotiatedMonthlyCents,
        negotiatedSignupFeeCents: subscription.negotiatedSignupFeeCents,
      },
      { trialEndsAt: null }
    )

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        provider: billing.provider,
        stripeStatus: billing.stripeStatus,
        trialEndsAt: null,
      },
    })

    if (billing.provider !== 'stripe') continue

    try {
      const link = await stripeService.createPaymentLinkForUser(subscription.userId)
      if (!link.url) continue
      await sendOwnerPaymentLinkEmail({
        email: subscription.user.email,
        name: subscription.user.name || subscription.user.email,
        paymentUrl: link.url,
        firstInvoiceCents: link.firstInvoiceCents,
        recurringCents: link.recurringCents,
      })
      logger.info(`Sent post-trial payment link to ${subscription.user.email}`)
    } catch (error) {
      logger.warn('Failed to send post-trial payment link', {
        userId: subscription.userId,
        error: error instanceof Error ? error.message : error,
      })
    }
  }
}

export function startBillingTrialCron() {
  const enabled = String(process.env.BILLING_TRIAL_CRON_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    logger.info('Billing trial cron disabled (BILLING_TRIAL_CRON_ENABLED=false)')
    return
  }

  const expr = process.env.BILLING_TRIAL_CRON_EXPR || '0 * * * *'
  if (!cron.validate(expr)) {
    logger.warn(`Invalid BILLING_TRIAL_CRON_EXPR="${expr}" — billing trial cron not started`)
    return
  }

  cron.schedule(expr, () => {
    void processExpiredComplimentaryTrials().catch((error) => {
      logger.error('Billing trial cron run failed', error)
    })
  })

  logger.info(`Billing trial cron scheduled expr="${expr}"`)
}
