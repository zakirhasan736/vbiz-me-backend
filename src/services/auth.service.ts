import { randomInt } from 'crypto'
import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { toPrismaRole } from '../constants/userRole'
import AppError from '../error/AppError'
import {
  IAuthResult,
  IAuthUser,
  IChangePasswordBody,
  IForgotPasswordBody,
  IForgotPasswordVerifyResult,
  ILoginBody,
  ILoginResult,
  IPasswordSetupVerifyResult,
  IRegisterBody,
  IResendPasswordSetupBody,
  IResetPasswordBody,
  IUpdateUserBody,
  IVerifyEmailBody,
  IVerifyForgotPasswordBody,
  IVerifyPasswordSetupBody,
} from '../interfaces/auth.interface'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import subscriptionService from './subscription.service'

type VerificationCooldown = {
  cooldownEnd: number
  expiresAt: number
  remainingSecond: number
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const register = async (body: IRegisterBody): Promise<VerificationCooldown> => {
  const email = normalizeEmail(body.email)
  const existing = await prisma.user.findUnique({
    where: { email },
  })

  if (existing) {
    if (!existing.password) {
      await requirePasswordSetup(existing)
    }
    throw new AppError(400, 'Email already registered')
  }

  const hashedPassword = await authUtils.hashPassword(body.password)

  const user = await prisma.user.create({
    data: {
      name: body.name,
      email,
      password: hashedPassword,
      role: toPrismaRole(body.role),
      provider: 'LOCAL',
      isVerified: false,
      isActive: true,
    },
  })

  if (body.role === 'corporate-owner') {
    await subscriptionService.ensureCorporateStarterSubscription(user.id)
  }

  return queueOrSendVerificationEmail(email, { awaitSend: false })
}

const login = async (body: ILoginBody): Promise<ILoginResult> => {
  const email = normalizeEmail(body.email)
  const user = await prisma.user.findUnique({
    where: { email },
  })

  if (!user) {
    throw new AppError(401, 'Invalid login credentials')
  }

  if (!user.password) {
    await requirePasswordSetup(user)
  }

  const existingPassword = user.password
  if (!existingPassword) {
    throw new AppError(401, 'Invalid login credentials')
  }

  const isMatch = await authUtils.comparePassword(body.password, existingPassword)
  if (!isMatch) {
    throw new AppError(401, 'Invalid login credentials')
  }

  // Transparent upgrade: Laravel bcrypt → Argon2 so future logins use the new hasher.
  let storedPassword = existingPassword
  if (authUtils.isBcryptHash(existingPassword)) {
    storedPassword = await authUtils.hashPassword(body.password)
    await prisma.user.update({
      where: { id: user.id },
      data: { password: storedPassword },
    })
  }

  if (!user.isVerified) {
    const cooldown = await queueOrSendVerificationEmail(user.email, { awaitSend: false })
    throw authUtils.buildEmailNotVerifiedError(user, cooldown)
  }

  if (user.deletedAt) {
    throw new AppError(403, 'Account has been deleted')
  }

  // PAUSED and SUSPENDED users may still log in; API middleware gates their actions.

  const tokens = authUtils.issueTokens(user)

  return {
    profile: authUtils.mapUser({ ...user, password: storedPassword }),
    ...tokens,
  }
}

const getAuthor = async (userId: string): Promise<IAuthUser | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: authUtils.userSelect,
  })

  return user ? authUtils.mapUser(user) : null
}

const refreshToken = async (userId: string): Promise<{ accessToken: string; refreshToken: string }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new AppError(404, 'User not found')
  }

  authUtils.assertCanAuthenticate(user)

  return authUtils.issueTokens(user)
}

const updateUser = async (
  body: IUpdateUserBody,
  authenticatedUserId?: string
): Promise<IAuthResult | { user: IAuthUser }> => {
  const hasUpdatableField = Boolean(body.password || body.name !== undefined || body.avatar !== undefined)
  if (!hasUpdatableField) {
    throw new AppError(400, 'At least one field to update is required')
  }

  let userId = authenticatedUserId
  let viaSetupToken = false
  let setupTokenId: string | undefined

  if (body.passwordSetupToken) {
    const setupToken = await prisma.passwordSetupToken.findUnique({
      where: { id: body.passwordSetupToken },
    })

    if (!setupToken) {
      throw new AppError(401, 'Invalid or expired password setup token')
    }

    if (setupToken.expiresAt < new Date()) {
      await prisma.passwordSetupToken.delete({ where: { id: setupToken.id } })
      throw new AppError(401, 'Invalid or expired password setup token')
    }

    if (authenticatedUserId && authenticatedUserId !== setupToken.userId) {
      throw new AppError(403, 'Password setup token does not match authenticated user')
    }

    userId = setupToken.userId
    setupTokenId = setupToken.id
    viaSetupToken = true
  }

  if (!userId) {
    throw new AppError(401, 'Authentication or password setup token is required')
  }

  if (viaSetupToken) {
    if (!body.password) {
      throw new AppError(400, 'Password is required to complete account setup')
    }
    if (body.name !== undefined || body.avatar !== undefined) {
      throw new AppError(400, 'Only password can be set with a password setup token')
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new AppError(404, 'User not found')
  }

  authUtils.assertNotSuspended(user)

  if (viaSetupToken && user.password) {
    if (setupTokenId) {
      await prisma.passwordSetupToken.delete({ where: { id: setupTokenId } }).catch(() => undefined)
    }
    throw new AppError(400, 'Password is already set for this account')
  }

  if (body.password && user.password && !viaSetupToken) {
    if (!body.currentPassword) {
      throw new AppError(400, 'Current password is required to change password')
    }
    const isMatch = await authUtils.comparePassword(body.currentPassword, user.password)
    if (!isMatch) {
      throw new AppError(403, 'Current password is incorrect')
    }
  }

  const data: {
    password?: string
    name?: string | null
    avatar?: string | null
    passwordChangedAt?: Date
  } = {}

  if (body.password) {
    data.password = await authUtils.hashPassword(body.password)
    data.passwordChangedAt = new Date()
  }
  if (body.name !== undefined) {
    data.name = body.name
  }
  if (body.avatar !== undefined) {
    data.avatar = body.avatar
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextUser = await tx.user.update({
      where: { id: user.id },
      data,
      select: authUtils.userSelect,
    })

    if (setupTokenId) {
      await tx.passwordSetupToken.deleteMany({ where: { userId: user.id } })
    }

    return nextUser
  })

  const mapped = authUtils.mapUser(updated)

  if (viaSetupToken || body.password) {
    const tokens = authUtils.issueTokens(updated)
    return {
      user: mapped,
      ...tokens,
    }
  }

  return { user: mapped }
}

const queueOrSendVerificationEmail = async (
  email: string,
  options: { awaitSend: boolean }
): Promise<VerificationCooldown> => {
  const user = await prisma.user.findUnique({
    where: { email },
  })

  if (!user) {
    throw new AppError(404, 'User not found')
  }

  if (user.isVerified) {
    throw new AppError(400, 'User already verified')
  }

  const now = Date.now()
  if (user.otpCoolDown && user.otpCoolDown.getTime() > now) {
    const waitTime = Math.ceil((user.otpCoolDown.getTime() - now) / 1000)
    return {
      cooldownEnd: user.otpCoolDown.getTime(),
      expiresAt: user.otpExpiresAt?.getTime() ?? user.otpCoolDown.getTime(),
      remainingSecond: waitTime,
    }
  }

  const otp = randomInt(100000, 1000000)
  const newCoolDown = new Date(now + config.RESEND_MAIL_MINUTES * 60 * 1000)
  const otpExpiresAt = new Date(now + config.OTP_EXPIRE_MINUTES * 60 * 1000)
  const waitTime = Math.ceil((newCoolDown.getTime() - now) / 1000)

  await prisma.user.update({
    where: { id: user.id },
    data: {
      otpCode: otp,
      otpCoolDown: newCoolDown,
      otpExpiresAt,
    },
  })

  const template = authUtils.applyTemplateVars(authUtils.readTemplate('email_verification_template.html'), {
    OTP: otp.toString(),
    user_name: user.name || 'there',
    year: new Date().getFullYear().toString(),
  })

  const mailPayload = {
    html: template,
    receiverMail: email,
    subject: 'Account Verification',
  }

  if (options.awaitSend) {
    await authUtils.sendEmail(mailPayload)
  } else {
    void authUtils.sendEmail(mailPayload).catch((err) => {
      logger.error('Failed to send verification email in background', err)
    })
  }

  return {
    cooldownEnd: newCoolDown.getTime(),
    expiresAt: otpExpiresAt.getTime(),
    remainingSecond: waitTime,
  }
}

const sendVerificationEmail = async (email: string) => {
  return queueOrSendVerificationEmail(email, { awaitSend: true })
}

const verifyEmail = async (body: IVerifyEmailBody): Promise<null> => {
  const { otp, email } = body

  const user = await prisma.user.findUnique({
    where: { email },
  })

  if (!user || user.otpCode !== otp) {
    throw new AppError(404, 'Invalid OTP Code!')
  }

  if (user.isVerified) {
    throw new AppError(400, 'Account already verified!')
  }

  if (!user.otpExpiresAt || user.otpExpiresAt.getTime() < Date.now()) {
    throw new AppError(400, 'OTP code expired. Please request a new one.')
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      otpCode: null,
      otpCoolDown: null,
      otpExpiresAt: null,
      isVerified: true,
    },
  })

  return null
}

const forgotPassword = async (body: IForgotPasswordBody): Promise<null> => {
  const { email } = body

  const user = await prisma.user.findUnique({
    where: { email },
  })

  if (!user) {
    throw new AppError(404, 'User does not exist. Please try with an existing account or create an account.')
  }

  if (!user.isVerified) {
    throw new AppError(400, 'Account is not verified!')
  }

  authUtils.assertNotSuspended(user)

  if (!user.password) {
    await requirePasswordSetup(user)
  }

  const existingToken = await prisma.forgotPasswordToken.findFirst({
    where: {
      userId: user.id,
      expiresAt: { gt: new Date() },
    },
  })

  if (existingToken) {
    throw new AppError(400, 'Request already sent. Please try again after some time.')
  }

  const token = await prisma.forgotPasswordToken.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + config.FORGOT_PASSWORD_EXPIRY_MINUTES * 60 * 1000),
    },
  })

  const url = `${config.FRONTEND_URL}/reset-password/${token.id}`

  const template = authUtils.applyTemplateVars(authUtils.readTemplate('forgot_password.html'), {
    url,
    year: new Date().getFullYear().toString(),
  })

  await authUtils.sendEmail({
    receiverMail: user.email,
    subject: 'Reset your password!',
    html: template,
  })

  return null
}

const verifyForgotPassword = async (body: IVerifyForgotPasswordBody): Promise<IForgotPasswordVerifyResult> => {
  const resetToken = await prisma.forgotPasswordToken.findUnique({
    where: { id: body.token },
    include: {
      user: {
        select: {
          email: true,
          password: true,
          isActive: true,
          accountStatus: true,
          deletedAt: true,
        },
      },
    },
  })

  if (!resetToken) {
    throw new AppError(401, 'Invalid or expired password reset token')
  }

  if (resetToken.expiresAt < new Date()) {
    await prisma.forgotPasswordToken.delete({ where: { id: resetToken.id } })
    throw new AppError(401, 'Invalid or expired password reset token')
  }

  const { user } = resetToken
  authUtils.assertNotSuspended(user)

  if (!user.password) {
    await prisma.forgotPasswordToken.deleteMany({ where: { userId: resetToken.userId } })
    throw new AppError(400, 'Password is not set for this account')
  }

  return { email: user.email }
}

const resetPassword = async (body: IResetPasswordBody): Promise<null> => {
  const { password: newPassword, token } = body

  const resetToken = await prisma.forgotPasswordToken.findUnique({
    where: { id: token },
  })

  if (!resetToken) {
    throw new AppError(400, 'Invalid Session or Session Expired. Try again.')
  }

  if (resetToken.expiresAt < new Date()) {
    await prisma.forgotPasswordToken.delete({ where: { id: resetToken.id } })
    throw new AppError(400, 'Session expired. Please request again.')
  }

  const user = await prisma.user.findUnique({
    where: { id: resetToken.userId },
  })

  if (!user) {
    throw new AppError(400, 'Invalid Session or Session Expired. Try again.')
  }

  authUtils.assertNotSuspended(user)

  const hashedPassword = await authUtils.hashPassword(newPassword)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(),
      },
    }),
    prisma.forgotPasswordToken.delete({ where: { id: resetToken.id } }),
  ])

  await authUtils.sendEmail({
    html: `<p style="text-align: center;">Hey there!, your account password has been reset successfully!</p>`,
    receiverMail: user.email,
    subject: 'Account Password Reset!',
  })

  return null
}

const changePassword = async (body: IChangePasswordBody, userId: string): Promise<null> => {
  const { oldPassword, password } = body

  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new AppError(404, 'Account not found!')
  }

  authUtils.assertNotSuspended(user)

  if (!user.password) {
    throw new AppError(400, 'Password is not set for this account')
  }

  if (user.passwordChangedAt) {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)
    if (user.passwordChangedAt > thirtyMinutesAgo) {
      throw new AppError(400, 'You have changed your password recently. Please try again after some time.')
    }
  }

  const isMatch = await authUtils.comparePassword(oldPassword, user.password)
  if (!isMatch) {
    throw new AppError(400, 'Invalid Password')
  }

  const isSamePassword = await authUtils.comparePassword(password, user.password)
  if (isSamePassword) {
    throw new AppError(400, 'New password cannot be same as old password')
  }

  const hashed = await authUtils.hashPassword(password)

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashed,
      passwordChangedAt: new Date(),
    },
  })

  return null
}

const deactivateAccount = async (userId: string): Promise<null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new AppError(404, 'Account not found')
  }

  authUtils.assertNotSuspended(user)

  if (!user.isActive) {
    throw new AppError(400, 'Account is already deactivated')
  }

  await prisma.user.update({
    where: { id: userId },
    data: { isActive: false, accountStatus: 'PAUSED' },
  })

  return null
}

const findOrCreateSocialUser = async (input: {
  email: string
  name?: string | null
  avatar?: string | null
  provider: 'GOOGLE' | 'FACEBOOK'
  providerId: string
}): Promise<IAuthResult> => {
  if (!input.email) {
    throw new AppError(400, 'Social email is required')
  }

  let user = await prisma.user.findFirst({
    where: {
      OR: [{ provider: input.provider, providerId: input.providerId }, { email: input.email }],
    },
  })

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name || null,
        avatar: input.avatar || null,
        role: PrismaUserRole.VCARD_OWNER,
        provider: input.provider,
        providerId: input.providerId,
        password: null,
        isVerified: true,
        isActive: true,
      },
    })
  } else {
    const canLinkProvider = !user.providerId || user.providerId === input.providerId || user.provider === 'LOCAL'

    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(canLinkProvider ? { provider: input.provider, providerId: input.providerId } : {}),
        name: user.name || input.name || null,
        avatar: user.avatar || input.avatar || null,
        isVerified: true,
      },
    })
  }

  authUtils.assertCanAuthenticate(user)

  const tokens = authUtils.issueTokens(user)

  return {
    user: authUtils.mapUser({ ...user, password: user.password }),
    ...tokens,
  }
}

const sendPasswordSetupEmail = async (user: { id: string; email: string; provider: string }) => {
  const existingToken = await prisma.passwordSetupToken.findFirst({
    where: {
      userId: user.id,
      expiresAt: { gt: new Date() },
    },
  })

  if (existingToken) {
    return { sent: false as const }
  }

  const token = await prisma.passwordSetupToken.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + config.PASSWORD_SETUP_EXPIRY_MINUTES * 60 * 1000),
    },
  })

  const url = `${config.FRONTEND_URL}/set-password?token=${token.id}`
  const template = authUtils.applyTemplateVars(authUtils.readTemplate('password_setup.html'), {
    url,
    year: new Date().getFullYear().toString(),
  })

  await authUtils.sendEmail({
    receiverMail: user.email,
    subject: 'Set your VBizMe password',
    html: template,
  })

  return { sent: true as const }
}

const requirePasswordSetup = async (user: {
  id: string
  email: string
  provider: string
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}): Promise<never> => {
  authUtils.assertNotSuspended(user)

  try {
    await sendPasswordSetupEmail(user)
  } catch (error) {
    logger.error('Failed to send password setup email', error)
  }

  throw authUtils.buildPasswordSetupRequiredError(user)
}

const verifyPasswordSetup = async (body: IVerifyPasswordSetupBody): Promise<IPasswordSetupVerifyResult> => {
  const setupToken = await prisma.passwordSetupToken.findUnique({
    where: { id: body.token },
    include: {
      user: {
        select: {
          email: true,
          provider: true,
          password: true,
          isActive: true,
          accountStatus: true,
          deletedAt: true,
        },
      },
    },
  })

  if (!setupToken) {
    throw new AppError(401, 'Invalid or expired password setup token')
  }

  if (setupToken.expiresAt < new Date()) {
    await prisma.passwordSetupToken.delete({ where: { id: setupToken.id } })
    throw new AppError(401, 'Invalid or expired password setup token')
  }

  const { user } = setupToken
  authUtils.assertNotSuspended(user)

  if (user.password) {
    await prisma.passwordSetupToken.deleteMany({ where: { userId: setupToken.userId } })
    throw new AppError(400, 'Password is already set for this account')
  }

  return {
    email: user.email,
    providers: [user.provider],
  }
}

const resendPasswordSetupEmail = async (body: IResendPasswordSetupBody): Promise<null> => {
  const user = await prisma.user.findUnique({
    where: { email: body.email },
  })

  if (!user || user.password) {
    // Avoid account enumeration: same success response whether or not setup applies
    return null
  }

  authUtils.assertNotSuspended(user)

  const result = await sendPasswordSetupEmail(user)
  if (!result.sent) {
    throw new AppError(400, 'Request already sent. Please try again after some time.')
  }

  return null
}

const authService = {
  register,
  login,
  getAuthor,
  refreshToken,
  updateUser,
  sendVerificationEmail,
  verifyEmail,
  forgotPassword,
  verifyForgotPassword,
  resetPassword,
  changePassword,
  deactivateAccount,
  findOrCreateSocialUser,
  verifyPasswordSetup,
  resendPasswordSetupEmail,
}

export default authService
