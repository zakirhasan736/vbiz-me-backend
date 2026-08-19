import { createHmac, timingSafeEqual } from 'crypto'

export const MAX_AUTH_CHALLENGE_ATTEMPTS = 5
export const LOGIN_OTP_REQUIRED_CODE = 'LOGIN_OTP_REQUIRED'

export type AuthChallengePurpose = 'LOGIN' | 'ACTIVATE'

export type AuthChallengeSnapshot = {
  codeHash: string
  expiresAt: Date
  consumedAt: Date | null
  attemptCount: number
}

export type AuthChallengeFailure = 'expired' | 'reused' | 'invalid' | 'locked'

export function hashAuthOtp(otp: string, userId: string, purpose: AuthChallengePurpose, secret: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${userId}:${otp}`).digest('hex')
}

export function otpHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function evaluateAuthChallenge(
  record: AuthChallengeSnapshot,
  submittedOtp: string,
  userId: string,
  purpose: AuthChallengePurpose,
  secret: string,
  now = Date.now()
): { ok: true } | { ok: false; reason: AuthChallengeFailure } {
  if (record.consumedAt) return { ok: false, reason: 'reused' }
  if (record.expiresAt.getTime() <= now) return { ok: false, reason: 'expired' }
  if (record.attemptCount >= MAX_AUTH_CHALLENGE_ATTEMPTS) return { ok: false, reason: 'locked' }

  const expected = hashAuthOtp(submittedOtp, userId, purpose, secret)
  if (!otpHashesMatch(record.codeHash, expected)) return { ok: false, reason: 'invalid' }
  return { ok: true }
}

export function shouldRequireLoginOtp(role: string, loginOtpRequired: boolean): boolean {
  if (!loginOtpRequired) return false
  return role === 'vcard-owner' || role === 'corporate-owner'
}

/** Owner JWT/cookies are issued only after OTP when the login-OTP feature is on. Staff stay password-only. */
export function canIssueOwnerSession(input: {
  role: string
  loginOtpRequired: boolean
  passwordAccepted: boolean
  otpAccepted: boolean
}): boolean {
  if (!input.passwordAccepted) return false
  if (!shouldRequireLoginOtp(input.role, input.loginOtpRequired)) return true
  return input.otpAccepted
}

export function isTimeLimitedTokenValid(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() > now
}

export function challengeFailureMessage(reason: AuthChallengeFailure): string {
  if (reason === 'expired') return 'This code has expired. Request a new one.'
  if (reason === 'reused') return 'This code has already been used. Request a new one.'
  if (reason === 'locked') return 'Too many incorrect attempts. Request a new code.'
  return 'Invalid verification code.'
}
