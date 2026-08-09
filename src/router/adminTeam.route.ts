import { Router } from 'express'
import adminTeamController from '../controller/adminTeam.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/team', adminTeamController.list)
router.post('/team', adminTeamController.create)
router.patch('/team/:id/status', adminTeamController.setStatus)
router.patch('/team/:id', adminTeamController.update)
router.delete('/team/:id', adminTeamController.remove)

export default router
