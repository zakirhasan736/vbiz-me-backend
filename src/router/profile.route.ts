import { Router } from 'express'
import profileController from '../controller/profile.controller'
import authMiddleware from '../middlewares/authValidation'

const router = Router()

router.use(authMiddleware.isAuthenticateUser)

router.get('/dashboard/stats', profileController.dashboard)
router.get('/dashboard/engagement', profileController.recentEngagement)
router.get('/dashboard/export', profileController.exportDashboard)
router.get('/contacts', profileController.contacts)
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
router.put('/:id/skills', profileController.replaceSkills)
router.put('/:id/social-links', profileController.replaceSocialLinks)

router.get('/:id/posts', profileController.listPosts)
router.post('/:id/posts', profileController.createPost)
router.patch('/:id/posts/:postId', profileController.updatePost)
router.delete('/:id/posts/:postId', profileController.deletePost)

export default router
