import fontsService from '../services/fonts.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const list = catchAsyncError(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const limit = req.query.limit
  const data = await fontsService.listFonts(q, limit)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Fonts fetched',
    data,
    totalDoc: data.length,
  })
})

const fontsController = {
  list,
}

export default fontsController
