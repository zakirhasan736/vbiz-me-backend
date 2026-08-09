import argon2 from 'argon2'
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
  maxAge: 1000 * 24 * 60 * 60 * 30,
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  role: true,
  provider: true,
  password: true,
  isVerified: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

type AuthUserRecord = {
  id: string
  email: string
  name: string | null
  avatar: string | null
  role: PrismaUserRole
  provider: string
  password: string | null
  isVerified: boolean
  isActive: boolean
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

const comparePassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
  try {
    return await argon2.verify(hashedPassword, plainPassword)
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
  provider: user.provider,
  hasPassword: Boolean(user.password),
  isVerified: user.isVerified,
  isActive: user.isActive,
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

const assertActiveUser = (user: { isActive: boolean }) => {
  if (!user.isActive) {
    throw new AppError(403, 'Account is deactivated')
  }
}

const readTemplate = (templateName: string): string => {
  return readFileSync(join(__dirname, '../templates', templateName), 'utf-8')
}

const applyTemplateVars = (template: string, vars: Record<string, string>) => {
  return Object.entries(vars).reduce(
    (html, [key, value]) => html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value),
    template
  )
}

const sendEmail = async (data: {
  html: string
  receiverMail: string
  subject: string
  attachments?: { filename?: string; path?: string; cid?: string }[]
}) => {
  if (!config.MAIL_ADDRESS || !config.MAIL_PASS) {
    throw new Error('MAIL_ADDRESS and MAIL_PASS must be configured to send email')
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    secure: false,
    auth: {
      user: config.MAIL_ADDRESS,
      pass: config.MAIL_PASS,
    },
    port: 587,
    debug: config.NODE_ENV === 'development',
    connectionTimeout: 10000,
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false,
    },
    requireTLS: true,
  })

  return transporter.sendMail({
    from: config.MAIL_ADDRESS,
    to: data.receiverMail,
    subject: data.subject,
    html: data.html,
    attachments: data.attachments,
  })
}

const authUtils = {
  cookieOptions,
  userSelect,
  setAuthCookies,
  clearAuthCookies,
  comparePassword,
  hashPassword,
  mapUser,
  issueTokens,
  buildPasswordSetupRequiredError,
  buildEmailNotVerifiedError,
  assertActiveUser,
  readTemplate,
  applyTemplateVars,
  sendEmail,
} as const

export default authUtils
