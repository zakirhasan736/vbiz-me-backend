import { Router } from 'express'
import customTabController from '../controller/customTab.controller'
import directTabController from '../controller/directTab.controller'
import profileController from '../controller/profile.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)
router.use(authMiddleware.requireNotSuspended)

router.get('/dashboard/stats', profileController.dashboard)
router.get('/dashboard/summary', profileController.dashboardSummary)
router.get('/dashboard/engagement', profileController.recentEngagement)
router.get('/dashboard/weekly-engagement', profileController.weeklyEngagement)
router.get('/dashboard/consolidated-engagement', profileController.consolidatedEngagement)
router.get('/dashboard/social-clicks', profileController.socialClicks)
router.get('/dashboard/social-clicks-by-card', profileController.socialClicksByCard)
router.get('/dashboard/live-clicks', profileController.liveClicks)
router.get('/dashboard/export', profileController.exportDashboard)
router.get('/contacts/export', profileController.exportContacts)
router.patch('/contacts/:id', authMiddleware.requireVcardMutable, profileController.patchContact)
router.get('/contacts', profileController.contacts)
router.get('/team-notices', profileController.listTeamNotices)
router.post('/team-notices', authMiddleware.requireVcardMutable, profileController.createTeamNotice)
router.delete('/team-notices/:id', authMiddleware.requireVcardMutable, profileController.deleteTeamNotice)
router.get('/packages', profileController.packages)
router.get('/subscriptions', profileController.subscriptions)

router.get('/', profileController.list)
router.post('/', authMiddleware.requireVcardMutable, profileController.create)
router.get('/check-slug', profileController.checkSlug)
router.get('/:id', profileController.getOne)
router.patch('/:id', authMiddleware.requireVcardMutable, profileController.update)
router.delete('/:id', authMiddleware.requireVcardMutable, profileController.remove)

router.put('/:id/education', authMiddleware.requireVcardMutable, profileController.replaceEducation)
router.put('/:id/experiences', authMiddleware.requireVcardMutable, profileController.replaceExperiences)
router.put('/:id/services', authMiddleware.requireVcardMutable, profileController.replaceServices)
router.put('/:id/portfolios', authMiddleware.requireVcardMutable, profileController.replacePortfolios)
router.put('/:id/reviews', authMiddleware.requireVcardMutable, profileController.replaceReviews)
router.put('/:id/skills', authMiddleware.requireVcardMutable, profileController.replaceSkills)
router.put('/:id/social-links', authMiddleware.requireVcardMutable, profileController.replaceSocialLinks)
router.get('/:id/about-me', profileController.getAboutMe)
router.put('/:id/about-me', authMiddleware.requireVcardMutable, profileController.upsertAboutMe)
router.delete('/:id/about-me', authMiddleware.requireVcardMutable, profileController.deleteAboutMe)

router.get('/:id/blogs', directTabController.listBlogs)
router.post('/:id/blogs', authMiddleware.requireVcardMutable, directTabController.createBlog)
router.patch('/:id/blogs/:blogId', authMiddleware.requireVcardMutable, directTabController.updateBlog)
router.delete('/:id/blogs/:blogId', authMiddleware.requireVcardMutable, directTabController.deleteBlog)

router.get('/:id/tabs/:tabKey', directTabController.listTabItems)
router.post('/:id/tabs/:tabKey', authMiddleware.requireVcardMutable, directTabController.createTabItem)
router.patch('/:id/tabs/:tabKey/:itemId', authMiddleware.requireVcardMutable, directTabController.updateTabItem)
router.delete('/:id/tabs/:tabKey/:itemId', authMiddleware.requireVcardMutable, directTabController.deleteTabItem)

router.get('/:id/custom-tabs', customTabController.listTabs)
router.post('/:id/custom-tabs', authMiddleware.requireVcardMutable, customTabController.createTab)
router.patch('/:id/custom-tabs/:tabId', authMiddleware.requireVcardMutable, customTabController.updateTab)
router.delete('/:id/custom-tabs/:tabId', authMiddleware.requireVcardMutable, customTabController.deleteTab)
router.get('/:id/custom-tabs/:tabId/items', customTabController.listItems)
router.post('/:id/custom-tabs/:tabId/items', authMiddleware.requireVcardMutable, customTabController.createItem)
router.patch(
  '/:id/custom-tabs/:tabId/items/:itemId',
  authMiddleware.requireVcardMutable,
  customTabController.updateItem
)
router.delete(
  '/:id/custom-tabs/:tabId/items/:itemId',
  authMiddleware.requireVcardMutable,
  customTabController.deleteItem
)

router.get('/:id/posts', profileController.listPosts)
router.post('/:id/posts', authMiddleware.requireVcardMutable, profileController.createPost)
router.patch('/:id/posts/:postId', authMiddleware.requireVcardMutable, profileController.updatePost)
router.delete('/:id/posts/:postId', authMiddleware.requireVcardMutable, profileController.deletePost)

export default router
