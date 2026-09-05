import argon2 from 'argon2'
import bcrypt from 'bcryptjs'
import { CookieOptions, Response } from 'express'
import { readFileSync } from 'fs'
import nodemailer from 'nodemailer'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { IAuthUser } from '../interfaces/auth.interface'
import quicker from './quicker'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PASSWORD_SETUP_REQUIRED = 'PASSWORD_SETUP_REQUIRED'
const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'

const cookieOptions: CookieOptions = {
  sameSite: config.NODE_ENV === 'production' ? 'none' : 'strict',
  maxAge: 1000 * 60 * 60 * 24,
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  role: true,
  staffRole: true,
  allowedModules: true,
  provider: true,
  password: true,
  isVerified: true,
  isActive: true,
  accountStatus: true,
  completedTours: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

type AuthUserRecord = {
  id: string
  email: string
  name: string | null
  avatar: string | null
  role: PrismaUserRole
  staffRole?: string | null
  allowedModules?: string[]
  provider: string
  password: string | null
  isVerified: boolean
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  completedTours?: string[]
  deletedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie('accessToken', accessToken, cookieOptions).cookie('refreshToken', refreshToken, cookieOptions)
}

const clearAuthCookies = (res: Response) => {
  // Options must match setAuthCookies or browsers keep the cookies.
  res.clearCookie('accessToken', cookieOptions).clearCookie('refreshToken', cookieOptions)
}

/** Laravel stores bcrypt as $2y$ / $2x$; Node bcrypt expects $2a$ / $2b$. */
const normalizeBcryptHash = (hash: string): string => hash.replace(/^\$2y\$/, '$2b$').replace(/^\$2x\$/, '$2b$')

const isBcryptHash = (hash: string): boolean => /^\$2[abyx]\$/.test(hash)

const isArgon2Hash = (hash: string): boolean => hash.startsWith('$argon2')

const comparePassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
  try {
    if (isArgon2Hash(hashedPassword)) {
      return await argon2.verify(hashedPassword, plainPassword)
    }
    if (isBcryptHash(hashedPassword)) {
      return await bcrypt.compare(plainPassword, normalizeBcryptHash(hashedPassword))
    }
    // Unknown algorithm prefix — try argon2 then bcrypt for safety.
    try {
      if (await argon2.verify(hashedPassword, plainPassword)) return true
    } catch {
      /* not argon2 */
    }
    return await bcrypt.compare(plainPassword, normalizeBcryptHash(hashedPassword))
  } catch {
    return false
  }
}

const hashPassword = async (password: string): Promise<string> => {
  return argon2.hash(password, {
    type: config.argon2.type,
    memoryCost: config.argon2.memoryCost,
    timeCost: config.argon2.timeCost,
    parallelism: config.argon2.parallelism,
  })
}

const mapUser = (user: AuthUserRecord): IAuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatar: user.avatar,
  role: toApiRole(user.role),
  staffRole: user.staffRole ?? null,
  allowedModules: user.allowedModules ?? [],
  provider: user.provider,
  hasPassword: Boolean(user.password),
  isVerified: user.isVerified,
  isActive: user.isActive,
  accountStatus: user.accountStatus ?? (user.isActive ? 'ACTIVE' : 'PAUSED'),
  completedTours: user.completedTours ?? [],
  ownerMode: null,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
})

const issueTokens = (user: { id: string; email: string; role: PrismaUserRole }) => {
  const accessToken = quicker.generateAccessToken({
    id: user.id,
    email: user.email,
    role: toApiRole(user.role),
  })
  const refreshToken = quicker.generateRefreshToken(user.id)
  return { accessToken, refreshToken }
}

const providerLabel = (provider: string) => {
  switch (provider) {
    case 'GOOGLE':
      return 'Google'
    case 'FACEBOOK':
      return 'Facebook'
    default:
      return 'social login'
  }
}

const buildPasswordSetupRequiredError = (user: { email: string; provider: string }) => {
  return new AppError(
    409,
    `This account was created with ${providerLabel(user.provider)}. Check your email for a link to set a password, or sign in with ${providerLabel(user.provider)}.`,
    {
      code: PASSWORD_SETUP_REQUIRED,
      data: {
        email: user.email,
        providers: [user.provider],
        hasPassword: false,
      },
    }
  )
}

const buildEmailNotVerifiedError = (
  user: { email: string },
  cooldown?: { cooldownEnd: number; remainingSecond: number; expiresAt?: number }
) => {
  return new AppError(403, 'Please verify your email before logging in', {
    code: EMAIL_NOT_VERIFIED,
    data: {
      email: user.email,
      ...(cooldown
        ? {
            cooldownEnd: cooldown.cooldownEnd,
            remainingSecond: cooldown.remainingSecond,
            ...(typeof cooldown.expiresAt === 'number' ? { expiresAt: cooldown.expiresAt } : {}),
          }
        : {}),
    },
  })
}

const resolveAccountStatus = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
}): 'ACTIVE' | 'PAUSED' | 'SUSPENDED' => user.accountStatus ?? (user.isActive ? 'ACTIVE' : 'PAUSED')

/** Allows ACTIVE, PAUSED, and SUSPENDED users to authenticate (login/session). Blocks deleted. */
const assertCanAuthenticate = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}) => {
  if (user.deletedAt) {
    throw new AppError(403, 'Account has been deleted')
  }
}

/** Blocks SUSPENDED accounts from mutations (password, avatar, non-session APIs). */
const assertNotSuspended = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}) => {
  assertCanAuthenticate(user)
  if (resolveAccountStatus(user) === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended. Contact an administrator to restore access.')
  }
}

/** Blocks PAUSED and SUSPENDED from vCard create/edit/publish. */
const assertVcardMutable = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}) => {
  assertCanAuthenticate(user)
  const status = resolveAccountStatus(user)
  if (status === 'PAUSED') {
    throw new AppError(403, 'Account is paused. You cannot create or edit vCards. Please contact support.')
  }
  if (status === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended. Contact an administrator to restore access.')
  }
}

/** @deprecated Prefer assertCanAuthenticate / assertNotSuspended / assertVcardMutable */
const assertActiveUser = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}) => {
  assertCanAuthenticate(user)
  const status = resolveAccountStatus(user)
  if (status === 'PAUSED') {
    throw new AppError(403, 'Account is paused')
  }
  if (status === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended')
  }
  if (!user.isActive || status !== 'ACTIVE') {
    throw new AppError(403, 'Account is deactivated')
  }
}

const isUserAccessible = (user: {
  isActive: boolean
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  deletedAt?: Date | null
}) => {
  if (user.deletedAt) return false
  const status = resolveAccountStatus(user)
  return status === 'ACTIVE' || status === 'PAUSED' || status === 'SUSPENDED'
}

const EMAIL_LOGO_CID = 'vbiz-logo'
const EMAIL_LOGO_PATH = join(__dirname, '../assets/email/logo-vbizme.png')

const readTemplate = (templateName: string): string => {
  return readFileSync(join(__dirname, '../templates', templateName), 'utf-8')
}

const applyTemplateVars = (template: string, vars: Record<string, string>) => {
  return Object.entries(vars).reduce(
    (html, [key, value]) => html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value),
    template
  )
}

const brandLogoAttachment = (): { filename: string; path: string; cid: string } => ({
  filename: 'logo-vbizme.png',
  path: EMAIL_LOGO_PATH,
  cid: EMAIL_LOGO_CID,
})

const sendEmail = async (data: {
  html: string
  receiverMail: string
  subject: string
  attachments?: { filename?: string; path?: string; cid?: string }[]
}) => {
  if (!config.ZOHO_EMAIL_USER || !config.ZOHO_EMAIL_PASSWORD) {
    throw new Error('ZOHO_EMAIL_USER and ZOHO_EMAIL_PASSWORD must be configured to send email')
  }

  const transporter = nodemailer.createTransport({
    host: config.MAIL_SMTP.HOST,
    port: config.MAIL_SMTP.PORT,
    secure: config.MAIL_SMTP.SECURE,
    auth: {
      user: config.ZOHO_EMAIL_USER,
      pass: config.ZOHO_EMAIL_PASSWORD,
    },
    debug: config.NODE_ENV === 'development',
    connectionTimeout: 10000,
    requireTLS: !config.MAIL_SMTP.SECURE,
  })

  const attachments = [...(data.attachments ?? [])]
  const needsBrandLogo =
    data.html.includes(`cid:${EMAIL_LOGO_CID}`) && !attachments.some((a) => a.cid === EMAIL_LOGO_CID)
  if (needsBrandLogo) {
    attachments.push(brandLogoAttachment())
  }

  return transporter.sendMail({
    from: config.ZOHO_EMAIL_USER,
    to: data.receiverMail,
    subject: data.subject,
    html: data.html,
    attachments: attachments.length ? attachments : undefined,
  })
}

const authUtils = {
  cookieOptions,
  userSelect,
  setAuthCookies,
  clearAuthCookies,
  comparePassword,
  hashPassword,
  isBcryptHash,
  mapUser,
  issueTokens,
  buildPasswordSetupRequiredError,
  buildEmailNotVerifiedError,
  resolveAccountStatus,
  assertCanAuthenticate,
  assertNotSuspended,
  assertVcardMutable,
  assertActiveUser,
  isUserAccessible,
  readTemplate,
  applyTemplateVars,
  sendEmail,
} as const

export default authUtils
