import { Router } from 'express'
import adminProfileController from '../controller/adminProfile.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/profiles/filters', adminProfileController.filters)
router.get('/profiles/export', adminProfileController.exportCsv)
router.get('/profiles', adminProfileController.list)

export default router
