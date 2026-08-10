import { Router } from 'express'
import profileController from '../controller/profile.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/dashboard/stats', profileController.dashboard)
router.get('/dashboard/engagement', profileController.recentEngagement)
router.get('/dashboard/weekly-engagement', profileController.weeklyEngagement)
router.get('/dashboard/consolidated-engagement', profileController.consolidatedEngagement)
router.get('/dashboard/social-clicks', profileController.socialClicks)
router.get('/dashboard/social-clicks-by-card', profileController.socialClicksByCard)
router.get('/dashboard/live-clicks', profileController.liveClicks)
router.get('/dashboard/export', profileController.exportDashboard)
router.get('/contacts/export', profileController.exportContacts)
router.patch('/contacts/:id', profileController.patchContact)
router.get('/contacts', profileController.contacts)
router.get('/team-notices', profileController.listTeamNotices)
router.post('/team-notices', profileController.createTeamNotice)
router.delete('/team-notices/:id', profileController.deleteTeamNotice)
router.get('/packages', profileController.packages)
router.get('/subscriptions', profileController.subscriptions)

router.get('/', profileController.list)
router.post('/', profileController.create)
router.get('/check-slug', profileController.checkSlug)
router.get('/:id', profileController.getOne)
router.patch('/:id', profileController.update)
router.delete('/:id', profileController.remove)

router.put('/:id/education', profileController.replaceEducation)
router.put('/:id/experiences', profileController.replaceExperiences)
router.put('/:id/services', profileController.replaceServices)
router.put('/:id/portfolios', profileController.replacePortfolios)
router.put('/:id/reviews', profileController.replaceReviews)
router.put('/:id/skills', profileController.replaceSkills)
router.put('/:id/social-links', profileController.replaceSocialLinks)

router.get('/:id/posts', profileController.listPosts)
router.post('/:id/posts', profileController.createPost)
router.patch('/:id/posts/:postId', profileController.updatePost)
router.delete('/:id/posts/:postId', profileController.deletePost)

export default router
