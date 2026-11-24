import { ErrorRequestHandler, Request } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import {
  isMultipartTruncatedError,
  MEDIA_UPLOAD_INTERRUPTED_MESSAGE,
  MEDIA_UPLOAD_TOO_LARGE_MESSAGE,
} from '../constants/mediaUpload'
import AppError from '../error/AppError'
import handleZodError from '../error/zodError'
import { IErrorSources } from '../interfaces/error.interface'
import logger from '../utils/logger'
import { isPrismaColumnMismatch, isPrismaMissingTable, isPrismaTypeMismatch } from '../utils/prismaErrors'
import { captureSentryException } from '../utils/sentry'

/** Express / http-errors / body-parser attach status or statusCode (e.g. 400 "Bad Request"). */
function readHttpErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { status?: unknown; statusCode?: unknown }
  const raw =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined
  if (raw == null || !Number.isFinite(raw)) return undefined
  if (raw < 400 || raw > 599) return undefined
  return raw
}

const globalErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let message = error.message || 'Something went wrong!'
  let statusCode = 500
  let code: string | undefined
  let data: unknown
  let errorMessages: IErrorSources = [
    {
      path: '',
      message: 'Something went wrong',
    },
  ]

  if (error instanceof AppError) {
    statusCode = error.statusCode || 400
    message = error.message
    code = error.code
    data = error.data
    errorMessages = [
      {
        path: '',
        message: error.message,
      },
    ]
  } else if (error instanceof multer.MulterError || isMultipartTruncatedError(error)) {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      statusCode = 413
      message = MEDIA_UPLOAD_TOO_LARGE_MESSAGE
      errorMessages = [{ path: 'file', message }]
    } else if (isMultipartTruncatedError(error)) {
      statusCode = 400
      message = MEDIA_UPLOAD_INTERRUPTED_MESSAGE
      errorMessages = [{ path: 'file', message }]
    } else {
      statusCode = 400
      message = error.message
      errorMessages = [{ path: (error instanceof multer.MulterError && error.field) || 'file', message }]
    }
  } else if (
    error?.status === 413 ||
    error?.statusCode === 413 ||
    error?.type === 'entity.too.large' ||
    error?.name === 'PayloadTooLargeError'
  ) {
    statusCode = 413
    message = MEDIA_UPLOAD_TOO_LARGE_MESSAGE
    errorMessages = [{ path: 'file', message }]
  } else if (error instanceof ZodError) {
    const simpleErr = handleZodError(error)
    statusCode = simpleErr.statusCode
    message = simpleErr.message
    errorMessages = simpleErr.errorSources
  } else if (error instanceof URIError) {
    // Malformed percent-encoding in a GET path/query — client noise, not a server fault.
    statusCode = 400
    message = 'Bad Request'
    errorMessages = [{ path: '', message }]
  } else if (isPrismaMissingTable(error) || isPrismaColumnMismatch(error) || isPrismaTypeMismatch(error)) {
    logger.error(`${req.method} ${req.originalUrl} schema mismatch`, { error: error.message })
    if (req.method === 'GET') {
      return res.status(200).json({
        success: true,
        statusCode: 200,
        message: 'OK',
        data: null,
      })
    }
    statusCode = 409
    message = 'Database schema is missing a table or column this API expects.'
    errorMessages = [{ path: '', message }]
  } else {
    const httpStatus = readHttpErrorStatus(error)
    if (httpStatus) {
      // body-parser / http-errors (e.g. status 400, message "Bad Request") must not become Sentry 500s.
      statusCode = httpStatus
      message = error.message || message
      errorMessages = [{ path: '', message }]
    }
  }

  const requestId =
    (req as Request & { requestId?: string }).requestId ||
    (typeof res.getHeader('x-vbiz-request-id') === 'string' ? String(res.getHeader('x-vbiz-request-id')) : undefined)

  const logPayload = {
    statusCode,
    requestId,
    code,
    userId: req.user?.id,
    profileId: req.params?.id || req.params?.profileId || req.body?.profileId,
    ownerUserId: req.body?.ownerUserId,
  }
  const logLine = `${req.method} ${req.originalUrl} ${message}`
  // Expected unauthenticated / expired-session noise — browsers with stale tabs keep polling.
  const isExpectedAuthNoise =
    (statusCode === 403 && message === 'Unauthorized') ||
    (statusCode === 401 &&
      (message === 'Refresh token is missing' ||
        message === 'Refresh token is invalid or expired' ||
        message === 'Refresh session was not found'))

  if (statusCode >= 500) {
    logger.error(logLine, logPayload)
    captureSentryException(message, {
      method: req.method,
      url: req.originalUrl,
      statusCode,
      requestId,
    })
  } else if (!isExpectedAuthNoise) {
    logger.warn(logLine, logPayload)
  }

  return res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    requestId,
    ...(code ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    errorMessages,
  })
}

export default globalErrorHandler
