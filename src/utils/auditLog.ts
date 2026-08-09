import type { Prisma } from '../../generated/prisma/client'
import type { AuditType } from '../zodValidation/audit.zod'
import { prisma } from './prisma'

export type WriteAuditLogInput = {
  action: string
  details: string
  type: AuditType
  actor?: string | null
  actorId?: string | null
  profileId?: string | null
  meta?: Prisma.InputJsonValue | null
}

export async function writeAuditLog(input: WriteAuditLogInput) {
  return prisma.auditLog.create({
    data: {
      action: input.action,
      details: input.details,
      type: input.type,
      actor: input.actor ?? null,
      actorId: input.actorId ?? null,
      profileId: input.profileId ?? null,
      meta: input.meta ?? undefined,
    },
  })
}
