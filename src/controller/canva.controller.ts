import type { RequestHandler } from 'express'
import AppError from '../error/AppError'
import * as canvaService from '../services/canva/canva.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const status = catchAsyncError(async (req, res) => {
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const data = await canvaService.getConnectionStatus(userId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva status', data })
})

const authorizeUrl = catchAsyncError(async (req, res) => {
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
  const userId = req.user?.id
  if (!userId) throw new AppError(403, 'Unauthorized')
  const query = typeof req.query.query === 'string' ? req.query.query : undefined
  const continuation = typeof req.query.continuation === 'string' ? req.query.continuation : undefined
  const data = await canvaService.listLibrary(userId, { query, continuation })
  sendResponse(res, { success: true, statusCode: 200, message: 'Canva designs', data })
})

const importDesign = catchAsyncError(async (req, res) => {
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

const canvaController = {
  status,
  authorizeUrl,
  callback,
  disconnect,
  designs,
  importDesign,
}

export default canvaController
