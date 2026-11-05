import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import profileAssistantController from '../controller/profileAssistant.controller'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import { assertProfileAccess } from '../middlewares/ownership'
import { checkAiRateLimit } from '../services/ai/rateLimit'
import type { IUserInfoRequest } from '../utils/catchAsyncError'

const router = Router({ mergeParams: true })
const allowedFile = /\.(pdf|docx|txt|md|png|jpe?g|webp|gif)$/i
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, callback) => {
    if (allowedFile.test(file.originalname)) return callback(null, true)
    callback(new AppError(400, `Unsupported file type for “${file.originalname}”.`))
  },
})

function optionalMultipart(req: Request, res: Response, next: NextFunction) {
  if (req.is('multipart/form-data')) return upload.array('files', 6)(req, res, next)
  return next()
}

function assistantRateLimit(limit: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const userRequest = req as IUserInfoRequest
    const key = `profile-assistant:${userRequest.user?.id || req.ip}:${req.params.profileId}`
    const result = checkAiRateLimit(key, limit)
    if (!result.ok) {
      next(
        new AppError(429, `Too many assistant requests. Retry in ${result.retryAfterSec}s.`, {
          code: 'RATE_LIMITED',
        })
      )
      return
    }
    next()
  }
}

router.use(assertProfileAccess)
router.get('/config', profileAssistantController.getConfig)
router.patch('/config', authMiddleware.requireVcardMutable, profileAssistantController.updateConfig)
router.get('/knowledge', profileAssistantController.listKnowledge)
router.post(
  '/knowledge/extract',
  authMiddleware.requireVcardMutable,
  assistantRateLimit(12),
  optionalMultipart,
  profileAssistantController.extractKnowledge
)
router.delete('/knowledge/:id', authMiddleware.requireVcardMutable, profileAssistantController.deleteKnowledge)
router.post(
  '/fill-section',
  authMiddleware.requireVcardMutable,
  assistantRateLimit(20),
  optionalMultipart,
  profileAssistantController.fillSection
)

export default router
