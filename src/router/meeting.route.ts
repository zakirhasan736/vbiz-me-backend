import { Router } from 'express'
import meetingController from '../controller/meeting.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import MeetingZodSchema from '../zodValidation/meeting.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/', meetingController.list)
router.post('/', validSchema(MeetingZodSchema.createMeeting), meetingController.create)
router.get('/:id', meetingController.getOne)
router.patch('/:id', validSchema(MeetingZodSchema.updateMeeting), meetingController.update)
router.delete('/:id', meetingController.remove)

export default router
