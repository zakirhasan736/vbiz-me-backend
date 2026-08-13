import { Router } from 'express'
import canvaController from '../controller/canva.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

/** Canva redirects here after OAuth — must stay public (no auth cookie required). */
router.get('/callback', canvaController.callback)

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)
router.use(authMiddleware.requireVcardMutable)

router.get('/status', canvaController.status)
router.get('/authorize-url', canvaController.authorizeUrl)
router.delete('/', canvaController.disconnect)
router.get('/designs', canvaController.designs)
router.post('/import', canvaController.importDesign)

export default router
