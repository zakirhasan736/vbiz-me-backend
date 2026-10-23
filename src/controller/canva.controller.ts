import type { RequestHandler } from 'express'
import AppError from '../error/AppError'
import * as canvaService from '../services/canva/canva.service'
import { assertUserPackageAccess } from '../services/entitlement.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

async function requireCanvaAccess(user?: Express.User) {
  if (!user?.id) throw new AppError(403, 'Unauthorized')
  await assertUserPackageAccess(user.id, user.role, 'allow_canva')
}

const status = catchAsyncError(async (req, res) => {
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const data = await canvaService.getConnectionStatus(userId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva status', data })
})

const authorizeUrl = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined
  const url = await canvaService.createAuthorizeUrl(userId, returnTo)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Canva authorize URL',
    data: { url },
  })
})

const callback: RequestHandler = async (req, res, next) => {
  try {
    const redirectTo = await canvaService.handleOAuthCallback({
      code: typeof req.query.code === 'string' ? req.query.code : undefined,
      state: typeof req.query.state === 'string' ? req.query.state : undefined,
      error: typeof req.query.error === 'string' ? req.query.error : undefined,
      errorDescription: typeof req.query.error_description === 'string' ? req.query.error_description : undefined,
    })
    res.redirect(redirectTo)
  } catch (error) {
    next(error)
  }
}

const disconnect = catchAsyncError(async (req, res) => {
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const data = await canvaService.disconnect(userId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva disconnected', data })
})

const designs = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const query = typeof req.query.query === 'string' ? req.query.query : undefined
  const continuation = typeof req.query.continuation === 'string' ? req.query.continuation : undefined
  const data = await canvaService.listLibrary(userId, { query, continuation })
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva designs', data })
})

const importDesign = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')

  const designId = String(req.body?.designId || '').trim()
  if (!designId) throw new AppError(400, 'designId is required')

  const result = await canvaService.importDesign(userId, {
    designId,
    designName: typeof req.body?.designName === 'string' ? req.body.designName : undefined,
    format: req.body?.format,
  })

  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Canva-Filename', result.filename)
  res.setHeader('X-Canva-Design-Id', designId)
  res.status(200).send(result.buffer)
})

/** Create a new Canva design (or open existing) + secure edit session, return edit URL. */
const createDesign = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId || !req.user) throw new AppError(403, 'Unauthorized')

  const profileId = String(req.body?.profileId || '').trim()
  const fieldKey = String(req.body?.fieldKey || req.body?.attachmentType || '').trim()
  const builderRoute = String(req.body?.builderRoute || '').trim()
  if (!profileId) throw new AppError(400, 'profileId is required')
  if (!fieldKey) throw new AppError(400, 'fieldKey is required')
  if (!builderRoute) throw new AppError(400, 'builderRoute is required')

  const data = await canvaService.createOrOpenEditSession(userId, req.user.role, {
    profileId,
    fieldKey,
    itemKey: typeof req.body?.itemKey === 'string' ? req.body.itemKey : null,
    attachmentType: typeof req.body?.attachmentType === 'string' ? req.body.attachmentType : fieldKey,
    mediaKind: req.body?.mediaKind === 'video' ? 'video' : req.body?.mediaKind === 'image' ? 'image' : null,
    width: typeof req.body?.width === 'number' ? req.body.width : null,
    height: typeof req.body?.height === 'number' ? req.body.height : null,
    exportFormat: req.body?.exportFormat,
    builderRoute,
    title: typeof req.body?.title === 'string' ? req.body.title : null,
    designId: typeof req.body?.designId === 'string' ? req.body.designId : null,
  })

  sendResponse(res, {
    success: true,
    statusCode: 201,
    message: 'Canva edit session created',
    data,
  })
})

/** Public Return Navigation callback from Canva (no auth cookie). */
const returnNav: RequestHandler = async (req, res, next) => {
  try {
    const correlationJwt =
      typeof req.query.correlation_jwt === 'string'
        ? req.query.correlation_jwt
        : typeof req.body?.correlation_jwt === 'string'
          ? req.body.correlation_jwt
          : undefined
    const redirectTo = await canvaService.handleReturnNavigation(correlationJwt)
    res.redirect(redirectTo)
  } catch (error) {
    next(error)
  }
}

const getImport = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId || !req.user) throw new AppError(403, 'Unauthorized')
  const sessionId = String(req.params.id || '').trim()
  if (!sessionId) throw new AppError(400, 'session id is required')
  const data = await canvaService.getImportSession(userId, req.user.role, sessionId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva import status', data })
})

const retryImport = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId || !req.user) throw new AppError(403, 'Unauthorized')
  const sessionId = String(req.params.id || '').trim()
  if (!sessionId) throw new AppError(400, 'session id is required')
  const data = await canvaService.retryImportSession(userId, req.user.role, sessionId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva import retry started', data })
})

const cancelImport = catchAsyncError(async (req, res) => {
  await requireCanvaAccess(req.user)
  const userId = req.user?.id
  if (!userId || !req.user) throw new AppError(403, 'Unauthorized')
  const sessionId = String(req.params.id || '').trim()
  if (!sessionId) throw new AppError(400, 'session id is required')
  const data = await canvaService.markReturnCanceled(userId, req.user.role, sessionId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva session canceled', data })
})

const canvaController = {
  status,
  authorizeUrl,
  callback,
  disconnect,
  designs,
  importDesign,
  createDesign,
  returnNav,
  getImport,
  retryImport,
  cancelImport,
}

export default canvaController
