import AppError from '../error/AppError'
import adminLeadsService from '../services/adminLeads.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import AdminLeadsZodSchema from '../zodValidation/adminLeads.zod'

function assertLeadsAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'leads')
}

const stats = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const data = await adminLeadsService.getStats()
  sendResponse(res, { success: true, statusCode: 200, message: 'Leads stats fetched', data })
})

const listSaves = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const query = AdminLeadsZodSchema.listQuery.parse(req.query)
  const data = await adminLeadsService.listSaves(query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Contact saves fetched',
    data: data.items,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const patchSave = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const { id } = AdminLeadsZodSchema.idParam.parse(req.params)
  const body = AdminLeadsZodSchema.patchLeadBody.parse(req.body)
  const data = await adminLeadsService.patchSave(id, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Contact save updated', data })
})

const deleteSave = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const { id } = AdminLeadsZodSchema.idParam.parse(req.params)
  const data = await adminLeadsService.deleteSave(id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Contact save deleted', data })
})

const listNotes = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const query = AdminLeadsZodSchema.listQuery.parse(req.query)
  const data = await adminLeadsService.listNotes(query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Lead notes fetched',
    data: data.items,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const patchNote = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const { id } = AdminLeadsZodSchema.idParam.parse(req.params)
  const body = AdminLeadsZodSchema.patchLeadBody.parse(req.body)
  const data = await adminLeadsService.patchNote(id, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Lead note updated', data })
})

const deleteNote = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertLeadsAccess(req.user)
  const { id } = AdminLeadsZodSchema.idParam.parse(req.params)
  const data = await adminLeadsService.deleteNote(id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Lead note deleted', data })
})

const adminLeadsController = {
  stats,
  listSaves,
  patchSave,
  deleteSave,
  listNotes,
  patchNote,
  deleteNote,
}

export default adminLeadsController
