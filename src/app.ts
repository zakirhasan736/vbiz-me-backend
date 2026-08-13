import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { Application, NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import config from './configs/config'
import './configs/passport'
import globalErrorHandler from './middlewares/globalErrorHandler'
import router from './router/index'
import sendResponse from './utils/sendResponse'

const app: Application = express()

app.use(helmet())
app.use(cookieParser())

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.ALLOWED_CORS_ORIGINS.includes(origin)) {
        callback(null, true)
        return
      }

      callback(null, false)
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    credentials: true,
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
