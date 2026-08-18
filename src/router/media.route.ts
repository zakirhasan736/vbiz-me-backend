import { Router } from 'express'
import multer from 'multer'
import { MEDIA_UPLOAD_MAX_BYTES } from '../constants/mediaUpload'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
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

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.post(
  '/upload',
  upload.single('file'),
  catchAsyncError(async (req, res) => {
    if (!req.file) throw new AppError(400, 'file is required')
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
    const result = await s3Utils.uploadFromUrl(url)
    sendResponse(res, { success: true, statusCode: 201, message: 'Uploaded from URL', data: result })
  })
)

export default router
