import AppError from '../error/AppError'
import adminPackageService from '../services/adminPackage.service'
import { assertSuperAdmin } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'
import AdminPackageZodSchema from '../zodValidation/adminPackage.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const data = await adminPackageService.list()
  sendResponse(res, { success: true, statusCode: 200, message: 'Packages fetched', data })
})

const getById = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const data = await adminPackageService.getById(param(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Package fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AdminPackageZodSchema.createAdminPackage.parse(req.body)
  const data = await adminPackageService.create(body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 201, message: 'Package created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  const body = AdminPackageZodSchema.updateAdminPackage.parse(req.body)
  const data = await adminPackageService.update(param(req.params.id), body, {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Package updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertSuperAdmin(req.user.role)
  await adminPackageService.remove(param(req.params.id), {
    actorId: req.user.id,
    actorEmail: req.user.email,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Package deleted', data: null })
})

const adminPackageController = {
  list,
  getById,
  create,
  update,
  remove,
}

export default adminPackageController
