import { Router } from 'express'
import multer from 'multer'
import {
  MEDIA_ATTACHMENT_POLICIES,
  MEDIA_UPLOAD_MAX_BYTES,
  mediaAttachmentTooLargeMessage,
  mediaAttachmentTypeMessage,
} from '../constants/mediaUpload'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import { assertMediaUploadAllowed, assertUploadWithinPackageLimit } from '../services/entitlement.service'
import profileService from '../services/profile.service'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import s3Utils from '../utils/s3'
import sendResponse from '../utils/sendResponse'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES },
})

const router = Router()

type UploadedMediaKind = 'image' | 'video' | 'other'

const uploadedMediaKind = (file: Express.Multer.File): UploadedMediaKind => {
  if (file.mimetype.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.originalname)) {
    return 'image'
  }
  if (file.mimetype.startsWith('video/') || /\.(m4v|mov|mp4|ogv|ogg|webm)$/i.test(file.originalname)) {
    return 'video'
  }
  return 'other'
}

const validateAttachmentUpload = (file: Express.Multer.File, attachmentType?: string) => {
  const policy = attachmentType
    ? MEDIA_ATTACHMENT_POLICIES[attachmentType as keyof typeof MEDIA_ATTACHMENT_POLICIES]
    : undefined
  if (!policy) return

  if (file.size > policy.maxBytes) {
    throw new AppError(413, mediaAttachmentTooLargeMessage(policy))
  }

  if (!policy.allowedKinds.some((kind) => kind === uploadedMediaKind(file))) {
    throw new AppError(415, mediaAttachmentTypeMessage(policy))
  }
}

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.post(
  '/upload',
  upload.single('file'),
  catchAsyncError(async (req, res) => {
    if (!req.file) throw new AppError(400, 'file is required')
    validateAttachmentUpload(req.file, req.body.attachmentType as string | undefined)
    if (req.user?.id) {
      await assertMediaUploadAllowed(req.user.id, req.user.role, {
        attachmentType: req.body.attachmentType as string | undefined,
        mimetype: req.file.mimetype,
        filename: req.file.originalname,
      })
      await assertUploadWithinPackageLimit(req.user.id, req.user.role, req.file.size)
    }
    const result = await s3Utils.uploadBuffer(req.file.buffer, {
      contentType: req.file.mimetype,
      filename: req.file.originalname,
      resourceType: 'auto',
    })

    const profileId = req.body.profileId as string | undefined
    const attachableType = (req.body.attachableType as string) || 'Profile'
    const attachableId = (req.body.attachableId as string) || profileId
    const attachmentTypeName = req.body.attachmentType as string | undefined

    let attachment = null
    if (attachableId && profileId && req.user) {
      if (req.user.accountStatus === 'PAUSED') {
        throw new AppError(403, 'Account is paused. You cannot create or edit vCards. Please contact support.')
      }
      await profileService.getOwnedLite(profileId, req.user.id, req.user.role)
      let attachmentTypeId: string | undefined
      if (attachmentTypeName) {
        const type =
          (await prisma.attachmentType.findFirst({
            where: { name: { equals: attachmentTypeName, mode: 'insensitive' } },
          })) ||
          (await prisma.attachmentType.create({
            data: { name: attachmentTypeName, slug: attachmentTypeName.toLowerCase().replace(/\s+/g, '-') },
          }))
        attachmentTypeId = type.id
      }
      attachment = await prisma.attachment.create({
        data: {
          attachableType,
          attachableId,
          profileId,
          postId: attachableType === 'Post' ? attachableId : undefined,
          attachmentTypeId,
          docName: req.file.originalname,
          url: result.url,
          publicId: result.publicId,
          resourceType: result.resourceType,
          format: result.format,
          bytes: result.bytes,
          extension: result.format,
          mimeType: req.file.mimetype,
        },
      })
    }

    sendResponse(res, {
      success: true,
      statusCode: 201,
      message: 'Uploaded',
      data: { ...result, attachment },
    })
  })
)

router.post(
  '/upload-url',
  catchAsyncError(async (req, res) => {
    const url = req.body.url as string
    if (!url) throw new AppError(400, 'url is required')
    if (req.user?.id) {
      await assertMediaUploadAllowed(req.user.id, req.user.role, {
        attachmentType: req.body.attachmentType as string | undefined,
        filename: url,
      })
    }
    const result = await s3Utils.uploadFromUrl(url)
    sendResponse(res, { success: true, statusCode: 201, message: 'Uploaded from URL', data: result })
  })
)

export default router
