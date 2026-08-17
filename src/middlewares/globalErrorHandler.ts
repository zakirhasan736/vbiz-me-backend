import { ErrorRequestHandler } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { MEDIA_UPLOAD_TOO_LARGE_MESSAGE } from '../constants/mediaUpload'
import AppError from '../error/AppError'
import handleZodError from '../error/zodError'
import { IErrorSources } from '../interfaces/error.interface'
import logger from '../utils/logger'
import { isPrismaColumnMismatch, isPrismaMissingTable, isPrismaTypeMismatch } from '../utils/prismaErrors'

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
  } else if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      statusCode = 413
      message = MEDIA_UPLOAD_TOO_LARGE_MESSAGE
      errorMessages = [{ path: 'file', message }]
    } else {
      statusCode = 400
      message = error.message
      errorMessages = [{ path: error.field || 'file', message }]
    }
  } else if (error instanceof ZodError) {
    const simpleErr = handleZodError(error)
    statusCode = simpleErr.statusCode
    message = simpleErr.message
    errorMessages = simpleErr.errorSources
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
  }

  logger.error(`${req.method} ${req.originalUrl} ${message}`, {
    statusCode,
  })

  return res.status(statusCode).json({
    success: false,
    statusCode,
    message,
    ...(code ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    errorMessages,
  })
}

export default globalErrorHandler
