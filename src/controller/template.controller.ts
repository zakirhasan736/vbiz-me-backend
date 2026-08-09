import AppError from '../error/AppError'
import templateService from '../services/template.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'
import CardTemplateZodSchema from '../zodValidation/template.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

function assertTemplatesAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'templates')
}

const listAdmin = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertTemplatesAccess(req.user)
  const data = await templateService.listAdmin()
  sendResponse(res, { success: true, statusCode: 200, message: 'Templates fetched', data })
})

const listActive = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await templateService.listActive()
  sendResponse(res, { success: true, statusCode: 200, message: 'Templates fetched', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertTemplatesAccess(req.user)
  const { id } = CardTemplateZodSchema.templateIdParam.parse({ id: param(req.params.id) })
  const body = CardTemplateZodSchema.updateCardTemplate.parse(req.body)
  const data = await templateService.update(id, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Template updated', data })
})

const templateController = {
  listAdmin,
  listActive,
  update,
}

export default templateController
