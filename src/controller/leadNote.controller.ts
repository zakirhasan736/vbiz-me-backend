import AppError from '../error/AppError'
import crmService, { type CrmActor } from '../services/crm.service'
import leadNoteService from '../services/leadNote.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'
import LeadNoteZodSchema from '../zodValidation/leadNote.zod'

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
  const { leadId } = LeadNoteZodSchema.leadIdParam.parse(req.params)
  const data = await leadNoteService.listLeadNotes(actor, access, leadId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Lead notes fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { leadId } = LeadNoteZodSchema.leadIdParam.parse(req.params)
  const body = LeadNoteZodSchema.createBody.parse(req.body)
  const data = await leadNoteService.createLeadNote(actor, access, leadId, body as unknown as Record<string, unknown>)
  sendResponse(res, { success: true, statusCode: 201, message: 'Lead note created', data })
})

const update = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { leadId, noteId } = LeadNoteZodSchema.noteIdParam.parse(req.params)
  const body = LeadNoteZodSchema.updateBody.parse(req.body)
  const data = await leadNoteService.updateLeadNote(
    actor,
    access,
    leadId,
    noteId,
    body as unknown as Record<string, unknown>
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Lead note updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { leadId, noteId } = LeadNoteZodSchema.noteIdParam.parse(req.params)
  const data = await leadNoteService.deleteLeadNote(actor, access, leadId, noteId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Lead note deleted', data })
})

const leadNoteController = {
  list,
  create,
  update,
  remove,
}

export default leadNoteController
