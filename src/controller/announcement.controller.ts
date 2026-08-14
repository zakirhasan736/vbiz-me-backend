import AppError from '../error/AppError'
import announcementService from '../services/announcement.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import sendResponse from '../utils/sendResponse'
import AnnouncementZodSchema from '../zodValidation/announcement.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

function assertAnnouncementsAccess(user: Express.User) {
  assertModule(user.role, user.allowedModules, 'announcements')
}

async function resolveActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  })
  if (!user) throw new AppError(403, 'Unauthorized')
  return user
}

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const query = AnnouncementZodSchema.listAnnouncementsQuery.parse(req.query)
  const data = await announcementService.list(query)
  sendResponse(res, { success: true, statusCode: 200, message: 'Announcements fetched', data })
})

const getOne = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const data = await announcementService.getOne(param(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Announcement fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const body = AnnouncementZodSchema.createAnnouncement.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await announcementService.create(actor, body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Announcement created', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const body = AnnouncementZodSchema.updateAnnouncement.parse(req.body)
  const actor = await resolveActor(req.user.id)
  const data = await announcementService.update(param(req.params.id), actor, body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Announcement updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const actor = await resolveActor(req.user.id)
  const data = await announcementService.remove(param(req.params.id), actor)
  sendResponse(res, { success: true, statusCode: 200, message: 'Announcement deleted', data })
})

const clearLive = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertAnnouncementsAccess(req.user)
  const actor = await resolveActor(req.user.id)
  const data = await announcementService.clearLive(actor)
  sendResponse(res, { success: true, statusCode: 200, message: 'Live banner cleared', data })
})

const getActive = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const actor = await resolveActor(req.user.id)
  const { banner, inbox } = await announcementService.getActiveForUser({
    email: actor.email,
    role: req.user.role,
  })
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    success: true,
    statusCode: 200,
    message: banner || inbox.length ? 'Active announcement fetched' : 'No active announcement',
    data: banner,
    inbox,
  })
})

const announcementController = {
  list,
  getOne,
  create,
  update,
  remove,
  clearLive,
  getActive,
}

export default announcementController
