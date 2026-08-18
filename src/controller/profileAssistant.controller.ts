import { filesFromMulter } from '../services/ai/extractDocumentText'
import * as assistantTabFillService from '../services/assistantTabFill.service'
import * as profileAssistantService from '../services/profileAssistant.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const getConfig = catchAsyncError(async (req, res) => {
  const data = await profileAssistantService.getConfig(param(req.params.profileId))
  sendResponse(res, { success: true, statusCode: 200, message: 'Assistant config', data })
})

const updateConfig = catchAsyncError(async (req, res) => {
  const data = await profileAssistantService.updateConfig(param(req.params.profileId), req.body || {})
  sendResponse(res, { success: true, statusCode: 200, message: 'Assistant config updated', data })
})

const listKnowledge = catchAsyncError(async (req, res) => {
  const data = await profileAssistantService.listKnowledge(param(req.params.profileId))
  sendResponse(res, { success: true, statusCode: 200, message: 'Assistant knowledge', data })
})

const extractKnowledge = catchAsyncError(async (req, res) => {
  const data = await profileAssistantService.extractAndStoreKnowledge({
    profileId: param(req.params.profileId),
    businessText: String(req.body?.businessText || ''),
    about: String(req.body?.about || ''),
    tabScope: String(req.body?.tabScope || ''),
    files: filesFromMulter(req.files as Express.Multer.File[] | undefined),
  })
  sendResponse(res, { success: true, statusCode: 201, message: 'Assistant knowledge trained', data })
})

const deleteKnowledge = catchAsyncError(async (req, res) => {
  const data = await profileAssistantService.deleteKnowledge(param(req.params.profileId), param(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Knowledge source deleted', data })
})

const fillSection = catchAsyncError(async (req, res) => {
  const data = await assistantTabFillService.fillProfileSection({
    profileId: param(req.params.profileId),
    scope: req.body?.section ?? req.body?.tabScope,
    text: String(req.body?.text || req.body?.businessText || ''),
    files: filesFromMulter(req.files as Express.Multer.File[] | undefined),
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'Section draft generated for review', data })
})

export default {
  getConfig,
  updateConfig,
  listKnowledge,
  extractKnowledge,
  deleteKnowledge,
  fillSection,
}
