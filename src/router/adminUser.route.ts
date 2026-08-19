import { Router } from 'express'
import adminUserController from '../controller/adminUser.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/users/stats', adminUserController.stats)
router.get('/users', adminUserController.list)
router.post('/users', adminUserController.create)
router.post('/users/:id/payment-link', adminUserController.createPaymentLink)
router.patch('/users/:id/status', adminUserController.setStatus)
router.patch('/users/:id', adminUserController.update)
router.delete('/users/:id', adminUserController.remove)

export default router
