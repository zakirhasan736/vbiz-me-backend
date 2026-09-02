import { Router } from 'express'
import crmController from '../controller/crm.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import CrmZodSchema from '../zodValidation/crm.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.get('/dashboard', crmController.dashboard)
router.get('/leads', crmController.listLeads)
router.post('/leads', validSchema(CrmZodSchema.createLeadBody), crmController.createLead)
router.patch('/leads/:id', validSchema(CrmZodSchema.patchLeadBody), crmController.patchLead)
router.delete('/leads/:id', crmController.deleteLead)

export default router
