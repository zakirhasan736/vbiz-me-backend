import AppError from '../error/AppError'
import adminProfileService from '../services/adminProfile.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'
import AdminProfileZodSchema from '../zodValidation/adminProfile.zod'

import { assertModule } from '../utils/adminAccess'

function assertVcardsAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'vcards')
}

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertVcardsAccess(req.user)
  const query = AdminProfileZodSchema.listAdminProfilesQuery.parse(req.query)
  const data = await adminProfileService.list(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin profiles fetched', data })
})

const filters = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertVcardsAccess(req.user)
  const data = await adminProfileService.getFilterOptions()
  sendResponse(res, { success: true, statusCode: 200, message: 'Admin profile filters fetched', data })
})

const exportCsv = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertVcardsAccess(req.user)
  const query = AdminProfileZodSchema.exportAdminProfilesQuery.parse(req.query)
  const csv = await adminProfileService.exportCsv(query)
  const date = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="vcards-export-${date}.csv"`)
  res.status(200).send(csv)
})

const adminProfileController = {
  list,
  filters,
  exportCsv,
}

export default adminProfileController
