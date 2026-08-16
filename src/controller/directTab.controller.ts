import AppError from '../error/AppError'
import directTabService from '../services/directTab.service'
import catchAsyncError from '../utils/catchAsyncError'
import sendResponse from '../utils/sendResponse'

const param = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v || '')

const listBlogs = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await directTabService.listBlogs(param(req.params.id), req.user.id, req.user.role)
  sendResponse(res, { success: true, statusCode: 200, message: 'Blogs fetched', data })
})

const createBlog = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = (req.body || {}) as Record<string, unknown>
  const data = await directTabService.createBlog(param(req.params.id), req.user.id, req.user.role, {
    title: body.title == null ? null : String(body.title),
    description: body.description == null ? null : String(body.description),
    category:
      body.category == null && !(body.metas as { category?: string } | undefined)?.category
        ? null
        : String(body.category ?? (body.metas as { category?: string })?.category ?? ''),
    date:
      body.date == null && !(body.metas as { date?: string } | undefined)?.date
        ? null
        : String(body.date ?? (body.metas as { date?: string })?.date ?? ''),
    url: body.url == null ? null : String(body.url),
    featuredImage: body.featuredImage == null ? null : String(body.featuredImage),
    status: body.status == null ? null : String(body.status),
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : null,
  })
  sendResponse(res, { success: true, statusCode: 201, message: 'Blog created', data })
})

const updateBlog = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = (req.body || {}) as Record<string, unknown>
  const metas = (body.metas || {}) as Record<string, string>
  const data = await directTabService.updateBlog(
    param(req.params.id),
    param(req.params.blogId),
    req.user.id,
    req.user.role,
    {
      title: body.title === undefined ? undefined : body.title == null ? null : String(body.title),
      description:
        body.description === undefined ? undefined : body.description == null ? null : String(body.description),
      category:
        body.category !== undefined
          ? body.category == null
            ? null
            : String(body.category)
          : metas.category !== undefined
            ? String(metas.category)
            : undefined,
      date:
        body.date !== undefined
          ? body.date == null
            ? null
            : String(body.date)
          : metas.date !== undefined
            ? String(metas.date)
            : undefined,
      url: body.url === undefined ? undefined : body.url == null ? null : String(body.url),
      featuredImage:
        body.featuredImage === undefined ? undefined : body.featuredImage == null ? null : String(body.featuredImage),
      status: body.status === undefined ? undefined : body.status == null ? null : String(body.status),
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
    }
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Blog updated', data })
})

const deleteBlog = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await directTabService.deleteBlog(
    param(req.params.id),
    param(req.params.blogId),
    req.user.id,
    req.user.role
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Blog deleted', data })
})

const listTabItems = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await directTabService.listTabItems(
    param(req.params.id),
    param(req.params.tabKey),
    req.user.id,
    req.user.role
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Tab items fetched', data })
})

const createTabItem = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = (req.body || {}) as Record<string, unknown>
  const data = await directTabService.createTabItem(
    param(req.params.id),
    param(req.params.tabKey),
    req.user.id,
    req.user.role,
    {
      title: body.title == null ? null : String(body.title),
      description: body.description == null ? null : String(body.description),
      url: body.url == null ? null : String(body.url),
      featuredImage: body.featuredImage == null ? null : String(body.featuredImage),
      status: body.status == null ? null : String(body.status),
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : null,
      metas:
        body.metas && typeof body.metas === 'object' && !Array.isArray(body.metas)
          ? (body.metas as Record<string, unknown>)
          : null,
    }
  )
  sendResponse(res, { success: true, statusCode: 201, message: 'Tab item created', data })
})

const updateTabItem = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const body = (req.body || {}) as Record<string, unknown>
  const data = await directTabService.updateTabItem(
    param(req.params.id),
    param(req.params.tabKey),
    param(req.params.itemId),
    req.user.id,
    req.user.role,
    {
      title: body.title === undefined ? undefined : body.title == null ? null : String(body.title),
      description:
        body.description === undefined ? undefined : body.description == null ? null : String(body.description),
      url: body.url === undefined ? undefined : body.url == null ? null : String(body.url),
      featuredImage:
        body.featuredImage === undefined ? undefined : body.featuredImage == null ? null : String(body.featuredImage),
      status: body.status === undefined ? undefined : body.status == null ? null : String(body.status),
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
      metas:
        body.metas === undefined
          ? undefined
          : body.metas && typeof body.metas === 'object' && !Array.isArray(body.metas)
            ? (body.metas as Record<string, unknown>)
            : null,
    }
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Tab item updated', data })
})

const deleteTabItem = catchAsyncError(async (req, res) => {
  if (!req.user) throw new AppError(403, 'Unauthorized')
  const data = await directTabService.deleteTabItem(
    param(req.params.id),
    param(req.params.tabKey),
    param(req.params.itemId),
    req.user.id,
    req.user.role
  )
  sendResponse(res, { success: true, statusCode: 200, message: 'Tab item deleted', data })
})

const directTabController = {
  listBlogs,
  createBlog,
  updateBlog,
  deleteBlog,
  listTabItems,
  createTabItem,
  updateTabItem,
  deleteTabItem,
}

export default directTabController
