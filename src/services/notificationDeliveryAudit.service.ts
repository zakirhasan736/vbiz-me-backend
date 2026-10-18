import type { Prisma } from '../../generated/prisma/client'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

export type DeliveryChannel = 'push' | 'email' | 'sms' | 'inbox'
export type DeliveryStatus = 'pending' | 'queued' | 'sent' | 'failed' | 'skipped'

export async function recordNotificationDeliveryAttempt(input: {
  eventKey: string
  channel: DeliveryChannel
  status: DeliveryStatus
  profileId?: string | null
  recipientRole?: string | null
  recipientRef?: string | null
  relatedRecordId?: string | null
  error?: string | null
  meta?: Prisma.InputJsonValue
}): Promise<void> {
  try {
    if (!prisma.notificationDeliveryAttempt?.create) {
      // Prisma client not regenerated yet — skip quietly.
      return
    }
    await prisma.notificationDeliveryAttempt.create({
      data: {
        eventKey: input.eventKey,
        channel: input.channel,
        status: input.status,
        profileId: input.profileId || null,
        recipientRole: input.recipientRole || null,
        recipientRef: input.recipientRef || null,
        relatedRecordId: input.relatedRecordId || null,
        error: input.error || null,
        meta: input.meta,
      },
    })
  } catch (error) {
    logger.warn('Notification delivery audit write failed', { eventKey: input.eventKey, error })
  }
}

const notificationDeliveryAuditService = {
  recordNotificationDeliveryAttempt,
}

export default notificationDeliveryAuditService
