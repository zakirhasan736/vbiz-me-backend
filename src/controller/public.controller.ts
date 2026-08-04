import publicCardService from '../services/publicCard.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendPublicResponse from '../utils/sendPublicResponse'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const getMyCard = catchAsyncError(async (req, res) => {
  const data = await publicCardService.getMyCardBySlug(param(req.params.slug))
  await publicCardService.logEvent(
    String(data.profile.id),
    'profile_view',
    { slug: param(req.params.slug) },
    {
      ip: req.ip,
      userAgent: req.get('user-agent') || undefined,
    }
  )
  sendPublicResponse(res, { success: true, data })
})

const getPostTypes = catchAsyncError(async (req, res) => {
  const profileId = String(req.query.profile_id || '')
  if (!profileId) {
    return sendPublicResponse(res, { success: false, data: null, error: 'profile_id is required' }, 400)
  }
  const data = await publicCardService.getPostTypesForProfile(profileId)
  sendPublicResponse(res, { success: true, data })
})

const getSettings = catchAsyncError(async (req, res) => {
  const data = await publicCardService.getProfileSettings(param(req.params.id))
  sendPublicResponse(res, { success: true, data })
})

const getAiData = catchAsyncError(async (req, res) => {
  const data = await publicCardService.getProfileAiData(param(req.params.id))
  res.status(200).json(data)
})

const getDynamicSection = catchAsyncError(async (req, res) => {
  const profileId = String(req.query.profile_id || '')
  if (!profileId) {
    return sendPublicResponse(res, { success: false, data: null, error: 'profile_id is required' }, 400)
  }
  const data = await publicCardService.getDynamicSection(param(req.params.name), profileId)
  sendPublicResponse(res, { success: true, data })
})

const getPublicCards = catchAsyncError(async (req, res) => {
  const payload = await publicCardService.getPublicCards({
    page: Number(req.query.page) || undefined,
    per_page: Number(req.query.per_page) || undefined,
    state_id: req.query.state_id ? String(req.query.state_id) : undefined,
    city_id: req.query.city_id ? String(req.query.city_id) : undefined,
    profession_id: req.query.profession_id ? String(req.query.profession_id) : undefined,
    service: req.query.service ? String(req.query.service) : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  })
  res.status(200).json(payload)
})

const saveGuestUser = catchAsyncError(async (req, res) => {
  const body = req.body as Record<string, string>
  const data = await publicCardService.saveGuestUser({
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email,
    profile_id: body.profile_id,
  })
  sendPublicResponse(res, { success: true, data })
})

const saveNote = catchAsyncError(async (req, res) => {
  const profileId = String(req.query.profile_id || req.body.profile_id || '')
  const content = String(req.query.content || req.body.content || '')
  if (!profileId || !content) {
    return sendPublicResponse(res, { success: false, data: null, error: 'profile_id and content are required' }, 400)
  }
  const data = await publicCardService.saveNote(profileId, content)
  sendPublicResponse(res, { success: true, data })
})

const saveContact = catchAsyncError(async (req, res) => {
  const data = await publicCardService.saveContactCard(param(req.params.id))
  sendPublicResponse(res, { success: true, data })
})

const googleWallet = catchAsyncError(async (_req, res) => {
  sendPublicResponse(
    res,
    { success: false, data: null, error: 'Google Wallet is not configured on the new backend yet' },
    501
  )
})

const pushStatus = catchAsyncError(async (req, res) => {
  const data = await publicCardService.pushSubscriptionStatus(
    param(req.params.slug),
    req.query.endpoint ? String(req.query.endpoint) : undefined
  )
  sendPublicResponse(res, { success: true, data })
})

const pushSubscribe = catchAsyncError(async (req, res) => {
  const data = await publicCardService.pushSubscribe(req.body)
  sendPublicResponse(res, { success: true, data })
})

const pushPreferences = catchAsyncError(async (req, res) => {
  sendPublicResponse(res, { success: true, data: req.body })
})

const pushUnsubscribe = catchAsyncError(async (_req, res) => {
  sendPublicResponse(res, { success: true, data: { unsubscribed: true } })
})

const pushTest = catchAsyncError(async (_req, res) => {
  sendPublicResponse(res, { success: true, data: { sent: false, message: 'Push test stub' } })
})

const publicController = {
  getMyCard,
  getPostTypes,
  getSettings,
  getAiData,
  getDynamicSection,
  getPublicCards,
  saveGuestUser,
  saveNote,
  saveContact,
  googleWallet,
  pushStatus,
  pushSubscribe,
  pushPreferences,
  pushUnsubscribe,
  pushTest,
}

export default publicController
