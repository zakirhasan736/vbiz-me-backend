import { Router } from 'express'
import canvaController from '../controller/canva.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

/** Canva redirects here after OAuth — must stay public (no auth cookie required). */
router.get('/callback', canvaController.callback)

/** Canva Return Navigation landing — public; verifies correlation_jwt server-side. */
router.get('/return', canvaController.returnNav)
router.post('/return', canvaController.returnNav)

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)
router.use(authMiddleware.requireVcardMutable)

router.get('/status', canvaController.status)
router.get('/authorize-url', canvaController.authorizeUrl)
router.delete('/', canvaController.disconnect)
router.get('/designs', canvaController.designs)
router.post('/import', canvaController.importDesign)
router.post('/designs/create', canvaController.createDesign)
router.get('/imports/:id', canvaController.getImport)
router.post('/imports/:id/retry', canvaController.retryImport)
router.post('/imports/:id/cancel', canvaController.cancelImport)

export default router
