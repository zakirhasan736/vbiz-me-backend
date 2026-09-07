import AppError from '../error/AppError'
import crmService, { type CrmActor } from '../services/crm.service'
import workNoteService from '../services/workNote.service'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import WorkNoteZodSchema from '../zodValidation/workNote.zod'

function actorFromReq(req: { user?: Express.User }): CrmActor {
  if (!req.user?.id || !req.user.role) throw new AppError(403, 'Unauthorized')
  return {
    id: req.user.id,
    role: req.user.role,
    allowedModules: req.user.allowedModules,
  }
}

const list = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const query = WorkNoteZodSchema.listQuery.parse(req.query)
  const data = await workNoteService.listWorkNotes(actor, access, query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Notes fetched',
    data: data.items,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const getOne = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = WorkNoteZodSchema.idParam.parse(req.params)
  const data = await workNoteService.getWorkNote(actor, access, id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Note fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const body = WorkNoteZodSchema.createBody.parse(req.body)
  const data = await workNoteService.createWorkNote(actor, access, body as unknown as Record<string, unknown>)
  sendResponse(res, { success: true, statusCode: 201, message: 'Note created', data })
})

const update = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = WorkNoteZodSchema.idParam.parse(req.params)
  const body = WorkNoteZodSchema.updateBody.parse(req.body)
  const data = await workNoteService.updateWorkNote(actor, access, id, body as unknown as Record<string, unknown>)
  sendResponse(res, { success: true, statusCode: 200, message: 'Note updated', data })
})

const reorder = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const body = WorkNoteZodSchema.reorderBody.parse(req.body)
  const data = await workNoteService.reorderWorkNotes(actor, access, body.items)
  sendResponse(res, { success: true, statusCode: 200, message: 'Notes reordered', data })
})

const remove = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = WorkNoteZodSchema.idParam.parse(req.params)
  const data = await workNoteService.deleteWorkNote(actor, access, id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Note deleted', data })
})

const workNoteController = {
  list,
  getOne,
  create,
  update,
  reorder,
  remove,
}

export default workNoteController
