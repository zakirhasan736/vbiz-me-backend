import AppError from '../error/AppError'
import oneOnOneService from '../services/oneOnOne.service'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import sendResponse from '../utils/sendResponse'
import { OneOnOneZodSchema } from '../zodValidation/oneOnOne.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

async function resolveActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  })
  if (!user) throw new AppError(403, 'Unauthorized')
  return user
}

const createPublicRequest = catchAsyncError(async (req, res) => {
  const body = OneOnOneZodSchema.createPublicRequest.parse(req.body)
  const data = await oneOnOneService.createPublicRequest(body)
  sendResponse(res, { success: true, statusCode: 201, message: '1-on-1 request created', data })
})

const listOpenRequests = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = OneOnOneZodSchema.listOpenRequests.parse(req.query)
  const data = await oneOnOneService.listOpenRequests(req.user as never, query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Open 1-on-1 requests fetched', data })
})

const scheduleMeeting = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = OneOnOneZodSchema.scheduleMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await oneOnOneService.scheduleMeetingFromRequest(actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Time options sent to guest', data })
})

const rescheduleMeeting = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = OneOnOneZodSchema.rescheduleMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await oneOnOneService.rescheduleMeetingFromRequest(actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting rescheduled', data })
})

const cancelMeeting = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = OneOnOneZodSchema.cancelMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await oneOnOneService.cancelMeetingFromRequest(actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting cancelled', data })
})

const completeMeeting = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = OneOnOneZodSchema.completeMeeting.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await oneOnOneService.completeMeetingFromRequest(actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting completed', data })
})

const listOwnerMeetings = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const actor = await resolveActor(req.user.id)
  const data = await oneOnOneService.listOwnerMeetings(actor)
  sendResponse(res, { success: true, statusCode: 200, message: 'Owner 1-on-1 meetings fetched', data })
})

const getMeetingForGuest = catchAsyncError(async (req, res) => {
  const requestId = param(req.params.requestId)
  const data = await oneOnOneService.getMeetingForGuest(requestId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting details fetched', data })
})

const getMeetingByToken = catchAsyncError(async (req, res) => {
  const token = param(req.params.token)
  const requestId = oneOnOneService.verifyGuestToken(token)
  if (!requestId) throw new AppError(403, 'Invalid guest access token')
  const data = await oneOnOneService.getMeetingForGuest(requestId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Meeting details fetched', data })
})

const confirmGuestSlot = catchAsyncError(async (req, res) => {
  const requestId = param(req.params.requestId)
  const body = OneOnOneZodSchema.confirmGuestSlot.parse(req.body)
  const data = await oneOnOneService.confirmGuestSlot(requestId, body)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: data.alreadyConfirmed ? 'Meeting already confirmed' : 'Meeting confirmed',
    data,
  })
})

const oneOnOneController = {
  createPublicRequest,
  listOpenRequests,
  scheduleMeeting,
  rescheduleMeeting,
  cancelMeeting,
  completeMeeting,
  listOwnerMeetings,
  getMeetingForGuest,
  getMeetingByToken,
  confirmGuestSlot,
}

export default oneOnOneController
