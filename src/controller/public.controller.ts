import publicCardService from '../services/publicCard.service'
import pushService from '../services/push.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendPublicResponse from '../utils/sendPublicResponse'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const getMyCard = catchAsyncError(async (req, res) => {
  const data = await publicCardService.getMyCardBySlug(param(req.params.slug))
  // profile_view is tracked client-side via POST /track-event with guestId (once per guest).
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
  const body = req.body as Record<string, unknown>
  const data = await publicCardService.saveGuestUser(
    {
      full_name: body.full_name != null ? String(body.full_name) : undefined,
      name: body.name != null ? String(body.name) : undefined,
      phone: body.phone != null ? String(body.phone) : undefined,
      email: body.email != null ? String(body.email) : undefined,
      profile_id: body.profile_id != null ? String(body.profile_id) : undefined,
      meta: body.meta,
    },
    {
      ip: req.ip,
      userAgent: req.get('user-agent') || undefined,
    }
  )
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
  const data = await publicCardService.saveContactCard(param(req.params.id), {
    ip: req.ip,
    userAgent: req.get('user-agent') || undefined,
  })
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
  const data = await pushService.subscriptionStatus(
    param(req.params.slug),
    req.query.endpoint ? String(req.query.endpoint) : undefined
  )
  sendPublicResponse(res, { success: true, data })
})

const pushSubscribe = catchAsyncError(async (req, res) => {
  const body = req.body as {
    profile_slug?: string
    profile_id?: string
    cardSlug?: string
    endpoint: string
    keys: { p256dh: string; auth: string }
    browser?: string
    platform?: string
  }
  const data = await pushService.subscribe({
    ...body,
    profile_slug: body.profile_slug || body.cardSlug,
  })
  sendPublicResponse(res, { success: true, data })
})

const pushPreferences = catchAsyncError(async (req, res) => {
  const body = req.body as {
    profile_slug?: string
    profile_id?: string
    cardSlug?: string
    endpoint: string
    preferences: Parameters<typeof pushService.updatePreferences>[0]['preferences']
  }
  const data = await pushService.updatePreferences({
    ...body,
    profile_slug: body.profile_slug || body.cardSlug,
  })
  sendPublicResponse(res, { success: true, data })
})

const pushUnsubscribe = catchAsyncError(async (req, res) => {
  const body = req.body as {
    profile_slug?: string
    profile_id?: string
    cardSlug?: string
    endpoint: string
  }
  const data = await pushService.unsubscribe({
    ...body,
    profile_slug: body.profile_slug || body.cardSlug,
  })
  sendPublicResponse(res, { success: true, data })
})

const pushTest = catchAsyncError(async (req, res) => {
  const body = req.body as {
    profile_slug?: string
    profile_id?: string
    cardSlug?: string
    endpoint: string
    title?: string
    body?: string
  }
  const data = await pushService.sendTest(body)
  sendPublicResponse(res, { success: true, data })
})

const trackEvent = catchAsyncError(async (req, res) => {
  const body = req.body as {
    eventType: 'social_click' | 'profile_view'
    guestId: string
    channel?: string
    profileId?: string
    profile_id?: string
    slug?: string
    profile_slug?: string
  }
  const data = await publicCardService.trackEvent(body, {
    ip: req.ip,
    userAgent: req.get('user-agent') || undefined,
  })
  sendPublicResponse(res, { success: true, data })
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
  trackEvent,
}

export default publicController
