import { Router } from 'express'
import birthdayWishController from '../controller/birthdayWish.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.post('/birthday-wishes/run', birthdayWishController.run)

export default router
