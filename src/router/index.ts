import { Router } from 'express'
import authRoute from './auth.route'
import healthRoute from './health.route'
import mediaRoute from './media.route'
import profileRoute from './profile.route'
import publicRoute from './public.route'

const router = Router()

const modulePaths = [
  { path: '/auth', route: authRoute },
  { path: '/health', route: healthRoute },
  { path: '/public', route: publicRoute },
  { path: '/profiles', route: profileRoute },
  { path: '/media', route: mediaRoute },
]

modulePaths.forEach(({ path, route }) => {
  router.use(path, route)
})

export default router
