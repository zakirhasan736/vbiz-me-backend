import AppError from '../error/AppError'
import birthdayWishService from '../services/birthdayWish.service'
import { assertModule } from '../utils/adminAccess'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const run = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  assertModule(req.user.role, req.user.allowedModules, 'announcements')

  const data = await birthdayWishService.runDailyBirthdayWishes()
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Birthday wish job completed',
    data,
  })
})

const birthdayWishController = {
  run,
}

export default birthdayWishController
