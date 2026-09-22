import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const EXPECTED_PUBLIC_ROUTES = [
  'GET /profiles/:slug/google-wallet',
  'GET /profiles/:slug/apple-wallet',
  'POST /profiles/:profileId/assistant/live-token',
  'POST /landing/assistant/live-token',
  'POST /track-event',
  'GET /v/:slug',
  'GET /v/:slug/bootstrap',
  'GET /cards/:slug/bootstrap',
  'GET /post-types',
  'GET /profiles/:id/settings',
  'GET /profiles/:id/announcement',
  'POST /profiles/:id/announcement/dismiss',
  'GET /profiles/:id/team-notices/active',
  'POST /profiles/:id/team-notices/:noticeId/dismiss',
  'GET /profile-ai-data/:id',
  'GET /dynamic-section/:name',
  'GET /public-cards',
  'GET /landing/demo-cards',
  'POST /save-guest-user',
  'POST /save-note',
  'GET /notes',
  'GET /save-contact/:id',
  'GET /push/subscription-status/:slug',
  'GET /push/vapid-public-key',
  'POST /push/subscribe',
  'POST /push/preferences',
  'POST /push/unsubscribe',
  'POST /push/test',
]

function extractPublicRoutes(source: string): string[] {
  const routes: string[] = []
  let pending: string | null = null
  for (const line of source.split('\n')) {
    const sameLine = line.match(/router\.(get|post)\(\s*'([^']+)'/)
    if (sameLine) {
      routes.push(`${sameLine[1].toUpperCase()} ${sameLine[2]}`)
      pending = null
      continue
    }
    const opened = line.match(/router\.(get|post)\(\s*$/)
    if (opened) {
      pending = opened[1].toUpperCase()
      continue
    }
    if (pending) {
      const path = line.match(/^\s*'([^']+)'/)
      if (path) {
        routes.push(`${pending} ${path[1]}`)
        pending = null
      }
    }
  }
  return routes
}

test('public router matches the iPhone API catalog', () => {
  const routeFile = fileURLToPath(new URL('../router/public.route.ts', import.meta.url))
  const source = readFileSync(routeFile, 'utf8')
  assert.deepEqual(extractPublicRoutes(source), EXPECTED_PUBLIC_ROUTES)
})

test('public routes are mounted at /api/v1/public', () => {
  const indexFile = fileURLToPath(new URL('../router/index.ts', import.meta.url))
  const source = readFileSync(indexFile, 'utf8')
  assert.match(source, /path:\s*'\/public'/)
  assert.match(source, /route:\s*publicRoute/)
})
