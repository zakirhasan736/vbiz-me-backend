import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import * as cardAgentService from '../services/ai/cardAgent.service'
import { filesFromMulter } from '../services/ai/extractDocumentText'
import { checkAiRateLimit } from '../services/ai/rateLimit'
import catchAsyncError, { type IUserInfoRequest } from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
})

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

function rateLimitOrThrow(req: IUserInfoRequest, action: string, limit: number) {
  const userKey = req.user?.id || req.ip || 'anon'
  const limited = checkAiRateLimit(`${action}:${userKey}`, limit)
  if (!limited.ok) {
    throw new AppError(429, `Too many AI requests. Retry in ${limited.retryAfterSec}s.`, {
      code: 'RATE_LIMITED',
      data: { retryAfterSec: limited.retryAfterSec },
    })
  }
}

function optionalMultipart(req: Request, res: Response, next: NextFunction) {
  if (req.is('multipart/form-data')) {
    return upload.array('files', 6)(req, res, next)
  }
  return next()
}

router.post(
  '/analyze',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    // Deep crawl + GPT can exceed default; Express itself has no timeout here — client may wait ~2m
    rateLimitOrThrow(req, 'analyze', 20)
    const websiteUrl = String(req.body?.websiteUrl || '').trim()
    const businessText = String(req.body?.businessText || '').trim()
    const files = filesFromMulter(req.files as Express.Multer.File[] | undefined)
    const data = await cardAgentService.analyzeBusinessSources({ websiteUrl, businessText, files })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'Card blueprint generated',
      data,
    })
  })
)

router.post(
  '/suggest-tabs',
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'suggest', 40)
    const data = await cardAgentService.suggestTabs({
      businessSummary: String(req.body?.businessSummary || ''),
      enabledNavIds: Array.isArray(req.body?.enabledNavIds) ? req.body.enabledNavIds.map(String) : [],
      draftSummary: String(req.body?.draftSummary || ''),
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'Tab suggestions ready',
      data,
    })
  })
)

router.post(
  '/fill-section',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'fill', 40)
    const files = filesFromMulter(req.files as Express.Multer.File[] | undefined)
    const data = await cardAgentService.fillSection({
      section: String(req.body?.section || ''),
      text: String(req.body?.text || ''),
      currentDraft: String(req.body?.currentDraft || ''),
      files,
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'Section filled',
      data,
    })
  })
)

export default router
