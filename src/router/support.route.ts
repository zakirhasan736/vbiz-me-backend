import { Router } from 'express'
import supportController from '../controller/support.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import SupportZodSchema from '../zodValidation/support.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.get('/support-tickets', supportController.list)
router.post('/support-tickets', validSchema(SupportZodSchema.createSupportTicket), supportController.create)
router.get('/support-tickets/:id', supportController.getOne)
router.patch('/support-tickets/:id', validSchema(SupportZodSchema.updateSupportTicket), supportController.update)
router.delete('/support-tickets/:id', supportController.remove)

export default router
