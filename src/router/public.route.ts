import { Router } from 'express'
import multer from 'multer'
import publicController from '../controller/public.controller'
import { publicRateLimiter } from '../middlewares/ownership'
import { validSchema } from '../middlewares/validator'
import PublicZodSchema from '../zodValidation/public.zod'

const router = Router()
const formData = multer()

router.use(publicRateLimiter)

router.get('/v/:slug', publicController.getMyCard)
router.get('/post-types', publicController.getPostTypes)
router.get('/profiles/:id/settings', publicController.getSettings)
router.get('/profile-ai-data/:id', publicController.getAiData)
router.get('/dynamic-section/:name', publicController.getDynamicSection)
router.get('/public-cards', publicController.getPublicCards)
router.post('/save-guest-user', formData.none(), publicController.saveGuestUser)
router.post('/save-note', publicController.saveNote)
router.get('/save-contact/:id', publicController.saveContact)
router.get('/profiles/:slug/google-wallet', publicController.googleWallet)
router.post('/track-event', validSchema(PublicZodSchema.trackEvent), publicController.trackEvent)

router.get('/push/subscription-status/:slug', publicController.pushStatus)
router.post('/push/subscribe', publicController.pushSubscribe)
router.post('/push/preferences', publicController.pushPreferences)
router.post('/push/unsubscribe', publicController.pushUnsubscribe)
router.post('/push/test', publicController.pushTest)

export default router
