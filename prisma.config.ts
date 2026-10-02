import dotenvFlow from 'dotenv-flow'

dotenvFlow.config()

import { defineConfig, env } from 'prisma/config'

/**
 * Prefer real DATABASE_URL from .env.
 * Fall back for CI/postinstall when no .env is present (generate does not open a DB).
 */
function datasourceUrl(): string {
  try {
    return env('DATABASE_URL')
  } catch {
    if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim()
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
      return 'postgresql://ci:ci@127.0.0.1:5432/ci?schema=public'
    }
    throw new Error('DATABASE_URL is required. Set it in .env or the environment.')
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: datasourceUrl(),
  },
})
