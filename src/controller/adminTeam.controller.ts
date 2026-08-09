import AppError from '../error/AppError'
import adminTeamService from '../services/adminTeam.service'
import { assertSuperAdmin } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'
import AdminTeamZodSchema from '../zodValidation/adminTeam.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const data = await adminTeamService.list()
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin team fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AdminTeamZodSchema.createAdminTeamMember.parse(req.body)
  const data = await adminTeamService.create(body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 201, message: 'Admin created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AdminTeamZodSchema.updateAdminTeamMember.parse(req.body)
  const data = await adminTeamService.update(param(req.params.id), body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin updated', data })
})

const setStatus = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AdminTeamZodSchema.setAdminTeamStatus.parse(req.body)
  const data = await adminTeamService.setStatus(param(req.params.id), body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin status updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  await adminTeamService.remove(param(req.params.id), {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin removed', data: null })
})

const adminTeamController = {
  list,
  create,
  update,
  setStatus,
  remove,
}

export default adminTeamController
