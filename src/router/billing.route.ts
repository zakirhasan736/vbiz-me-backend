import { Router } from 'express'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import stripeService from '../services/stripe.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const router = Router()

router.post(
  '/checkout',
  authMiddleware.isAuthenticateUser,
  authMiddleware.requireNotSuspended,
  catchAsyncError(async (req, res) => {
    if (!req.user?.id) throw new AppError(403, 'Unauthorized')
    const packageId = String(req.body?.packageId || '').trim()
    if (!packageId) throw new AppError(400, 'packageId is required')
    const data = await stripeService.createCheckoutSession(req.user.id, req.user.role, packageId)
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: data.assigned ? 'Package assigned' : 'Checkout created',
      data,
    })
  })
)

router.post(
  '/checkout-ai-assistance',
  authMiddleware.isAuthenticateUser,
  authMiddleware.requireNotSuspended,
  catchAsyncError(async (req, res) => {
    if (!req.user?.id) throw new AppError(403, 'Unauthorized')
    const profileId = String(req.body?.profileId || '').trim() || null
    const successPath = String(req.body?.successPath || '').trim() || null
    const cancelPath = String(req.body?.cancelPath || '').trim() || null
    const data = await stripeService.createAiAssistanceCheckoutSession(req.user.id, req.user.role, {
      profileId,
      successPath,
      cancelPath,
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'AI Assistance checkout created',
      data,
    })
  })
)

export default router
