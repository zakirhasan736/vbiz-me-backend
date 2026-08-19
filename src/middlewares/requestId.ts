import { NextFunction, Request, Response } from 'express'
import { newRequestId } from '../services/ai/builderErrors'

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = String(req.headers['x-vbiz-request-id'] || req.headers['x-request-id'] || '')
  const requestId = newRequestId(incoming)
  ;(req as Request & { requestId: string }).requestId = requestId
  res.setHeader('x-vbiz-request-id', requestId)
  next()
}

export function getRequestId(req: Request): string {
  return (req as Request & { requestId?: string }).requestId || newRequestId()
}
