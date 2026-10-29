import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import AppError from '../error/AppError'
import authMiddleware from '../middlewares/authValidation'
import profileService from '../services/profile.service'
import {
  BUILDER_ATTACHMENT_TYPE_ALIASES,
  attachmentTypeNameMatches,
  isSingletonBuilderAttachmentType,
  sameMediaUrl,
} from '../utils/attachmentTypeMatch'
import { bindCardChangeContext } from '../utils/cardChangeHistory'
import { collectCardMediaKeys } from '../utils/cardMediaScan'
import catchAsyncError from '../utils/catchAsyncError'
import { healMediaKeys } from '../utils/mediaHealth'
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

function isSameBuilderAttachmentType(typeName: string | null | undefined, canonicalType: string): boolean {
  const aliases = BUILDER_ATTACHMENT_TYPE_ALIASES[canonicalType]
  return attachmentTypeNameMatches(typeName, canonicalType, aliases)
}

router.use(authMiddleware.isAuthenticateUser)
router.use(bindCardChangeContext)
router.use(authMiddleware.requireNotSuspended)

function parseSingleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err) => {
    if (err) return next(err)
    next()
  })
}

router.post(
  '/upload',
  parseSingleUpload,
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

        // Singleton slots (avatar / intro / background / music …) hold one file:
        // detach the previous Attachment rows so the new upload becomes the active one.
        // The S3 objects are NEVER deleted here — history restore, daily backups and
        // linked/corporate cards may still point at them. See docs/S3_MEDIA_SAFETY.md.
        if (isSingletonBuilderAttachmentType(attachmentTypeName)) {
          const existing = await prisma.attachment.findMany({
            where: { profileId },
            include: { attachmentType: true },
          })
          const matchedIds = existing
            .filter((att) => isSameBuilderAttachmentType(att.attachmentType?.name, attachmentTypeName))
            .map((att) => att.id)
          if (matchedIds.length) {
            await prisma.attachment.deleteMany({ where: { id: { in: matchedIds } } })
          }
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
    const targetUrl = String(req.body.url || '').trim()
    if (!profileId) throw new AppError(400, 'profileId is required')
    if (!attachmentType) throw new AppError(400, 'attachmentType is required')
    if (!req.user) throw new AppError(401, 'Unauthorized')

    await profileService.getOwnedLite(profileId, req.user.id, req.user.role)

    const attachments = await prisma.attachment.findMany({
      where: { profileId },
      include: { attachmentType: true },
    })

    const typeMatched = attachments.filter((att) =>
      isSameBuilderAttachmentType(att.attachmentType?.name, attachmentType)
    )
    const singleton = isSingletonBuilderAttachmentType(attachmentType)

    // Collection types (Service Featured, Gallery, …) MUST scope by URL.
    // Clearing without a URL used to destroy every sibling item's S3 object while
    // Service/Portfolio rows still held those URLs → browser AccessDenied.
    if (!singleton && !targetUrl) {
      throw new AppError(400, 'url is required when clearing multi-item media (pass the exact file URL to remove)')
    }

    const matched = targetUrl ? typeMatched.filter((att) => sameMediaUrl(att.url, targetUrl)) : typeMatched

    // Remove = detach the Attachment row(s) only. The S3 object is NEVER deleted from
    // the app: an unsaved editor, history restore, daily backups or a linked card can
    // still reference the URL, and a deleted key shows as AccessDenied in the browser.
    // Unused files are reclaimed later by scripts/s3-orphan-cleanup.ts (grace period).
    if (matched.length) {
      await prisma.attachment.deleteMany({ where: { id: { in: matched.map((att) => att.id) } } })
    }

    // Settings / avatar for singleton file clears, or YouTube-only URL fields (no Attachment rows).
    const youtubeUrlOnlyClear =
      attachmentType === 'Intro YouTube vCard Video Link' || attachmentType === 'YouTube Background Music Link'
    const shouldClearSetting =
      Boolean(settingKey) &&
      (youtubeUrlOnlyClear || ((!targetUrl || matched.length > 0) && isSingletonBuilderAttachmentType(attachmentType)))
    if (shouldClearSetting && settingKey) {
      await prisma.setting.upsert({
        where: { profileId_key: { profileId, key: settingKey } },
        create: { profileId, key: settingKey, value: '' },
        update: { value: '' },
      })
    }

    if (attachmentType === 'Profile Image/Video' && !targetUrl) {
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

/**
 * Check every image/video URL on a card and recover any missing S3 file from
 * versioning. Safe to call any time (read + re-put only, never deletes).
 */
router.post(
  '/repair',
  catchAsyncError(async (req, res) => {
    const profileId = String(req.body.profileId || '').trim()
    if (!profileId) throw new AppError(400, 'profileId is required')
    if (!req.user) throw new AppError(401, 'Unauthorized')
    await profileService.getOwnedLite(profileId, req.user.id, req.user.role)

    const keys = await collectCardMediaKeys(profileId)
    const report = await healMediaKeys(keys)
    sendResponse(res, {
      success: true,
      statusCode: 200,
      message: report.missing.length
        ? `${report.restored.length} file(s) recovered, ${report.missing.length} could not be recovered — please re-upload those`
        : `All ${report.checked} media file(s) OK${report.restored.length ? ` (${report.restored.length} recovered)` : ''}`,
      data: {
        checked: report.checked,
        recovered: report.restored.map((key) => s3Utils.publicUrlForKey(key)),
        unrecoverable: report.missing.map((m) => ({ url: s3Utils.publicUrlForKey(m.key), reason: m.reason })),
      },
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
