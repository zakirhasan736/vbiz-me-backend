import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Application, NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import config from './configs/config'
import './configs/passport'
import globalErrorHandler from './middlewares/globalErrorHandler'
import { requestIdMiddleware } from './middlewares/requestId'
import router from './router/index'
import stripeService from './services/stripe.service'
import catchAsyncError from './utils/catchAsyncError'
import logger from './utils/logger'
import sendResponse from './utils/sendResponse'

const app: Application = express()

// Nginx / TLS terminator sets X-Forwarded-For. Required by express-rate-limit.
app.set('trust proxy', 1)

app.use(helmet())
app.use(compression())
app.use(cookieParser())
app.use(requestIdMiddleware)
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = performance.now()
  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt)
    if (durationMs > 500) {
      logger.warn('Slow request', { method: req.method, path: req.path, durationMs })
    }
  })
  next()
})

app.use(
  cors({
    origin(origin, callback) {
      const normalized = origin?.replace(/\/$/, '') || ''
      if (!origin || config.ALLOWED_CORS_ORIGINS.includes(normalized)) {
        callback(null, true)
        return
      }

      callback(null, false)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    exposedHeaders: ['x-vbiz-request-id'],
    credentials: true,
  })
)

app.post(
  '/api/v1/billing/webhook',
  express.raw({ type: 'application/json' }),
  catchAsyncError(async (req, res) => {
    const signature = req.headers['stripe-signature']
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''))
    const data = await stripeService.handleWebhook(raw, Array.isArray(signature) ? signature[0] : signature)
    sendResponse(res, { success: true, statusCode: 200, message: 'Webhook received', data })
  })
)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ limit: '10mb', extended: true }))

app.use('/api/v1', router)

app.get('/', (_req: Request, res: Response) => {
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Welcome',
    data: null,
  })
})

// Exercises the production error pipeline without exposing a public route.
if (process.env.NODE_ENV === 'test') {
  app.get('/__test__/error', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('Forced test failure'))
  })
}

app.use((req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    return
  }

  sendResponse(res, {
    success: false,
    statusCode: 404,
    message: 'Not Found',
    data: { path: req.originalUrl },
  })
})

app.use(globalErrorHandler)

export default app
