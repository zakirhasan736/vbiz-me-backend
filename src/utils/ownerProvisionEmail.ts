import authUtils from './auth.utils'
import { resolveFirstInvoiceCents, resolveMonthlyCents, resolveSignupFeeCents } from './billingQuote'
import { formatFreePeriodLabel } from './freePeriod'

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function sendOwnerProvisionWelcomeEmail(input: {
  email: string
  name: string
  packageName: string
  ownerModeLabel: string
  loginUrl: string
  trialEndsAt?: Date | null
  lifetimeFree?: boolean
  monthlyCents?: number | null
  signupFeeCents?: number | null
  paymentRequired: boolean
}) {
  const freeLabel = formatFreePeriodLabel({ trialEndsAt: input.trialEndsAt, lifetime: input.lifetimeFree })
  const monthly = input.monthlyCents != null ? `$${(input.monthlyCents / 100).toFixed(2)}` : null
  const signup = input.signupFeeCents != null ? `$${(input.signupFeeCents / 100).toFixed(2)}` : null

  const billingLines = [
    signup ? `<li><strong>One-time card creation fee:</strong> ${escapeHtml(signup)}</li>` : '',
    monthly ? `<li><strong>Monthly subscription:</strong> ${escapeHtml(monthly)}</li>` : '',
    `<li><strong>Complimentary access:</strong> ${escapeHtml(freeLabel)}</li>`,
    input.paymentRequired
      ? '<li>Billing starts when an administrator sends you a payment link, or automatically when your complimentary period ends.</li>'
      : '<li>No payment is required for this package.</li>',
  ]
    .filter(Boolean)
    .join('')

  const html = `<div style="font-family:sans-serif;line-height:1.6;color:#0f172a">
    <p>Hi ${escapeHtml(input.name)},</p>
    <p>Your <strong>vBiz Me</strong> ${escapeHtml(input.ownerModeLabel)} account is ready.</p>
    <ul>
      <li><strong>Package:</strong> ${escapeHtml(input.packageName)}</li>
      ${billingLines}
    </ul>
    <p>Sign in here: <a href="${escapeHtml(input.loginUrl)}">${escapeHtml(input.loginUrl)}</a></p>
    <p>If you did not expect this email, contact your administrator.</p>
  </div>`

  await authUtils.sendEmail({
    receiverMail: input.email,
    subject: 'Your vBiz Me account is ready',
    html,
  })
}

export async function sendOwnerPaymentLinkEmail(input: {
  email: string
  name: string
  paymentUrl: string
  firstInvoiceCents: number
  recurringCents: number
}) {
  const first = `$${(input.firstInvoiceCents / 100).toFixed(2)}`
  const recurring = `$${(input.recurringCents / 100).toFixed(2)}`
  const html = `<div style="font-family:sans-serif;line-height:1.6;color:#0f172a">
    <p>Hi ${escapeHtml(input.name)},</p>
    <p>Your vBiz Me billing is ready. Complete payment to activate your subscription.</p>
    <ul>
      <li><strong>First payment:</strong> ${escapeHtml(first)} (includes signup fee when applicable)</li>
      <li><strong>Then:</strong> ${escapeHtml(recurring)} / month</li>
    </ul>
    <p><a href="${escapeHtml(input.paymentUrl)}">Pay securely with Stripe</a></p>
    <p>This link is unique to your account. If you need help, reply to your administrator.</p>
  </div>`

  await authUtils.sendEmail({
    receiverMail: input.email,
    subject: 'Complete your vBiz Me subscription payment',
    html,
  })
}

export function quoteOwnerBilling(input: {
  ownerMode: 'single' | 'corporate' | null
  packageMonthlyCents?: number | null
  packageSignupFeeCents?: number | null
  negotiatedMonthlyCents?: number | null
  negotiatedSignupFeeCents?: number | null
}) {
  const monthlyCents = resolveMonthlyCents({
    ownerMode: input.ownerMode,
    packageMonthlyCents: input.packageMonthlyCents,
    negotiatedMonthlyCents: input.negotiatedMonthlyCents,
    honorNegotiated: true,
  })
  const signupFeeCents = resolveSignupFeeCents({
    ownerMode: input.ownerMode,
    packageSignupFeeCents: input.packageSignupFeeCents,
    negotiatedSignupFeeCents: input.negotiatedSignupFeeCents,
    honorNegotiated: true,
  })
  const firstInvoiceCents = resolveFirstInvoiceCents({ monthlyCents, signupFeeCents, signupFeeChargedAt: null })
  return { monthlyCents, signupFeeCents, firstInvoiceCents }
}
