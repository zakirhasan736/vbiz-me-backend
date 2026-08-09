import { Router } from 'express'
import adminPackageController from '../controller/adminPackage.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/packages', adminPackageController.list)
router.get('/packages/:id', adminPackageController.getById)
router.post('/packages', adminPackageController.create)
router.patch('/packages/:id', adminPackageController.update)
router.delete('/packages/:id', adminPackageController.remove)

export default router
