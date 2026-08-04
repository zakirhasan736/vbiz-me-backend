import { Request, Response, Router } from 'express'
import sendResponse from '../utils/sendResponse'

const router = Router()

router.get('/', (_req: Request, res: Response) => {
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'OK',
    data: {
      status: 'healthy',
      uptime: process.uptime(),
    },
  })
})

export default router
