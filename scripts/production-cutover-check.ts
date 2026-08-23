/**
 * Production cutover preflight. Does not migrate, deploy, or write data.
 *
 *   yarn cutover:check
 *   SMOKE_API_URL=https://api.example.com yarn cutover:check
 */
import 'dotenv/config'
import { prisma } from '../src/utils/prisma'
import {
  loginOtpRollbackEnv,
  missingEnvKeys,
  ownerModeProbeFailureHint,
  PACKAGE_LAUNCH_MIGRATIONS,
  PRODUCTION_RECOMMENDED_ENV,
  PRODUCTION_REQUIRED_ENV,
  PRODUCTION_SMOKE_CHECKS,
  stripeWebhookPath,
} from '../src/utils/productionCutover'

async function maybeSmokeHealth(base: string) {
  const url = `${base.replace(/\/$/, '')}/api/v1/health`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Health check failed ${response.status} ${url}`)
  }
  const body = (await response.json()) as { success?: boolean }
  if (body.success === false) throw new Error(`Health payload was not successful: ${url}`)
  console.log(`health ok: ${url}`)
}

async function reportOwnerModeColumn(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ slug: string | null; ownerMode: string | null }>>`
      SELECT "slug", "ownerMode"::text AS "ownerMode"
      FROM "Package"
      ORDER BY "sortOrder" ASC, "name" ASC
    `
    console.log('\nPackage.ownerMode is present:')
    for (const row of rows) console.log(`  ${row.slug || '(no slug)'} = ${row.ownerMode}`)
    return true
  } catch (error) {
    console.log(`\n${ownerModeProbeFailureHint(error)}`)
    return false
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const missingRequired = missingEnvKeys(process.env, PRODUCTION_REQUIRED_ENV)
  const missingRecommended = missingEnvKeys(process.env, PRODUCTION_RECOMMENDED_ENV)

  console.log('Package-launch migrations (run on production with: yarn migrate:deploy)')
  for (const name of PACKAGE_LAUNCH_MIGRATIONS) console.log(`  - ${name}`)

  console.log('\nBackfill (dry-run first, then apply; never deletes cards)')
  console.log('  yarn backfill:owner-packages')
  console.log('  yarn backfill:owner-packages -- --apply')

  console.log(`\nStripe webhook path: ${stripeWebhookPath()}`)
  console.log(`Login OTP rollback: LOGIN_OTP_REQUIRED=${loginOtpRollbackEnv().LOGIN_OTP_REQUIRED} then restart API`)

  if (missingRequired.length) {
    console.log('\nMissing required env:')
    for (const key of missingRequired) console.log(`  - ${key}`)
  } else {
    console.log('\nRequired env names are present (values not printed).')
  }

  if (missingRecommended.length) {
    console.log('Missing recommended env:')
    for (const key of missingRecommended) console.log(`  - ${key}`)
  }

  console.log('\nSmoke checklist:')
  for (const item of PRODUCTION_SMOKE_CHECKS) console.log(`  [ ] ${item}`)

  const smokeBase = (process.env.SMOKE_API_URL || '').trim()
  if (smokeBase) await maybeSmokeHealth(smokeBase)

  const ownerModeReady = process.env.DATABASE_URL ? await reportOwnerModeColumn() : true

  if (missingRequired.length || !ownerModeReady) process.exitCode = 1
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
  await prisma.$disconnect().catch(() => undefined)
})
