import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import config from '../configs/config'
import { toApiRole, UserRole } from '../constants/userRole'
import AppError from '../error/AppError'
import authUtils from '../utils/auth.utils'
import catchAsyncError, { IUserInfoRequest } from '../utils/catchAsyncError'
import isTokenExpired from '../utils/isTokenExpired'
import { prisma } from '../utils/prisma'
import quicker from '../utils/quicker'

const requireGoogleOAuth = (_req: Request, _res: Response, next: NextFunction) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return next(new AppError(503, 'Google OAuth is not configured'))
  }
  next()
}

const requireFacebookOAuth = (_req: Request, _res: Response, next: NextFunction) => {
  if (!config.FACEBOOK_APP_ID || !config.FACEBOOK_APP_SECRET) {
    return next(new AppError(503, 'Facebook OAuth is not configured'))
  }
  next()
}

/** Prefer httpOnly cookie; fall back to Authorization Bearer (Redux / mobile clients). */
const getAccessToken = (req: Request): string | undefined => {
  const cookieToken = req.cookies?.accessToken as string | undefined
  if (cookieToken) return cookieToken

  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const bearer = header.slice(7).trim()
    return bearer || undefined
  }

  return undefined
}

const toRequestUser = (user: {
  id: string
  email: string
  role: Parameters<typeof toApiRole>[0]
  staffRole?: string | null
  allowedModules?: string[]
  accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  isActive: boolean
}) => ({
  id: user.id,
  email: user.email,
  role: toApiRole(user.role),
  staffRole: user.staffRole ?? null,
  allowedModules: user.allowedModules ?? [],
  accountStatus: authUtils.resolveAccountStatus(user),
})

const isAuthenticateUser = catchAsyncError(async (req, res, next) => {
  const accessToken = getAccessToken(req)

  if (!accessToken) {
    throw new AppError(403, 'Unauthorized')
  }

  if (isTokenExpired(accessToken)) {
    const refreshToken = req.cookies.refreshToken as string | undefined
    if (!refreshToken) {
      throw new AppError(401, 'Refresh token is missing')
    }

    const decryptedJwt = jwt.verify(refreshToken, config.REFRESH_TOKEN.SECRET as string) as { id: string }

    const user = await prisma.user.findUnique({
      where: { id: decryptedJwt.id },
    })

    if (!user) {
      throw new AppError(403, 'Unauthorized')
    }

    authUtils.assertCanAuthenticate(user)

    const tokens = authUtils.issueTokens(user)
    authUtils.setAuthCookies(res, tokens.accessToken, tokens.refreshToken)

    req.user = toRequestUser(user)

    return next()
  }

  const payload = quicker.verifyAccessToken(accessToken) as { id: string; email: string; role?: string }
  const user = await prisma.user.findUnique({
    where: { id: payload.id },
  })

  if (!user) {
    throw new AppError(403, 'Unauthorized')
  }

  authUtils.assertCanAuthenticate(user)

  req.user = toRequestUser(user)

  next()
})

const requireNotSuspended = catchAsyncError(async (req, _res, next) => {
  const status = req.user?.accountStatus
  if (status === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended. Contact an administrator to restore access.')
  }
  next()
})

const requireVcardMutable = catchAsyncError(async (req, _res, next) => {
  const status = req.user?.accountStatus
  if (status === 'PAUSED') {
    throw new AppError(403, 'Account is paused. You cannot create or edit vCards. Please contact support.')
  }
  if (status === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended. Contact an administrator to restore access.')
  }
  next()
})

const authorizeRoles = (...roles: UserRole[]) => {
  return (req: IUserInfoRequest, _res: Response, next: NextFunction) => {
    if (!req.user?.role || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN ACCESS'))
    }
    next()
  }
}

const optionalAuthenticateUser = catchAsyncError(async (req, res, next) => {
  const accessToken = getAccessToken(req)

  if (!accessToken) {
    return next()
  }

  if (isTokenExpired(accessToken)) {
    const refreshToken = req.cookies.refreshToken as string | undefined
    if (!refreshToken) {
      return next()
    }

    const decryptedJwt = jwt.verify(refreshToken, config.REFRESH_TOKEN.SECRET as string) as { id: string }
    const user = await prisma.user.findUnique({
      where: { id: decryptedJwt.id },
    })

    if (!user || !authUtils.isUserAccessible(user)) {
      return next()
    }

    const tokens = authUtils.issueTokens(user)
    authUtils.setAuthCookies(res, tokens.accessToken, tokens.refreshToken)

    req.user = toRequestUser(user)

    return next()
  }

  const payload = quicker.verifyAccessToken(accessToken) as { id: string; email: string; role?: string }
  const user = await prisma.user.findUnique({
    where: { id: payload.id },
  })

  if (user && authUtils.isUserAccessible(user)) {
    req.user = toRequestUser(user)
  }

  next()
})

const authMiddleware = {
  isAuthenticateUser,
  optionalAuthenticateUser,
  requireGoogleOAuth,
  requireFacebookOAuth,
  requireNotSuspended,
  requireVcardMutable,
  authorizeRoles,
}

export default authMiddleware
