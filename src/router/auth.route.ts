import { Router } from 'express'
import passport from 'passport'
import config from '../configs/config'
import authController, { oauthCallback } from '../controller/auth.controller'
import authMiddleware from '../middlewares/authValidation'
import verifyTurnstile from '../middlewares/turnstile'
import { validSchema } from '../middlewares/validator'
import AuthZodSchema from '../zodValidation/auth.zod'

const router = Router()

router.post('/register', validSchema(AuthZodSchema.register), verifyTurnstile, authController.register)
router.post('/login', validSchema(AuthZodSchema.login), verifyTurnstile, authController.login)
router.post('/login-otp/verify', validSchema(AuthZodSchema.loginOtp), authController.verifyLoginOtp)
router.post('/login-otp/resend', validSchema(AuthZodSchema.resendLoginOtp), authController.resendLoginOtp)
router.post(
  '/send-verification-email',
  validSchema(AuthZodSchema.sendVerificationEmail),
  authController.sendVerificationEmail
)
router.post('/verify-email', validSchema(AuthZodSchema.verifyEmail), authController.verifyEmail)
router.post(
  '/forgot-password',
  validSchema(AuthZodSchema.forgotPassword),
  verifyTurnstile,
  authController.forgotPassword
)
router.post(
  '/forgot-password/verify',
  validSchema(AuthZodSchema.verifyForgotPassword),
  authController.verifyForgotPassword
)
router.put('/reset-password', validSchema(AuthZodSchema.resetPassword), authController.resetPassword)
router.post(
  '/password-setup/verify',
  validSchema(AuthZodSchema.verifyPasswordSetup),
  authController.verifyPasswordSetup
)
router.post(
  '/password-setup/resend',
  validSchema(AuthZodSchema.resendPasswordSetup),
  authController.resendPasswordSetup
)
router.put(
  '/change-password',
  authMiddleware.isAuthenticateUser,
  authMiddleware.requireNotSuspended,
  validSchema(AuthZodSchema.changePassword),
  authController.changePassword
)
router.post(
  '/deactivate',
  authMiddleware.isAuthenticateUser,
  authMiddleware.requireNotSuspended,
  authController.deactivateAccount
)
router.patch(
  '/update',
  validSchema(AuthZodSchema.update),
  authMiddleware.optionalAuthenticateUser,
  authController.update
)
router.patch(
  '/tours',
  authMiddleware.isAuthenticateUser,
  validSchema(AuthZodSchema.persistTours),
  authController.persistTours
)
router.get('/author', authMiddleware.isAuthenticateUser, authController.author)
router.post('/logout', authController.logout)
router.post('/refresh-token', authMiddleware.requireRefreshSession, authController.refreshToken)

router.get(
  '/google',
  authMiddleware.requireGoogleOAuth,
  passport.authenticate('google', { session: false, scope: ['profile', 'email'] })
)

router.get(
  '/google/callback',
  authMiddleware.requireGoogleOAuth,
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${config.FRONTEND_URL!}/login`,
  }),
  oauthCallback
)

router.get(
  '/facebook',
  authMiddleware.requireFacebookOAuth,
  passport.authenticate('facebook', { session: false, scope: ['email'] })
)

router.get(
  '/facebook/callback',
  authMiddleware.requireFacebookOAuth,
  passport.authenticate('facebook', {
    session: false,
    failureRedirect: `${config.FRONTEND_URL!}/login`,
  }),
  oauthCallback
)

export default router
