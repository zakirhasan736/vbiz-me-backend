import AppError from '../error/AppError'
import crmService from '../services/crm.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const dashboard = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await crmService.getCrmDashboard({
    id: req.user.id,
    role: req.user.role,
    allowedModules: req.user.allowedModules,
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'CRM dashboard fetched', data })
})

const crmController = {
  dashboard,
}

export default crmController
