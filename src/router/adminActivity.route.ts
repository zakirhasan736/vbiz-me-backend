import { Router } from 'express'
import adminActivityController from '../controller/adminActivity.controller'
import authMiddleware from '../middlewares/authValidation'
import { validSchema } from '../middlewares/validator'
import AuditZodSchema from '../zodValidation/audit.zod'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/audit-logs', adminActivityController.listAuditLogs)
router.post('/audit-logs', validSchema(AuditZodSchema.createAuditLog), adminActivityController.createAuditLog)
router.delete('/audit-logs', adminActivityController.clearAuditLogs)
router.get('/activity-feed', adminActivityController.activityFeed)

export default router
