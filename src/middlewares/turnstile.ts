import { Request, Response } from 'express'
import config from '../configs/config'
import catchAsyncError from '../utils/catchAsyncError'
import { verifyTurnstileToken } from '../utils/turnstile'

const verifyTurnstile = catchAsyncError(async (req: Request, _res: Response, next) => {
  await verifyTurnstileToken(req.body?.turnstileToken, {
    enabled: config.TURNSTILE.ENABLED,
    secretKey: config.TURNSTILE.SECRET_KEY,
    expectedHostname: config.TURNSTILE.EXPECTED_HOSTNAME,
    remoteIp: req.ip,
  })

  next()
})

export default verifyTurnstile
