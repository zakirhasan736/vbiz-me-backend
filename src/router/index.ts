import { Router } from 'express'
import adminActivityRoute from './adminActivity.route'
import adminLeadsRoute from './adminLeads.route'
import adminPackageRoute from './adminPackage.route'
import adminProfileRoute from './adminProfile.route'
import adminTeamRoute from './adminTeam.route'
import adminUserRoute from './adminUser.route'
import { announcementActiveRoute, announcementAdminRoute } from './announcement.route'
import authRoute from './auth.route'
import cardAgentRoute from './cardAgent.route'
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
  { path: '/health', route: healthRoute },
  { path: '/public', route: publicRoute },
  { path: '/profiles', route: profileRoute },
  { path: '/media', route: mediaRoute },
  { path: '/meetings', route: meetingRoute },
  { path: '/ai/card-agent', route: cardAgentRoute },
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
]

modulePaths.forEach(({ path, route }) => {
  router.use(path, route)
})

export default router
