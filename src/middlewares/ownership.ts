import { NextFunction, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import config from '../configs/config'
import { UserRole } from '../constants/userRole'
import AppError from '../error/AppError'
import catchAsyncError, { IUserInfoRequest } from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'

export const publicRateLimiter = rateLimit({
  windowMs: config.PUBLIC_RATE_LIMIT.WINDOW_MS,
  max: config.PUBLIC_RATE_LIMIT.MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many requests' },
})

/** Resolve a profile the current user may manage (owner, company parent, or admin). */
export const assertProfileAccess = catchAsyncError(async (req: IUserInfoRequest, _res, next) => {
  const profileId = (req.params.profileId || req.params.id || req.body?.profileId) as string | undefined
  if (!profileId) {
    throw new AppError(400, 'Profile id is required')
  }
  if (!req.user) {
    throw new AppError(403, 'Unauthorized')
  }

  if (req.user.role === 'admin') {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } })
    if (!profile) throw new AppError(404, 'Profile not found')
    ;(req as IUserInfoRequest & { profile: typeof profile }).profile = profile
    return next()
  }

  const profile = await prisma.profile.findFirst({
    where: {
      id: profileId,
      OR: [
        { userId: req.user.id },
        { companyUserId: req.user.id },
        {
          user: {
            companyEmployees: {
              some: { companyId: req.user.id },
            },
          },
        },
      ],
    },
  })

  if (!profile) {
    throw new AppError(403, 'You do not have access to this profile')
  }

  ;(req as IUserInfoRequest & { profile: typeof profile }).profile = profile
  next()
})

export const requireRoles = (...roles: UserRole[]) => {
  return (req: IUserInfoRequest, _res: Response, next: NextFunction) => {
    if (!req.user?.role || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN ACCESS'))
    }
    next()
  }
}

export const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
}

export type { Request }
