import { z } from 'zod'
import AppError from '../error/AppError'
import crmService, { type CrmActor } from '../services/crm.service'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import CrmZodSchema from '../zodValidation/crm.zod'

function actorFromReq(req: { user?: Express.User }): CrmActor {
  if (!req.user?.id || !req.user.role) throw new AppError(403, 'Unauthorized')
  return {
    id: req.user.id,
    role: req.user.role,
    allowedModules: req.user.allowedModules,
  }
}

const dashboard = catchAsyncError(async (req, res) => {
  const data = await crmService.getCrmDashboard(actorFromReq(req))
  sendResponse(res, { success: true, statusCode: 200, message: 'CRM dashboard fetched', data })
})

const listLeads = catchAsyncError(async (req, res) => {
  const query = CrmZodSchema.listLeadsQuery.parse(req.query)
  const data = await crmService.listCrmLeads(actorFromReq(req), query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'CRM leads fetched',
    data: data.items,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const createLead = catchAsyncError(async (req, res) => {
  const body = CrmZodSchema.createLeadBody.parse(req.body)
  const data = await crmService.createCrmLead(actorFromReq(req), body as unknown as Record<string, unknown>)
  sendResponse(res, { success: true, statusCode: 201, message: 'CRM lead created', data })
})

const patchLead = catchAsyncError(async (req, res) => {
  const { id } = CrmZodSchema.idParam.parse(req.params)
  const body = CrmZodSchema.patchLeadBody.parse(req.body)
  const data = await crmService.patchCrmLead(actorFromReq(req), id, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'CRM lead updated', data })
})

const deleteLead = catchAsyncError(async (req, res) => {
  const { id } = CrmZodSchema.idParam.parse(req.params)
  const data = await crmService.deleteCrmLead(actorFromReq(req), id)
  sendResponse(res, { success: true, statusCode: 200, message: 'CRM lead deleted', data })
})

const schedulePeopleQuery = z.object({
  q: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.string().trim().max(200).optional()),
  limit: z.coerce.number().int().min(1).max(40).default(20),
})

const searchSchedulePeople = catchAsyncError(async (req, res) => {
  const query = schedulePeopleQuery.parse(req.query)
  const data = await crmService.searchSchedulePeople(actorFromReq(req), query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Schedule people fetched', data })
})

const scheduleCalendar = catchAsyncError(async (req, res) => {
  const query = CrmZodSchema.scheduleCalendarQuery.parse(req.query)
  const data = await crmService.getCrmScheduleCalendar(actorFromReq(req), query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'CRM schedule calendar fetched',
    data,
  })
})

const crmController = {
  dashboard,
  listLeads,
  createLead,
  patchLead,
  deleteLead,
  searchSchedulePeople,
  scheduleCalendar,
}

export default crmController
