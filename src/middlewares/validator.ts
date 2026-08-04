import { NextFunction, Request, Response } from 'express'
import { ZodTypeAny } from 'zod'

export const validSchema = (schema: ZodTypeAny) => {
  return async (req: Request, _: Response, next: NextFunction) => {
    const { success, error } = await schema.safeParseAsync(req.body)

    if (success) {
      next()
    } else {
      next(error)
    }
  }
}
