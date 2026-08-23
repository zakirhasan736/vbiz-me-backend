import { randomInt } from 'crypto'
import type { User } from '../../generated/prisma/client'
import { AuthChallengePurpose } from '../../generated/prisma/enums'
import config from '../configs/config'
import { toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import authUtils from '../utils/auth.utils'
import {
  challengeFailureMessage,
  evaluateAuthChallenge,
  hashAuthOtp,
  LOGIN_OTP_REQUIRED_CODE,
  MAX_AUTH_CHALLENGE_ATTEMPTS,
  type AuthChallengePurpose as ChallengePurpose,
} from '../utils/authChallenge'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

export type LoginOtpCooldown = {
  cooldownEnd: number
  expiresAt: number
  remainingSecond: number
  purpose: ChallengePurpose
}

const hmacSecret = () => config.ACCESS_TOKEN.SECRET || 'login-otp-dev-secret'

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const otpCooldownMs = () => Math.max(1, config.RESEND_MAIL_MINUTES || 1) * 60 * 1000
const otpExpireMs = () => Math.max(1, config.OTP_EXPIRE_MINUTES || 10) * 60 * 1000

async function resolvePurpose(user: Pick<User, 'id' | 'createdById'>): Promise<AuthChallengePurpose> {
  if (!user.createdById) return AuthChallengePurpose.LOGIN
  const successful = await prisma.authChallenge.findFirst({
    where: { userId: user.id, consumedAt: { not: null } },
    select: { id: true },
  })
  return successful ? AuthChallengePurpose.LOGIN : AuthChallengePurpose.ACTIVATE
}

export function buildLoginOtpRequiredError(email: string, cooldown: LoginOtpCooldown) {
  const activating = cooldown.purpose === 'ACTIVATE'
  return new AppError(
    403,
    activating
      ? 'Enter the code we emailed to activate your account'
      : 'Enter the code we emailed to finish signing in',
    {
      code: LOGIN_OTP_REQUIRED_CODE,
      data: {
        email,
        cooldownEnd: cooldown.cooldownEnd,
        remainingSecond: cooldown.remainingSecond,
        expiresAt: cooldown.expiresAt,
        purpose: cooldown.purpose,
      },
    }
  )
}

export async function issueLoginOtp(user: User, options: { awaitSend: boolean }): Promise<LoginOtpCooldown> {
  const purpose = await resolvePurpose(user)
  const now = Date.now()

  const latest = await prisma.authChallenge.findFirst({
    where: { userId: user.id, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })

  if (latest && latest.createdAt.getTime() + otpCooldownMs() > now) {
    const waitTime = Math.ceil((latest.createdAt.getTime() + otpCooldownMs() - now) / 1000)
    return {
      cooldownEnd: latest.createdAt.getTime() + otpCooldownMs(),
      expiresAt: latest.expiresAt.getTime(),
      remainingSecond: Math.max(0, waitTime),
      purpose: latest.purpose,
    }
  }

  await prisma.authChallenge.deleteMany({
    where: { userId: user.id, consumedAt: null },
  })

  const otp = String(randomInt(100000, 1000000))
  const expiresAt = new Date(now + otpExpireMs())
  const cooldownEnd = now + otpCooldownMs()

  await prisma.authChallenge.create({
    data: {
      userId: user.id,
      purpose,
      codeHash: hashAuthOtp(otp, user.id, purpose, hmacSecret()),
      expiresAt,
    },
  })

  const activating = purpose === AuthChallengePurpose.ACTIVATE
  const template = authUtils.applyTemplateVars(authUtils.readTemplate('login_otp_template.html'), {
    OTP: otp,
    user_name: user.name || 'there',
    year: new Date().getFullYear().toString(),
    headline: activating ? 'Activate your account' : 'Your sign-in code',
    body_text: activating
      ? 'Use this 6-digit code to activate your account and finish signing in. Do not share it with anyone.'
      : 'Use this 6-digit code to finish signing in. Do not share it with anyone.',
  })

  const mailPayload = {
    html: template,
    receiverMail: user.email,
    subject: activating ? 'Activate your vBiz Me account' : 'Your vBiz Me sign-in code',
  }

  if (options.awaitSend) {
    await authUtils.sendEmail(mailPayload)
  } else {
    void authUtils.sendEmail(mailPayload).catch((err) => {
      logger.error('Failed to send login OTP email in background', err)
    })
  }

  return {
    cooldownEnd,
    expiresAt: expiresAt.getTime(),
    remainingSecond: Math.ceil(otpCooldownMs() / 1000),
    purpose,
  }
}

export async function resendLoginOtp(email: string): Promise<LoginOtpCooldown> {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } })
  const dummy: LoginOtpCooldown = {
    cooldownEnd: Date.now() + otpCooldownMs(),
    expiresAt: Date.now() + otpExpireMs(),
    remainingSecond: Math.ceil(otpCooldownMs() / 1000),
    purpose: 'LOGIN',
  }
  if (!user || user.deletedAt || !user.password || !shouldSendLoginOtpForUser(user)) {
    return dummy
  }
  return issueLoginOtp(user, { awaitSend: true })
}

export function shouldSendLoginOtpForUser(user: Pick<User, 'role'>): boolean {
  return (
    config.LOGIN_OTP_REQUIRED && (toApiRole(user.role) === 'vcard-owner' || toApiRole(user.role) === 'corporate-owner')
  )
}

export async function consumeLoginOtp(email: string, otp: string) {
  const submitted = String(otp || '').replace(/\D/g, '')
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } })
  if (!user || user.deletedAt || submitted.length !== 6) {
    throw new AppError(401, 'Invalid verification code.')
  }

  const challenge = await prisma.authChallenge.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  })

  if (!challenge) {
    throw new AppError(401, 'Invalid verification code.')
  }

  const result = evaluateAuthChallenge(challenge, submitted, user.id, challenge.purpose, hmacSecret())

  if (!result.ok) {
    if (result.reason === 'invalid') {
      const nextAttempts = challenge.attemptCount + 1
      await prisma.authChallenge.update({
        where: { id: challenge.id },
        data: {
          attemptCount: nextAttempts,
          ...(nextAttempts >= MAX_AUTH_CHALLENGE_ATTEMPTS ? { consumedAt: new Date() } : {}),
        },
      })
    }
    throw new AppError(401, challengeFailureMessage(result.reason), {
      code:
        result.reason === 'expired' ? 'LOGIN_OTP_EXPIRED' : result.reason === 'reused' ? 'LOGIN_OTP_REUSED' : undefined,
    })
  }

  await prisma.authChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  })

  if (!user.isVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    })
    user.isVerified = true
  }

  return user
}
