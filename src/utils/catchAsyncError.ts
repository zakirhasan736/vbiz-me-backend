import { NextFunction, Request, Response } from 'express'
import { UserRole } from '../constants/userRole'

export interface IUserInfoRequest extends Request {
  user?: {
    id: string
    email: string
    role: UserRole
    staffRole?: string | null
    allowedModules?: string[]
    accountStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED'
  }
}

type THandlerFunc = (req: IUserInfoRequest, res: Response, next: NextFunction) => void

const catchAsyncError = (fn: THandlerFunc) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as IUserInfoRequest, res, next)).catch((err) => next(err))
  }
}

export default catchAsyncError
