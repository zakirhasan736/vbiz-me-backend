import AppError from '../error/AppError'
import cardChangeHistoryService from '../services/cardChangeHistory.service'
import catchAsyncError from '../utils/catchAsyncError'
import { listMeta } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const skip = Number(req.query.skip) || 0
  const limit = Number(req.query.limit) || 50
  const data = await cardChangeHistoryService.list(param(req.params.id), req.user.id, req.user.role, skip, limit)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Card change history fetched',
    data,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const restore = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await cardChangeHistoryService.restore(
    param(req.params.id),
    param(req.params.historyId),
    req.user.id,
    req.user.role
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Change restored', data })
})

const cardChangeHistoryController = { list, restore }

export default cardChangeHistoryController
