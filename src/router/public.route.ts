import { Router } from 'express'
import multer from 'multer'
import publicController from '../controller/public.controller'
import { publicRateLimiter } from '../middlewares/ownership'
import { validSchema } from '../middlewares/validator'
import PublicZodSchema from '../zodValidation/public.zod'

const router = Router()
const formData = multer()

// Wallet saves are one-off user actions. Do not share the public GET budget
// with the vCard page (which can fire many section requests in one visit).
router.get('/profiles/:slug/google-wallet', publicController.googleWallet)
router.get('/profiles/:slug/apple-wallet', publicController.appleWallet)

router.use(publicRateLimiter)

router.get('/v/:slug', publicController.getMyCard)
router.get('/v/:slug/bootstrap', publicController.getBootstrap)
router.get('/cards/:slug/bootstrap', publicController.getBootstrap)
router.get('/post-types', publicController.getPostTypes)
router.get('/profiles/:id/settings', publicController.getSettings)
router.get('/profiles/:id/announcement', publicController.getProfileAnnouncement)
router.get('/profile-ai-data/:id', publicController.getAiData)
router.get('/dynamic-section/:name', publicController.getDynamicSection)
router.get('/public-cards', publicController.getPublicCards)
router.post('/save-guest-user', formData.none(), publicController.saveGuestUser)
router.post('/save-note', publicController.saveNote)
router.get('/save-contact/:id', publicController.saveContact)
router.post('/track-event', validSchema(PublicZodSchema.trackEvent), publicController.trackEvent)

router.get('/push/subscription-status/:slug', publicController.pushStatus)
router.get('/push/vapid-public-key', publicController.pushVapidPublicKey)
router.post('/push/subscribe', validSchema(PublicZodSchema.pushSubscribe), publicController.pushSubscribe)
router.post('/push/preferences', validSchema(PublicZodSchema.pushPreferences), publicController.pushPreferences)
router.post('/push/unsubscribe', validSchema(PublicZodSchema.pushUnsubscribe), publicController.pushUnsubscribe)
router.post('/push/test', validSchema(PublicZodSchema.pushTest), publicController.pushTest)

export default router
