import { Router } from 'express'
import publicController from '../controller/public.controller'
import { publicRateLimiter } from '../middlewares/ownership'
import adminActivityRoute from './adminActivity.route'
import adminLeadsRoute from './adminLeads.route'
import adminPackageRoute from './adminPackage.route'
import adminProfileRoute from './adminProfile.route'
import adminTeamRoute from './adminTeam.route'
import adminUserRoute from './adminUser.route'
import { announcementActiveRoute, announcementAdminRoute } from './announcement.route'
import authRoute from './auth.route'
import billingRoute from './billing.route'
import birthdayWishRoute from './birthdayWish.route'
import canvaRoute from './canva.route'
import cardAgentRoute from './cardAgent.route'
import crmRoute from './crm.route'
import fontsRoute from './fonts.route'
import healthRoute from './health.route'
import mediaRoute from './media.route'
import meetingRoute from './meeting.route'
import profileRoute from './profile.route'
import publicRoute from './public.route'
import supportRoute from './support.route'
import { templateActiveRoute, templateAdminRoute } from './template.route'

const router = Router()

const modulePaths = [
  { path: '/auth', route: authRoute },
  { path: '/billing', route: billingRoute },
  { path: '/health', route: healthRoute },
  { path: '/fonts', route: fontsRoute },
  { path: '/public', route: publicRoute },
  { path: '/profiles', route: profileRoute },
  { path: '/media', route: mediaRoute },
  { path: '/meetings', route: meetingRoute },
  { path: '/ai/card-agent', route: cardAgentRoute },
  { path: '/integrations/canva', route: canvaRoute },
  { path: '/crm', route: crmRoute },
  { path: '/announcements', route: announcementActiveRoute },
  { path: '/templates', route: templateActiveRoute },
  { path: '/admin', route: adminActivityRoute },
  { path: '/admin', route: adminLeadsRoute },
  { path: '/admin', route: adminProfileRoute },
  { path: '/admin', route: adminUserRoute },
  { path: '/admin', route: adminPackageRoute },
  { path: '/admin', route: adminTeamRoute },
  { path: '/admin', route: supportRoute },
  { path: '/admin', route: announcementAdminRoute },
  { path: '/admin', route: templateAdminRoute },
  { path: '/admin', route: birthdayWishRoute },
]

modulePaths.forEach(({ path, route }) => {
  router.use(path, route)
})

/** Older landing builds called `/api/v1/public-cards` (missing `/public`). */
router.get('/public-cards', publicRateLimiter, publicController.getPublicCards)

export default router
