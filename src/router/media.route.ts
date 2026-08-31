import { Router } from 'express'
import multer from 'multer'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import profileService from '../services/profile.service'
import catchAsyncError from '../utils/catchAsyncError'
import { prisma } from '../utils/prisma'
import s3Utils from '../utils/s3'
import sendResponse from '../utils/sendResponse'

const upload = multer({
  storage: multer.memoryStorage(),
})

const router = Router()

const validateAttachmentUpload = (_file: Express.Multer.File, _attachmentType?: string) => {
  // Builder media accepts any image/video/audio/document the client sends — no mime gate.
}

const ATTACHMENT_TYPE_ALIASES: Record<string, string[]> = {
  'Profile Image/Video': [
    'profile image/video',
    'profile picture',
    'profile pic',
    'profile_pic',
    'avatar',
    'profile image',
    'profile',
  ],
  'Background Video/Image': [
    'background video/image',
    'background_media',
    'bg_video',
    'bg video',
    'background video',
    'background',
  ],
  'Intro vCard Video': ['intro vcard video', 'intro video', 'profile video', 'intro'],
  '2D Video Explainer': ['2d video explainer', '2d explainer', '2d video', 'video explainer', 'video_explainer'],
  'Background Music': ['background music', 'background audio', 'bg music', 'audio', 'music'],
}

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.post(
  '/upload',
  upload.single('file'),
  catchAsyncError(async (req, res) => {
    if (!req.file) throw new AppError(400, 'file is required')
    validateAttachmentUpload(req.file, req.body.attachmentType as string | undefined)
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

        // Replace prior attachments of the same builder type so clears/hydrates stay consistent.
        const aliases = ATTACHMENT_TYPE_ALIASES[attachmentTypeName] || [attachmentTypeName.toLowerCase()]
        const existing = await prisma.attachment.findMany({
          where: { profileId },
          include: { attachmentType: true },
        })
        for (const att of existing) {
          const label = `${att.attachmentType?.name || ''} ${att.docName || ''}`.toLowerCase()
          if (!aliases.some((alias) => label.includes(alias))) continue
          const key = att.publicId?.trim()
          if (key) {
            try {
              await s3Utils.destroy(key)
            } catch {
              /* best-effort */
            }
          }
          await prisma.attachment.delete({ where: { id: att.id } })
        }
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
  '/clear',
  catchAsyncError(async (req, res) => {
    const profileId = String(req.body.profileId || '').trim()
    const attachmentType = String(req.body.attachmentType || '').trim()
    const settingKey = String(req.body.settingKey || '').trim() || undefined
    if (!profileId) throw new AppError(400, 'profileId is required')
    if (!attachmentType) throw new AppError(400, 'attachmentType is required')
    if (!req.user) throw new AppError(401, 'Unauthorized')

    await profileService.getOwnedLite(profileId, req.user.id, req.user.role)

    const aliases = ATTACHMENT_TYPE_ALIASES[attachmentType] || [attachmentType.toLowerCase()]
    const attachments = await prisma.attachment.findMany({
      where: { profileId },
      include: { attachmentType: true },
    })

    const matched = attachments.filter((att) => {
      const label = `${att.attachmentType?.name || ''} ${att.docName || ''}`.toLowerCase()
      return aliases.some((alias) => label.includes(alias))
    })

    for (const att of matched) {
      const key = att.publicId?.trim()
      if (key) {
        try {
          await s3Utils.destroy(key)
        } catch {
          /* best-effort S3 delete */
        }
      }
      await prisma.attachment.delete({ where: { id: att.id } })
    }

    if (settingKey) {
      await prisma.setting.upsert({
        where: { profileId_key: { profileId, key: settingKey } },
        create: { profileId, key: settingKey, value: '' },
        update: { value: '' },
      })
    }

    if (attachmentType === 'Profile Image/Video') {
      await prisma.profile.update({
        where: { id: profileId },
        data: { avatar: null },
      })
    }

    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: 'Media cleared',
      data: { deleted: matched.length },
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
