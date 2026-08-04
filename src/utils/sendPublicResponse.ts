import { Response } from 'express'

type PublicResponse<T> = {
  success: boolean
  data: T
  error?: string
  [key: string]: unknown
}

/** Laravel-compatible public API envelope: `{ success, data, ... }`. */
const sendPublicResponse = <T>(res: Response, payload: PublicResponse<T>, statusCode = 200) => {
  res.status(statusCode).json(payload)
}

export default sendPublicResponse
