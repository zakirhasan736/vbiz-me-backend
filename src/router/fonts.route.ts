import { Router } from 'express'
import fontsController from '../controller/fonts.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)
router.get('/', fontsController.list)

export default router
