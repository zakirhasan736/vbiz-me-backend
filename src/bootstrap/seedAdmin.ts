import { AuthProvider, UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import config from '../configs/config'
import { toPrismaRole } from '../constants/userRole'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8
const SUPER_ADMIN_NAME = 'Super Admin'

const isUniqueConstraintError = (err: unknown): boolean => {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'P2002'
}

const resolveAdminCredentials = (): { email: string; password: string } | null => {
  const email = config.ADMIN.EMAIL?.trim().toLowerCase()
  const password = config.ADMIN.PASSWORD

  if (!email || !password) {
    return null
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new Error('ADMIN_EMAIL must be a valid email address')
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }

  return { email, password }
}

/**
 * Idempotent startup seed: ensures the env-configured account is a SUPER_ADMIN.
 * Creates when missing; promotes ADMIN → SUPER_ADMIN when present. Never overwrites password.
 */
const seedAdmin = async (): Promise<void> => {
  let credentials: { email: string; password: string } | null

  try {
    credentials = resolveAdminCredentials()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid admin seed credentials'
    if (config.NODE_ENV === 'production') {
      throw new Error(message, { cause: err })
    }
    logger.warn(`Skipping admin seed: ${message}`)
    return
  }

  if (!credentials) {
    if (config.NODE_ENV === 'production') {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in production')
    }
    logger.warn('Skipping admin seed: ADMIN_EMAIL and ADMIN_PASSWORD are not set')
    return
  }

  const { email, password } = credentials

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  })

  if (existing) {
    if (existing.role === PrismaUserRole.SUPER_ADMIN) {
      logger.info(`Super admin seed skipped: user already exists for ${email}`)
      return
    }

    if (existing.role === PrismaUserRole.ADMIN) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          role: PrismaUserRole.SUPER_ADMIN,
          staffRole: null,
          allowedModules: [],
          name: SUPER_ADMIN_NAME,
          isVerified: true,
          isActive: true,
        },
      })
      logger.info(`Promoted admin to super admin: ${email}`)
      return
    }

    logger.info(`Admin seed skipped: non-admin user already exists for ${email}`)
    return
  }

  const hashedPassword = await authUtils.hashPassword(password)

  try {
    await prisma.user.create({
      data: {
        email,
        name: SUPER_ADMIN_NAME,
        password: hashedPassword,
        role: toPrismaRole('super-admin'),
        provider: AuthProvider.LOCAL,
        isVerified: true,
        isActive: true,
        staffRole: null,
        allowedModules: [],
      },
    })
    logger.info(`Super admin user seeded: ${email}`)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      logger.info(`Admin seed skipped: user already exists for ${email}`)
      return
    }
    throw err
  }
}

export default seedAdmin
