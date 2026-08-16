import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import * as cardAgentService from '../services/ai/cardAgent.service'
import * as cardJobService from '../services/ai/cardJob.service'
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
router.use(authMiddleware.requireNotSuspended)
router.use(authMiddleware.requireVcardMutable)

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
  '/extract-sources',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'extract', 20)
    const websiteUrl = String(req.body?.websiteUrl || '').trim()
    const businessText = String(req.body?.businessText || '').trim()
    const files = filesFromMulter(req.files as Express.Multer.File[] | undefined)
    const data = await cardAgentService.extractBusinessSources({
      websiteUrl,
      businessText,
      files,
      userId: req.user?.id,
      sessionId: String(req.body?.sessionId || ''),
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'Sources ready',
      data,
    })
  })
)

router.post(
  '/analyze',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    // Deep crawl + GPT can exceed default; Express itself has no timeout here — client may wait ~2m
    rateLimitOrThrow(req, 'analyze', 20)
    const websiteUrl = String(req.body?.websiteUrl || '').trim()
    const businessText = String(req.body?.businessText || '').trim()
    const files = filesFromMulter(req.files as Express.Multer.File[] | undefined)
    const data = await cardAgentService.analyzeBusinessSources({
      websiteUrl,
      businessText,
      files,
      userId: req.user?.id,
      sessionId: String(req.body?.sessionId || ''),
    })
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
      sessionId: String(req.body?.sessionId || ''),
      userId: req.user?.id,
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
      text: String(req.body?.text || req.body?.instruction || ''),
      websiteUrl: String(req.body?.websiteUrl || ''),
      currentDraft: String(req.body?.currentDraft || ''),
      sessionId: String(req.body?.sessionId || ''),
      masterProfile: String(req.body?.masterProfile || ''),
      files,
      userId: req.user?.id,
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: data.message || 'Section filled',
      data,
    })
  })
)

router.post(
  '/regenerate-section',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'fill', 40)
    const data = await cardAgentService.regenerateSection({
      section: String(req.body?.section || ''),
      instruction: String(req.body?.instruction || req.body?.text || ''),
      sessionId: String(req.body?.sessionId || ''),
      currentDraft: String(req.body?.currentDraft || ''),
      userId: req.user?.id,
    })
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: data.message || 'Section updated',
      data,
    })
  })
)

router.post(
  '/jobs',
  optionalMultipart,
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'extract', 20)
    const files = filesFromMulter(req.files as Express.Multer.File[] | undefined)
    let existingCard: unknown
    try {
      existingCard = req.body?.existingCard ? JSON.parse(String(req.body.existingCard)) : undefined
    } catch {
      existingCard = undefined
    }
    const data = await cardJobService.startCardJob({
      websiteUrl: String(req.body?.websiteUrl || '').trim(),
      businessText: String(req.body?.businessText || '').trim(),
      files,
      existingCard,
      userId: req.user?.id,
      sessionId: String(req.body?.sessionId || ''),
    })
    sendResponse(res, { success: true, statusCode: 202, message: 'Card job started', data })
  })
)

router.get(
  '/jobs/:jobId',
  catchAsyncError(async (req, res) => {
    const data = await cardJobService.getJob(String(req.params.jobId), req.user?.id)
    sendResponse(res, { success: true, statusCode: 200, message: 'Card job', data })
  })
)

router.post(
  '/jobs/:jobId/tabs',
  catchAsyncError(async (req, res) => {
    const selectedNavIds = Array.isArray(req.body?.selectedNavIds) ? req.body.selectedNavIds.map(String) : []
    const data = await cardJobService.setSelectedTabs(String(req.params.jobId), selectedNavIds, req.user?.id)
    sendResponse(res, { success: true, statusCode: 200, message: 'Tabs updated', data })
  })
)

router.post(
  '/jobs/:jobId/fields/:fieldId',
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'fill', 40)
    const data = await cardJobService.applyFieldAction({
      jobId: String(req.params.jobId),
      fieldId: String(req.params.fieldId),
      action: String(req.body?.action || 'SKIP') as Parameters<typeof cardJobService.applyFieldAction>[0]['action'],
      value: req.body?.value,
      instruction: String(req.body?.instruction || ''),
      userId: req.user?.id,
    })
    sendResponse(res, { success: true, statusCode: 200, message: 'Field updated', data })
  })
)

router.post(
  '/jobs/:jobId/fast-mode',
  catchAsyncError(async (req, res) => {
    rateLimitOrThrow(req, 'fill', 20)
    const mode = String(req.body?.mode || 'review') as 'ai' | 'found' | 'review'
    const data = await cardJobService.runFastMode(String(req.params.jobId), mode, req.user?.id)
    sendResponse(res, { success: true, statusCode: 200, message: 'Fast mode applied', data })
  })
)

router.post(
  '/jobs/:jobId/assemble',
  catchAsyncError(async (req, res) => {
    const data = await cardJobService.assembleJob(String(req.params.jobId), req.user?.id)
    sendResponse(res, { success: true, statusCode: 200, message: 'Draft assembled', data })
  })
)

router.post(
  '/jobs/:jobId/apply',
  catchAsyncError(async (req, res) => {
    if (!req.user?.id) throw new AppError(403, 'Unauthorized')
    const data = await cardJobService.applyJob({
      jobId: String(req.params.jobId),
      userId: req.user.id,
      role: String(req.user.role || ''),
      publish: req.body?.publish === true,
    })
    sendResponse(res, { success: true, statusCode: 200, message: 'Card filled', data })
  })
)

export default router
