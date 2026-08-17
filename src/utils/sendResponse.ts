import { Response } from 'express'

type IResponse<T> = {
  statusCode?: number
  success: boolean
  message: string
  data: T
  error?: unknown
  totalDoc?: number
  meta?: {
    skip?: number
    limit?: number
    page?: number
    total?: number
    hasMore?: boolean
  }
}

const sendResponse = <T>(res: Response, data: IResponse<T>) => {
  res.status(data.statusCode || 200).json({
    success: data.success,
    statusCode: data.statusCode || 200,
    message: data.message,
    data: data.data,
    totalDoc: data.totalDoc ?? data.meta?.total,
    meta: data.meta,
  })
}

export default sendResponse
