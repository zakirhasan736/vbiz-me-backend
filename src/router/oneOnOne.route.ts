import { Router } from 'express'
import oneOnOneController from '../controller/oneOnOne.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import { OneOnOneZodSchema } from '../zodValidation/oneOnOne.zod'

const router = Router()

/** Public request creation from a guest visiting a public card. */
router.post('/requests', validSchema(OneOnOneZodSchema.createPublicRequest), oneOnOneController.createPublicRequest)

/** Open request list for authorized card/corporate owners. */
router.get('/open', authMiddleware.isAuthenticateUser, oneOnOneController.listOpenRequests)
router.get('/owner/meetings', authMiddleware.isAuthenticateUser, oneOnOneController.listOwnerMeetings)

/** Authenticated schedule / reschedule / cancel / complete. */
router.post(
  '/schedule',
  authMiddleware.isAuthenticateUser,
  validSchema(OneOnOneZodSchema.scheduleMeeting),
  oneOnOneController.scheduleMeeting
)
router.post(
  '/reschedule',
  authMiddleware.isAuthenticateUser,
  validSchema(OneOnOneZodSchema.rescheduleMeeting),
  oneOnOneController.rescheduleMeeting
)
router.post(
  '/cancel',
  authMiddleware.isAuthenticateUser,
  validSchema(OneOnOneZodSchema.cancelMeeting),
  oneOnOneController.cancelMeeting
)
router.post(
  '/complete',
  authMiddleware.isAuthenticateUser,
  validSchema(OneOnOneZodSchema.completeMeeting),
  oneOnOneController.completeMeeting
)

/** Guest deep-link (tokenized) — public. */
router.get('/guest/token/:token', oneOnOneController.getMeetingByToken)
router.get('/guest/:requestId', oneOnOneController.getMeetingForGuest)

export default router
