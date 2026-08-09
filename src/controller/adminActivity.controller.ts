import AppError from '../error/AppError'
import adminActivityService from '../services/adminActivity.service'
import { assertStaff, assertSuperAdmin } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import sendResponse from '../utils/sendResponse'
import AuditZodSchema from '../zodValidation/audit.zod'

async function resolveActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  })
  if (!user) throw new AppError(403, 'Unauthorized')
  return user
}

const listAuditLogs = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const query = AuditZodSchema.listAuditLogsQuery.parse(req.query)
  const data = await adminActivityService.listAuditLogs(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Audit logs fetched', data })
})

const createAuditLog = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AuditZodSchema.createAuditLog.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await adminActivityService.createAudit(actor, body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Audit log created', data })
})

const clearAuditLogs = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const data = await adminActivityService.clearAuditLogs()
  sendResponse(res, { success: true, statusCode: 200, message: 'Audit logs cleared', data })
})

const activityFeed = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertStaff(req.user.role)
  const query = AuditZodSchema.activityFeedQuery.parse(req.query)
  const data = await adminActivityService.listActivityFeed(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Activity feed fetched', data })
})

const adminActivityController = {
  listAuditLogs,
  createAuditLog,
  clearAuditLogs,
  activityFeed,
}

export default adminActivityController
