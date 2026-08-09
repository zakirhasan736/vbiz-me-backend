import { Router } from 'express'
import templateController from '../controller/template.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import CardTemplateZodSchema from '../zodValidation/template.zod'

const adminRouter = Router()

adminRouter.use(authMiddleware.isAuthenticateUser)

adminRouter.get('/templates', templateController.listAdmin)
adminRouter.patch('/templates/:id', validSchema(CardTemplateZodSchema.updateCardTemplate), templateController.update)

const activeRouter = Router()

activeRouter.use(authMiddleware.isAuthenticateUser)
activeRouter.get('/', templateController.listActive)

export { activeRouter as templateActiveRoute, adminRouter as templateAdminRoute }
export default adminRouter
