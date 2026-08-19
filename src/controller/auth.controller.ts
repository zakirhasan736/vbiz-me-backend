import { NextFunction, Request, RequestHandler, Response } from 'express'
import config from '../configs/config'
import { homePathForOwnerMode } from '../constants/packageOwnerMode'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import {
  IChangePasswordBody,
  IForgotPasswordBody,
  ILoginBody,
  IRegisterBody,
  IResendPasswordSetupBody,
  IResetPasswordBody,
  IUpdateUserBody,
  IVerifyEmailBody,
  IVerifyForgotPasswordBody,
  IVerifyPasswordSetupBody,
} from '../interfaces/auth.interface'
import authService from '../services/auth.service'
import authUtils from '../utils/auth.utils'
import catchAsyncError from '../utils/catchAsyncError'
import { ACCOUNT_LOOKUP_OK_MESSAGE } from '../utils/publicSignup'
import sendResponse from '../utils/sendResponse'

const register = catchAsyncError(async (req, res) => {
  const body = req.body as IRegisterBody
  const data = await authService.register(body)

  sendResponse(res, {
    success: true,
    statusCode: 201,
    data,
    message: 'Registration successful. Please verify your email.',
  })
})

const login = catchAsyncError(async (req, res) => {
  const body = req.body as ILoginBody
  const result = await authService.login(body)

  authUtils.setAuthCookies(res, result.accessToken, result.refreshToken)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: {
      profile: result.profile,
      accessToken: result.accessToken,
    },
    message: 'Login successful',
  })
})

const verifyLoginOtp = catchAsyncError(async (req, res) => {
  const body = req.body as { email: string; otp: string }
  const result = await authService.verifyLoginOtp(body)

  authUtils.setAuthCookies(res, result.accessToken, result.refreshToken)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: {
      profile: result.profile,
      accessToken: result.accessToken,
    },
    message: 'Login successful',
  })
})

const resendLoginOtp = catchAsyncError(async (req, res) => {
  const { email } = req.body as { email: string }
  const data = await authService.resendLoginVerification(email)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data,
    message: 'Sign-in code sent',
  })
})

const sendVerificationEmail = catchAsyncError(async (req, res) => {
  const { email } = req.body as { email: string }
  const data = await authService.sendVerificationEmail(email)

  sendResponse(res, {
    data,
    success: true,
    statusCode: 200,
    message: 'Verification email sent successfully',
  })
})

const verifyEmail = catchAsyncError(async (req, res) => {
  const body = req.body as IVerifyEmailBody
  const data = await authService.verifyEmail(body)

  sendResponse(res, {
    data,
    success: true,
    statusCode: 200,
    message: 'User verified successfully',
  })
})

const forgotPassword = catchAsyncError(async (req, res) => {
  const body = req.body as IForgotPasswordBody
  await authService.forgotPassword(body)

  sendResponse(res, {
    data: null,
    success: true,
    statusCode: 200,
    message: ACCOUNT_LOOKUP_OK_MESSAGE,
  })
})

const verifyForgotPassword = catchAsyncError(async (req, res) => {
  const body = req.body as IVerifyForgotPasswordBody
  const data = await authService.verifyForgotPassword(body)

  sendResponse(res, {
    data,
    success: true,
    statusCode: 200,
    message: 'Password reset token is valid',
  })
})

const verifyPasswordSetup = catchAsyncError(async (req, res) => {
  const body = req.body as IVerifyPasswordSetupBody
  const data = await authService.verifyPasswordSetup(body)

  sendResponse(res, {
    data,
    success: true,
    statusCode: 200,
    message: 'Password setup token is valid',
  })
})

const resendPasswordSetup = catchAsyncError(async (req, res) => {
  const body = req.body as IResendPasswordSetupBody
  await authService.resendPasswordSetupEmail(body)

  sendResponse(res, {
    data: null,
    success: true,
    statusCode: 200,
    message: 'If this account needs a password, a setup link has been sent',
  })
})

const resetPassword = catchAsyncError(async (req, res) => {
  const body = req.body as IResetPasswordBody
  const data = await authService.resetPassword(body)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Password reset successfully',
    data,
  })
})

const changePassword = catchAsyncError(async (req, res) => {
  const body = req.body as IChangePasswordBody
  const user = req.user!

  if (!user.id) {
    throw new AppError(401, 'Unauthorized')
  }

  const data = await authService.changePassword(body, user.id)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Password changed successfully',
    data,
  })
})

const deactivateAccount = catchAsyncError(async (req, res) => {
  const user = req.user!

  if (!user.id) {
    throw new AppError(401, 'Unauthorized')
  }

  const data = await authService.deactivateAccount(user.id)

  authUtils.clearAuthCookies(res)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Account deactivated successfully',
    data,
  })
})

const update = catchAsyncError(async (req, res) => {
  const body = req.body as IUpdateUserBody
  const result = await authService.updateUser(body, req.user?.id)

  if ('accessToken' in result && 'refreshToken' in result) {
    authUtils.setAuthCookies(res, result.accessToken, result.refreshToken)
  }

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data:
      'accessToken' in result
        ? {
            user: result.user,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          }
        : { user: result.user },
    message: 'User updated successfully',
  })
})

const persistTours = catchAsyncError(async (req, res) => {
  const user = req.user
  if (!user?.id) {
    throw new AppError(401, 'Unauthorized')
  }

  const keys = (req.body as { keys?: string[] }).keys ?? []
  const completedTours = await authService.persistCompletedTours(user.id, keys)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: { completedTours },
    message: 'Tours saved',
  })
})

const author = catchAsyncError(async (req, res) => {
  const user = req.user
  if (!user?.id) {
    throw new AppError(404, 'User not found')
  }

  const result = await authService.getAuthor(user.id)
  if (!result) {
    throw new AppError(404, 'User not found')
  }

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: result,
    message: 'Success',
  })
})

const logout = catchAsyncError(async (_req, res) => {
  authUtils.clearAuthCookies(res)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: null,
    message: 'Logout successful',
  })
})

const refreshToken = catchAsyncError(async (req, res) => {
  const user = req.user
  if (!user?.id) {
    throw new AppError(403, 'Unauthorized')
  }

  const tokens = await authService.refreshToken(user.id)
  authUtils.setAuthCookies(res, tokens.accessToken, tokens.refreshToken)

  sendResponse(res, {
    success: true,
    statusCode: 200,
    data: tokens,
    message: 'Token refreshed',
  })
})

export const oauthCallback: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const accessToken = req.user?.accessToken
  const refreshTokenCookie = req.user?.refreshToken

  if (!accessToken || !refreshTokenCookie) {
    next(new AppError(401, 'OAuth authentication failed'))
    return
  }

  authUtils.setAuthCookies(res, accessToken, refreshTokenCookie)
  const profile = req.user?.user as { role?: string | null; ownerMode?: 'single' | 'corporate' | null } | undefined
  const nextPath = isStaffRole(profile?.role) ? '/admin/dashboard' : homePathForOwnerMode(profile?.ownerMode ?? null)
  res.redirect(`${config.FRONTEND_URL!}${nextPath}`)
}

const authController = {
  register,
  login,
  verifyLoginOtp,
  resendLoginOtp,
  sendVerificationEmail,
  verifyEmail,
  forgotPassword,
  verifyForgotPassword,
  resetPassword,
  changePassword,
  deactivateAccount,
  update,
  persistTours,
  author,
  logout,
  refreshToken,
  oauthCallback,
  verifyPasswordSetup,
  resendPasswordSetup,
}

export default authController
