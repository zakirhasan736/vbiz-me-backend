import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import { eventTypeLabel, formatRelativeTime, parsePlatformFromUa, viewerFromPayload } from '../utils/dashboardAnalytics'
import { prisma } from '../utils/prisma'
import type {
  ActivityCategory,
  ActivityFeedQuery,
  CreateAuditLogInput,
  ListAuditLogsQuery,
} from '../zodValidation/audit.zod'

export type ActivityFeedItem = {
  id: string
  source: 'engagement' | 'audit'
  action: string
  details: string
  time: string
  createdAt: string
  type: string
  actor?: string
  eventType?: string
  profileId?: string | null
}

const ENGAGEMENT_EVENT_TYPES = [
  'profile_view',
  'save_guest_user',
  'save_contact_download',
  'social_click',
  'save_note',
] as const

function engagementUiType(eventType: string): string {
  if (eventType === 'profile_view') return 'view'
  if (eventType === 'social_click') return 'click'
  if (eventType.startsWith('save_')) return 'save'
  return 'update'
}

function engagementDetails(eventType: string, payload: Record<string, unknown> | null, platform: string): string {
  const viewer = viewerFromPayload(eventType, payload)
  if (eventType === 'social_click') {
    const channel = typeof payload?.channel === 'string' ? payload.channel : 'link'
    return `${viewer} clicked ${channel} · ${platform}`
  }
  if (eventType.startsWith('save_')) {
    return `${viewer} · ${platform}`
  }
  return `${viewer}'s profile activity · ${platform}`
}

function serializeAudit(
  row: {
    id: string
    action: string
    details: string
    type: string
    actor: string | null
    profileId: string | null
    createdAt: Date
  },
  now: Date
): ActivityFeedItem {
  return {
    id: row.id,
    source: 'audit',
    action: row.action,
    details: row.details,
    time: formatRelativeTime(row.createdAt, now),
    createdAt: row.createdAt.toISOString(),
    type: row.type,
    actor: row.actor ?? undefined,
    profileId: row.profileId,
  }
}

function categoryFilters(category: ActivityCategory): {
  includeEngagement: boolean
  engagementTypes?: string[]
  includeAudit: boolean
  auditTypes?: string[]
} {
  switch (category) {
    case 'engagement':
      return {
        includeEngagement: true,
        engagementTypes: [...ENGAGEMENT_EVENT_TYPES],
        includeAudit: false,
      }
    case 'creations':
      return {
        includeEngagement: true,
        engagementTypes: ['save_guest_user'],
        includeAudit: true,
        auditTypes: ['create', 'schedule'],
      }
    case 'updates':
      return {
        includeEngagement: false,
        includeAudit: true,
        auditTypes: ['update', 'status', 'settings'],
      }
    case 'deletions':
      return {
        includeEngagement: false,
        includeAudit: true,
        auditTypes: ['delete', 'cancel'],
      }
    case 'all':
    default:
      return {
        includeEngagement: true,
        includeAudit: true,
      }
  }
}

const listAuditLogs = async (query: ListAuditLogsQuery) => {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.type ? { type: query.type } : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.limit,
    }),
  ])

  const now = new Date()
  return {
    items: rows.map((row) => serializeAudit(row, now)),
    total,
    skip: query.skip,
    limit: query.limit,
  }
}

const createAudit = async (actor: { id: string; email: string; name?: string | null }, input: CreateAuditLogInput) => {
  if (input.profileId) {
    const profile = await prisma.profile.findUnique({ where: { id: input.profileId }, select: { id: true } })
    if (!profile) throw new AppError(404, 'Profile not found')
  }

  const actorLabel = input.actor?.trim() || actor.name?.trim() || actor.email || 'Admin'
  const row = await writeAuditLog({
    action: input.action,
    details: input.details,
    type: input.type,
    actor: actorLabel,
    actorId: actor.id,
    profileId: input.profileId ?? null,
    meta: (input.meta as Prisma.InputJsonValue | null) ?? null,
  })

  return serializeAudit(row, new Date())
}

const clearAuditLogs = async () => {
  const result = await prisma.auditLog.deleteMany({})
  return { deleted: result.count }
}

const listActivityFeed = async (query: ActivityFeedQuery) => {
  const { includeEngagement, engagementTypes, includeAudit, auditTypes } = categoryFilters(query.category)
  const fetchLimit = Math.min(200, query.skip + query.limit)
  const now = new Date()
  const merged: ActivityFeedItem[] = []

  if (includeEngagement) {
    const where: Prisma.EventLogWhereInput = {
      ...(engagementTypes
        ? { eventType: { in: engagementTypes } }
        : { eventType: { in: [...ENGAGEMENT_EVENT_TYPES] } }),
    }
    const rows = await prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      select: { id: true, eventType: true, payload: true, userAgent: true, profileId: true, createdAt: true },
    })

    for (const row of rows) {
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : null
      const platform = parsePlatformFromUa(row.userAgent)
      merged.push({
        id: `eng_${row.id}`,
        source: 'engagement',
        action: eventTypeLabel(row.eventType, payload),
        details: engagementDetails(row.eventType, payload, platform),
        time: formatRelativeTime(row.createdAt, now),
        createdAt: row.createdAt.toISOString(),
        type: engagementUiType(row.eventType),
        actor: viewerFromPayload(row.eventType, payload),
        eventType: row.eventType,
        profileId: row.profileId,
      })
    }
  }

  if (includeAudit) {
    const where: Prisma.AuditLogWhereInput = {
      ...(auditTypes ? { type: { in: auditTypes } } : {}),
    }
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
    })
    for (const row of rows) {
      merged.push(serializeAudit(row, now))
    }
  }

  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const total = merged.length
  const items = merged.slice(query.skip, query.skip + query.limit)

  const [engagementCount, saveCount, auditCount] = await Promise.all([
    prisma.eventLog.count({
      where: {
        eventType: { in: ['profile_view', 'social_click', 'save_guest_user', 'save_contact_download', 'save_note'] },
      },
    }),
    prisma.eventLog.count({
      where: { eventType: { in: ['save_guest_user', 'save_contact_download', 'save_note'] } },
    }),
    prisma.auditLog.count(),
  ])
  const viewClickCount = await prisma.eventLog.count({
    where: { eventType: { in: ['profile_view', 'social_click'] } },
  })

  return {
    items,
    total,
    skip: query.skip,
    limit: query.limit,
    counts: {
      events: engagementCount + auditCount,
      saves: saveCount,
      engagement: viewClickCount,
    },
  }
}

const adminActivityService = {
  listAuditLogs,
  createAudit,
  clearAuditLogs,
  listActivityFeed,
}

export default adminActivityService
