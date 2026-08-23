import AppError from '../error/AppError'
import adminUserService from '../services/adminUser.service'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import AdminUserZodSchema from '../zodValidation/adminUser.zod'

import { assertModule } from '../utils/adminAccess'

function assertUsersAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'users')
}

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const query = AdminUserZodSchema.listAdminUsersQuery.parse(req.query)
  const data = await adminUserService.list(query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Admin users fetched',
    data,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const stats = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const data = await adminUserService.stats()
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin user stats fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const body = AdminUserZodSchema.createAdminUser.parse(req.body)
  const data = await adminUserService.create(body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 201, message: 'User created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const body = AdminUserZodSchema.updateAdminUser.parse(req.body)
  const data = await adminUserService.update(param(req.params.id), body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'User updated', data })
})

const setStatus = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const body = AdminUserZodSchema.setAdminUserStatus.parse(req.body)
  const data = await adminUserService.setStatus(param(req.params.id), body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'User status updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  await adminUserService.remove(param(req.params.id), {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'User deleted', data: null })
})

const createPaymentLink = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertUsersAccess(req.user)
  const data = await adminUserService.createPaymentLink(param(req.params.id), {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Payment link created', data })
})

const adminUserController = {
  list,
  stats,
  create,
  update,
  setStatus,
  remove,
  createPaymentLink,
}

export default adminUserController
