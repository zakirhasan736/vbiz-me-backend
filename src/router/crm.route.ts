import { Router } from 'express'
import crmController from '../controller/crm.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.get('/dashboard', crmController.dashboard)

export default router
