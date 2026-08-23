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

export default router
