import AppError from '../error/AppError'
import customTabService from '../services/customTab.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const param = (value: string | string[] | undefined) => String(Array.isArray(value) ? value[0] : value || '')
const auth = (req: { user?: { id: string; role: string } }) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  return req.user
}
const body = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

const listTabs = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.listTabs(param(req.params.id), user.id, user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tabs fetched', data })
})
const createTab = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.createTab(param(req.params.id), user.id, user.role, body(req.body))
  sendResponse(res, { success: true, statusCode: 201, message: 'Custom tab created', data })
})
const updateTab = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.updateTab(
    param(req.params.id),
    param(req.params.tabId),
    user.id,
    user.role,
    body(req.body)
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tab updated', data })
})
const deleteTab = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.deleteTab(param(req.params.id), param(req.params.tabId), user.id, user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tab deleted', data })
})
const listItems = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.listItems(param(req.params.id), param(req.params.tabId), user.id, user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tab items fetched', data })
})
const createItem = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.createItem(
    param(req.params.id),
    param(req.params.tabId),
    user.id,
    user.role,
    body(req.body)
  )
  sendResponse(res, { success: true, statusCode: 201, message: 'Custom tab item created', data })
})
const updateItem = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.updateItem(
    param(req.params.id),
    param(req.params.tabId),
    param(req.params.itemId),
    user.id,
    user.role,
    body(req.body)
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tab item updated', data })
})
const deleteItem = catchAsyncError(async (req, res) => {
  const user = auth(req)
  const data = await customTabService.deleteItem(
    param(req.params.id),
    param(req.params.tabId),
    param(req.params.itemId),
    user.id,
    user.role
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Custom tab item deleted', data })
})

export default { listTabs, createTab, updateTab, deleteTab, listItems, createItem, updateItem, deleteItem }
