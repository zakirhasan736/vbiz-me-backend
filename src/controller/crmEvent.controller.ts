import AppError from '../error/AppError'
import crmService, { type CrmActor } from '../services/crm.service'
import crmEventService from '../services/crmEvent.service'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import CrmEventZodSchema from '../zodValidation/crmEvent.zod'

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
  const query = CrmEventZodSchema.listCrmEventsQuery.parse(req.query)
  const data = await crmEventService.list(actor, access, query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Events fetched',
    data: data.items,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const getOne = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = CrmEventZodSchema.idParam.parse(req.params)
  const data = await crmEventService.getOne(actor, access, id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Event fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const body = CrmEventZodSchema.createCrmEvent.parse(req.body)
  const data = await crmEventService.create(actor, access, body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Event created', data })
})

const update = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = CrmEventZodSchema.idParam.parse(req.params)
  const body = CrmEventZodSchema.updateCrmEvent.parse(req.body)
  const data = await crmEventService.update(actor, access, id, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Event updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  const actor = actorFromReq(req)
  const access = await crmService.resolveCrmAccess(actor)
  const { id } = CrmEventZodSchema.idParam.parse(req.params)
  const data = await crmEventService.remove(actor, access, id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Event deleted', data })
})

const crmEventController = {
  list,
  getOne,
  create,
  update,
  remove,
}

export default crmEventController
