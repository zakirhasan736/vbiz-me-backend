import { Router } from 'express'
import adminProfileController from '../controller/adminProfile.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import AdminProfileZodSchema from '../zodValidation/adminProfile.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/portfolio-members', adminProfileController.listPortfolioMembers)
router.get('/profiles/filters', adminProfileController.filters)
router.get('/profiles/export', adminProfileController.exportCsv)
router.get('/profiles', adminProfileController.list)
router.post(
  '/profiles/:id/email',
  validSchema(AdminProfileZodSchema.sendProfileEmail),
  adminProfileController.sendProfileEmail
)

export default router
