import { Router } from 'express'
import announcementController from '../controller/announcement.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import AnnouncementZodSchema from '../zodValidation/announcement.zod'

const adminRouter = Router()

adminRouter.use(authMiddleware.isAuthenticateUser)

adminRouter.get('/announcements', announcementController.list)
adminRouter.post('/announcements', validSchema(AnnouncementZodSchema.createAnnouncement), announcementController.create)
adminRouter.post('/announcements/clear-live', announcementController.clearLive)
adminRouter.get('/announcements/:id', announcementController.getOne)
adminRouter.patch(
  '/announcements/:id',
  validSchema(AnnouncementZodSchema.updateAnnouncement),
  announcementController.update
)
adminRouter.delete('/announcements/:id', announcementController.remove)

const activeRouter = Router()

activeRouter.use(authMiddleware.isAuthenticateUser)
activeRouter.get('/active', announcementController.getActive)

export { activeRouter as announcementActiveRoute, adminRouter as announcementAdminRoute }
export default adminRouter
