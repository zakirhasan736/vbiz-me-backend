import AppError from '../error/AppError'
import profileService from '../services/profile.service'
import { buildOverviewPdf } from '../utils/buildOverviewPdf'
import catchAsyncError from '../utils/catchAsyncError'
import liveClicksHub from '../utils/liveClicksHub'
import { listMeta, parseListQuery } from '../utils/pagination'
import sendResponse from '../utils/sendResponse'
import ProfileZodSchema from '../zodValidation/profile.zod'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = ProfileZodSchema.listProfilesQuery.parse(req.query)
  const data = await profileService.listProfilesPage(req.user.id, req.user.role, query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Profiles fetched',
    data,
    totalDoc: data.total,
    meta: listMeta(data.skip ?? query.skip, data.limit ?? query.limit, data.total),
  })
})

const getOne = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.getOwned(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Profile fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = ProfileZodSchema.createProfileBody.parse(req.body) as {
    name: string
    ownerUserId?: string
    [key: string]: unknown
  }
  const data = await profileService.create(req.user.id, req.user.role, body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Profile created', data })
})

const duplicate = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.duplicate(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 201, message: 'Profile duplicated as draft', data })
})

const update = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.update(param(req.params.id), req.user.id, req.user.role, req.body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Profile updated', data })
})

const remove = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.remove(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Profile deleted', data })
})

const replaceEducation = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'education',
    items,
    (item) => ({
      institute: item.institute,
      degree: item.degree,
      fromDate: item.fromDate ? new Date(String(item.fromDate)) : null,
      toDate: item.toDate ? new Date(String(item.toDate)) : null,
      tillNow: Boolean(item.tillNow),
      description: item.description,
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Education updated', data })
})

const replaceExperiences = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'experiences',
    items,
    (item) => ({
      company: item.company,
      jobTitle: item.jobTitle,
      description: item.description,
      fromDate: item.fromDate ? new Date(String(item.fromDate)) : null,
      toDate: item.toDate ? new Date(String(item.toDate)) : null,
      tillNow: Boolean(item.tillNow),
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Experiences updated', data })
})

const replaceServices = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'services',
    items,
    (item) => ({
      title: item.title,
      description: item.description,
      status: item.status ?? 1,
      reviewUrl: item.reviewUrl,
      imageUrl: item.imageUrl,
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Services updated', data })
})

const replacePortfolios = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'portfolios',
    items,
    (item) => {
      const attachments =
        item.attachments && typeof item.attachments === 'object'
          ? (item.attachments as { url?: unknown; name?: unknown })
          : null
      const attachmentUrl =
        (typeof item.attachmentUrl === 'string' && item.attachmentUrl) ||
        (typeof attachments?.url === 'string' && attachments.url) ||
        null
      const attachmentName =
        (typeof item.attachmentName === 'string' && item.attachmentName) ||
        (typeof attachments?.name === 'string' && attachments.name) ||
        null
      return {
        title: item.title,
        description: item.description,
        status: String(item.status ?? '1'),
        url: item.url,
        featuredImage: typeof item.featuredImage === 'string' ? item.featuredImage : item.imageUrl,
        attachmentUrl,
        attachmentName,
      }
    }
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Portfolios updated', data })
})

const replaceReviews = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'reviews',
    items,
    (item) => {
      const rawRating = typeof item.rating === 'number' ? item.rating : Number(item.rating)
      const rating = Number.isFinite(rawRating) ? Math.min(5, Math.max(1, Math.round(rawRating))) : 5
      return {
        author: item.author,
        text: item.text,
        rating,
        status: item.status ?? 1,
      }
    }
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Reviews updated', data })
})

const replaceSkills = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const normalized = items
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.trim() : String(item.name ?? '').trim(),
      level:
        typeof item.level === 'string' && item.level.trim()
          ? item.level.trim()
          : item.level == null || item.level === ''
            ? null
            : String(item.level).trim() || null,
    }))
    .filter((item) => Boolean(item.name))
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'skillTags',
    normalized,
    (item) => ({
      name: item.name,
      level: item.level,
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Skills updated', data })
})

const replaceSocialLinks = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'socialLinks',
    items,
    (item) => ({
      name: item.name,
      url: item.url,
      icon: item.icon,
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Social links updated', data })
})

const getAboutMe = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.getAboutMe(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'About Me fetched', data })
})

const upsertAboutMe = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = ProfileZodSchema.upsertAboutMeBody.parse(req.body || {})
  const data = await profileService.upsertAboutMe(param(req.params.id), req.user.id, req.user.role, {
    title: body.title == null ? null : String(body.title),
    description: body.description == null ? null : String(body.description),
    featuredMediaUrl:
      body.featuredMediaUrl == null && body.featured_image == null
        ? null
        : String(body.featuredMediaUrl ?? body.featured_image ?? ''),
    status: body.status == null ? null : String(body.status),
  })
  sendResponse(res, { success: true, statusCode: 200, message: 'About Me updated', data })
})

const deleteAboutMe = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.deleteAboutMe(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'About Me deleted', data })
})

const listPosts = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { skip, limit } = parseListQuery(req.query)
  const result = await profileService.listPosts(
    param(req.params.id),
    req.user.id,
    req.user.role,
    req.query.postType ? String(req.query.postType) : undefined,
    skip,
    limit
  )
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Posts fetched',
    data: result.items,
    totalDoc: result.total,
    meta: listMeta(result.skip, result.limit, result.total),
  })
})

const createPost = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.createPost(param(req.params.id), req.user.id, req.user.role, req.body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Post created', data })
})

const updatePost = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.updatePost(param(req.params.postId), req.user.id, req.user.role, req.body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Post updated', data })
})

const deletePost = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.deletePost(param(req.params.postId), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Post deleted', data })
})

const dashboard = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { period, scope } = ProfileZodSchema.dashboardPeriodQuery.parse(req.query)
  const data = await profileService.getDashboardStats(req.user.id, req.user.role, period, scope)
  sendResponse(res, { success: true, statusCode: 200, message: 'Dashboard stats', data })
})

const dashboardSummary = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { period, scope } = ProfileZodSchema.dashboardPeriodQuery.parse(req.query)
  const data = await profileService.getDashboardSummary(req.user.id, req.user.role, period, scope)
  res.set('Cache-Control', 'private, max-age=8, stale-while-revalidate=20')
  sendResponse(res, { success: true, statusCode: 200, message: 'Dashboard summary', data })
})

const recentEngagement = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = ProfileZodSchema.recentEngagementQuery.parse(req.query)
  const data = await profileService.listRecentEngagement(req.user.id, req.user.role, query)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Recent engagement fetched',
    data,
    totalDoc: data.total,
    meta: listMeta(data.skip, data.limit, data.total),
  })
})

const checkSlug = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const query = ProfileZodSchema.checkSlugQuery.parse(req.query)
  const data = await profileService.checkSlugAvailability(query.slug, query.excludeId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Slug availability', data })
})

const contacts = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { skip, limit } = parseListQuery(req.query, { limit: 100, max: 200 })
  const data = await profileService.listContacts(
    req.user.id,
    req.user.role,
    req.query.profileId ? String(req.query.profileId) : undefined,
    skip + limit
  )
  const page = data.slice(skip, skip + limit)
  sendResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Contacts fetched',
    data: page,
    totalDoc: data.length,
    meta: listMeta(skip, limit, data.length),
  })
})

const patchContact = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = ProfileZodSchema.patchContactBody.parse(req.body)
  const data = await profileService.patchContact(req.user.id, req.user.role, String(req.params.id), body)
  sendResponse(res, { success: true, statusCode: 200, message: 'Contact updated', data })
})

const exportContacts = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const csv = await profileService.exportContactsCsv(
    req.user.id,
    req.user.role,
    req.query.profileId ? String(req.query.profileId) : undefined
  )
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="corporate-leads_${stamp}.csv"`)
  res.status(200).send(csv)
})

const listTeamNotices = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.listTeamNotices(req.user.id)
  sendResponse(res, { success: true, statusCode: 200, message: 'Team notices fetched', data })
})

const createTeamNotice = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = ProfileZodSchema.createTeamNoticeBody.parse(req.body)
  const data = await profileService.createTeamNotice(req.user.id, req.user.role, body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Team notice created', data })
})

const deleteTeamNotice = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.deleteTeamNotice(req.user.id, req.user.role, String(req.params.id))
  sendResponse(res, { success: true, statusCode: 200, message: 'Team notice deleted', data })
})

const packages = catchAsyncError(async (_req, res) => {
  const data = await profileService.listPackages()
  sendResponse(res, { success: true, statusCode: 200, message: 'Packages fetched', data })
})

const subscriptions = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.listSubscriptions(req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Subscriptions fetched', data })
})

const exportDashboard = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { period } = ProfileZodSchema.dashboardPeriodQuery.parse(req.query)
  const stats = await profileService.getDashboardStats(req.user.id, req.user.role, period)
  const pdf = await buildOverviewPdf(stats, period)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace(/Z$/, '')
  const periodLabel = period === 'all' ? 'all-time' : `last-${period}-days`
  const filename = `overview-${periodLabel}_${stamp}.pdf`
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', String(pdf.length))
  res.status(200).send(pdf)
})

const weeklyEngagement = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { scope, profileId } = ProfileZodSchema.profileScopeQuery.parse(req.query)
  const data = await profileService.getWeeklyEngagement(req.user.id, req.user.role, scope, profileId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Weekly engagement', data })
})

const consolidatedEngagement = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { scope } = ProfileZodSchema.profileScopeQuery.parse(req.query)
  const data = await profileService.getConsolidatedEngagement(req.user.id, req.user.role, scope)
  sendResponse(res, { success: true, statusCode: 200, message: 'Consolidated engagement', data })
})

const liveClicks = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const userId = req.user.id
  const role = req.user.role

  const cleanup = liveClicksHub.subscribe(userId, res)
  try {
    const clicks = await profileService.getLiveSocialClicks(userId, role)
    liveClicksHub.publishSnapshot(userId, clicks)
  } catch (err) {
    cleanup()
    throw err
  }
  // Connection stays open until client disconnects; do not call res.end().
})

const socialClicks = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { profileId } = ProfileZodSchema.profileScopeQuery.parse(req.query)
  const data = await profileService.getLiveSocialClicks(req.user.id, req.user.role, profileId)
  sendResponse(res, { success: true, statusCode: 200, message: 'Social clicks', data })
})

const socialClicksByCard = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const { scope } = ProfileZodSchema.profileScopeQuery.parse(req.query)
  const data = await profileService.getSocialClicksByCard(req.user.id, req.user.role, scope)
  sendResponse(res, { success: true, statusCode: 200, message: 'Social clicks by card', data })
})

const profileController = {
  list,
  getOne,
  create,
  duplicate,
  update,
  remove,
  replaceEducation,
  replaceExperiences,
  replaceServices,
  replacePortfolios,
  replaceReviews,
  replaceSkills,
  replaceSocialLinks,
  getAboutMe,
  upsertAboutMe,
  deleteAboutMe,
  listPosts,
  createPost,
  updatePost,
  deletePost,
  dashboard,
  dashboardSummary,
  recentEngagement,
  weeklyEngagement,
  consolidatedEngagement,
  liveClicks,
  socialClicks,
  socialClicksByCard,
  checkSlug,
  exportDashboard,
  contacts,
  patchContact,
  exportContacts,
  listTeamNotices,
  createTeamNotice,
  deleteTeamNotice,
  packages,
  subscriptions,
}

export default profileController
