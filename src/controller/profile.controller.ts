import AppError from '../error/AppError'
import profileService from '../services/profile.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const param = (value: string | string[]): string => (Array.isArray(value) ? value[0] : value)

const list = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.listForUser(req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Profiles fetched', data })
})

const getOne = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.getOwned(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Profile fetched', data })
})

const create = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.create(req.user.id, req.body)
  sendResponse(res, { success: true, statusCode: 201, message: 'Profile created', data })
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
    (item) => ({
      title: item.title,
      description: item.description,
      status: item.status ?? 1,
      url: item.url,
      imageUrl: item.imageUrl,
    })
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Portfolios updated', data })
})

const replaceSkills = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const items = (Array.isArray(req.body) ? req.body : req.body.items || []) as Array<Record<string, unknown>>
  const data = await profileService.replaceCollection(
    param(req.params.id),
    req.user.id,
    req.user.role,
    'skillTags',
    items,
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

const listPosts = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.listPosts(
    param(req.params.id),
    req.user.id,
    req.user.role,
    req.query.postType ? String(req.query.postType) : undefined
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Posts fetched', data })
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
  const data = await profileService.getDashboardStats(req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Dashboard stats', data })
})

const contacts = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await profileService.listContacts(
    req.user.id,
    req.user.role,
    req.query.profileId ? String(req.query.profileId) : undefined
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Contacts fetched', data })
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

const profileController = {
  list,
  getOne,
  create,
  update,
  remove,
  replaceEducation,
  replaceExperiences,
  replaceServices,
  replacePortfolios,
  replaceSkills,
  replaceSocialLinks,
  listPosts,
  createPost,
  updatePost,
  deletePost,
  dashboard,
  contacts,
  packages,
  subscriptions,
}

export default profileController
