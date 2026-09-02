import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import meetingService from '../services/meeting.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import sendResponse from '../utils/sendResponse'
import MeetingZodSchema from '../zodValidation/meeting.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

function assertScheduleAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'schedule')
}

function assertCreateMeetingAccess(user: Express.User) {
  if (isStaffRole(user.role)) {
    assertScheduleAccess(user)
    return
  }
  if (user.role === 'vcard-owner' || user.role === 'corporate-owner') return
  throw new AppError(403, 'FORBIDDEN ACCESS')
}

async function resolveActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  })
  if (!user) throw new AppError(403, 'Unauthorized')
  return user
}

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertScheduleAccess(req.user)
  const query = MeetingZodSchema.listMeetingsQuery.parse(req.query)
  const data = await meetingService.list(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meetings fetched', data })
})

const listOwnerMeetings = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = MeetingZodSchema.listOwnerMeetingsQuery.parse(req.query)
  const data = await meetingService.listOwnerMeetings(req.user.id, query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Owner meetings fetched', data })
})

const listOwnerUpcoming = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = MeetingZodSchema.listOwnerUpcomingQuery.parse(req.query)
  const data = await meetingService.listOwnerUpcoming(req.user.id, query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Upcoming meetings fetched', data })
})

const getOne = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertScheduleAccess(req.user)
  const data = await meetingService.getOne(param(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertCreateMeetingAccess(req.user)
  const body = MeetingZodSchema.createMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await meetingService.create(actor, body, req.user.role)
  sendResponse(res, { success: true, statusCode: 201, message: 'Meeting created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertScheduleAccess(req.user)
  const body = MeetingZodSchema.updateMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await meetingService.update(param(req.params.id), actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertScheduleAccess(req.user)
  const actor = await resolveActor(req.user.id)
  const data = await meetingService.remove(param(req.params.id), actor)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting deleted', data })
})

const meetingController = {
  list,
  listOwnerMeetings,
  listOwnerUpcoming,
  getOne,
  create,
  update,
  remove,
}

export default meetingController
