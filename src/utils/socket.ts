import type { Server as HttpServer } from 'http'
import jwt from 'jsonwebtoken'
import { Server, type Socket } from 'socket.io'
import config from '../configs/config'
import { isStaffRole, toApiRole } from '../constants/userRole'
import authUtils from './auth.utils'
import isTokenExpired from './isTokenExpired'
import logger from './logger'
import { prisma } from './prisma'
import quicker from './quicker'

export const STAFF_DASHBOARD_ROOM = 'staff:dashboard'

export const ownerDashboardRoom = (userId: string) => `user:${userId}:dashboard`

type SocketUser = {
  id: string
  email: string
  role: string
  isStaff: boolean
}

const socketUserSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  accountStatus: true,
  deletedAt: true,
} as const

declare module 'socket.io' {
  interface SocketData {
    user?: SocketUser
  }
}

let io: Server | null = null

export const getIo = (): Server | null => io

const readCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return rest.join('=')
      }
    }
  }
  return undefined
}

const getHandshakeAccessToken = (socket: Socket): string | undefined => {
  const authToken = socket.handshake.auth?.token
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim()

  const header = socket.handshake.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const bearer = header.slice(7).trim()
    if (bearer) return bearer
  }

  return readCookie(socket.handshake.headers.cookie, 'accessToken')
}

const toSocketUser = (user: { id: string; email: string; role: Parameters<typeof toApiRole>[0] }): SocketUser => {
  const role = toApiRole(user.role)
  return {
    id: user.id,
    email: user.email,
    role,
    isStaff: isStaffRole(role),
  }
}

const loadUserById = (id: string) =>
  prisma.user.findUnique({
    where: { id },
    select: socketUserSelect,
  })

/** Mirror REST auth: valid access token, or refresh cookie when access is missing/expired. */
const authenticateSocket = async (socket: Socket, next: (err?: Error) => void) => {
  try {
    const accessToken = getHandshakeAccessToken(socket)
    const refreshToken = readCookie(socket.handshake.headers.cookie, 'refreshToken')

    if (accessToken && !isTokenExpired(accessToken)) {
      const payload = quicker.verifyAccessToken(accessToken) as { id: string; email: string; role?: string }
      const user = await loadUserById(payload.id)
      if (!user) {
        return next(new Error('Unauthorized'))
      }
      authUtils.assertCanAuthenticate(user)
      socket.data.user = toSocketUser(user)
      return next()
    }

    if (!refreshToken) {
      return next(new Error('Unauthorized'))
    }

    const decryptedJwt = jwt.verify(refreshToken, config.REFRESH_TOKEN.SECRET as string) as { id: string }
    const user = await loadUserById(decryptedJwt.id)
    if (!user) {
      return next(new Error('Unauthorized'))
    }

    authUtils.assertCanAuthenticate(user)
    // Cookie refresh authenticates the socket; HTTP middleware will rotate cookies on the next API call.
    socket.data.user = toSocketUser(user)
    next()
  } catch (err) {
    logger.warn(`Socket handshake rejected: ${err instanceof Error ? err.message : String(err)}`)
    next(new Error('Unauthorized'))
  }
}

export const attachSocket = (httpServer: HttpServer): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: config.ALLOWED_CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    path: '/socket.io',
  })

  io.use(authenticateSocket)

  io.on('connection', (socket) => {
    const user = socket.data.user
    if (!user) return
    void socket.join(ownerDashboardRoom(user.id))
    if (user.isStaff) {
      void socket.join(STAFF_DASHBOARD_ROOM)
    }
  })

  return io
}

export default { getIo, attachSocket, STAFF_DASHBOARD_ROOM, ownerDashboardRoom }
