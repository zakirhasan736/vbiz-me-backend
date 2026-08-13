import { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import AppError from '../error/AppError'
import handleZodError from '../error/zodError'
import { IErrorSources } from '../interfaces/error.interface'
import logger from '../utils/logger'

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

  logger.error(`${req.method} ${req.originalUrl} ${error.message || 'Error'}`, {
    statusCode: error.statusCode ?? 500,
  })

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
  } else if (error instanceof ZodError) {
    const simpleErr = handleZodError(error)
    statusCode = simpleErr.statusCode
    message = simpleErr.message
    errorMessages = simpleErr.errorSources
  }

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
