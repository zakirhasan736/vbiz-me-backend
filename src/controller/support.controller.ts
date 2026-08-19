import { assertUserPackageAccess } from '../constants/packageAccess'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import supportService from '../services/support.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import sendResponse from '../utils/sendResponse'
import type { TicketRole } from '../zodValidation/support.zod'
import SupportZodSchema from '../zodValidation/support.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

function assertSupportAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'support')
}

function mapApiRoleToTicketRole(role?: string): TicketRole {
  if (role === 'corporate-owner') return 'corporate'
  if (isStaffRole(role)) return 'admin'
  return 'single'
}

async function resolveActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  })
  if (!user) throw new AppError(403, 'Unauthorized')
  return user
}

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSupportAccess(req.user)
  const query = SupportZodSchema.listSupportTicketsQuery.parse(req.query)
  const data = await supportService.list(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Support tickets fetched', data })
})

const getOne = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSupportAccess(req.user)
  const data = await supportService.getOne(param(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Support ticket fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  if (!isStaffRole(req.user.role)) {
    await assertUserPackageAccess(req.user.id, req.user.role, 'allow_support_ticket')
  }
  const body = SupportZodSchema.createSupportTicket.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const fromRole = mapApiRoleToTicketRole(req.user.role)
  const data = await supportService.create(actor, body, fromRole)
  sendResponse(res, { success: true, statusCode: 201, message: 'Support ticket created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSupportAccess(req.user)
  const body = SupportZodSchema.updateSupportTicket.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await supportService.update(param(req.params.id), actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Support ticket updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSupportAccess(req.user)
  const actor = await resolveActor(req.user.id)
  const data = await supportService.remove(param(req.params.id), actor)
  sendResponse(res, { success: true, statusCode: 200, message: 'Support ticket deleted', data })
})

const supportController = {
  list,
  getOne,
  create,
  update,
  remove,
}

export default supportController
