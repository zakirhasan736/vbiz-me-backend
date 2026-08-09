import 'express'
import { UserRole } from '../constants/userRole'

declare global {
  namespace Express {
    interface User {
      id?: string
      email?: string
      role?: UserRole
      staffRole?: string | null
      allowedModules?: string[]
      accessToken?: string
      refreshToken?: string
      provider?: string
      user?: unknown
    }

    interface Request {
      user?: User
    }
  }
}

export {}
