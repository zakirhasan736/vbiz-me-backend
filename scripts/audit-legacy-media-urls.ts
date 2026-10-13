/**
 * Audit the NEW Postgres DB for leftover Laravel media hosts / bare filenames.
 * Does not touch MySQL. Read-only.
 *
 *   yarn tsx --env-file=.env scripts/audit-legacy-media-urls.ts
 *
 * Exit 1 if any laravel/storage/ecard absolute URLs remain in scanned columns.
 */
import { prisma } from '../src/utils/prisma'

type Hit = { table: string; column: string; count: number; samples: string[] }

const LEGACY_ABS = /https?:\/\/[^"'\\\s]*\/storage\/ecard\//i
const APP_STORAGE = /https?:\/\/app\.vbizme\.com\/storage\//i
const S3ISH = /amazonaws\.com|\.s3[.-]|cloudfront\.net/i

async function countLike(table: string, column: string, pattern: string): Promise<Hit> {
  // identifiers are hardcoded below — never interpolate user input
  const sql = `
    SELECT COUNT(*)::int AS count
    FROM "${table}"
    WHERE "${column}" IS NOT NULL
      AND "${column}" ~* $1
  `
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(sql, pattern)
  const samplesSql = `
    SELECT "${column}" AS value
    FROM "${table}"
    WHERE "${column}" IS NOT NULL
      AND "${column}" ~* $1
    LIMIT 5
  `
  const samples = await prisma.$queryRawUnsafe<Array<{ value: string }>>(samplesSql, pattern)
  return {
    table,
    column,
    count: rows[0]?.count || 0,
    samples: samples.map((r) => String(r.value || '').slice(0, 180)),
  }
}

async function main() {
  const scans: Array<[string, string]> = [
    ['Profile', 'avatar'],
    ['Attachment', 'url'],
    ['Attachment', 'docName'],
    ['Post', 'featuredImage'],
    ['Post', 'url'],
    ['Service', 'imageUrl'],
    ['Service', 'reviewUrl'],
    ['Portfolio', 'imageUrl'],
    ['Gallery', 'featuredImage'],
    ['Gallery', 'url'],
    ['Video', 'url'],
    ['Video', 'featuredImage'],
    ['Client', 'featuredImage'],
    ['Client', 'url'],
    ['Review', 'imageUrl'],
    ['Review', 'reviewUrl'],
    ['Blog', 'featuredImage'],
    ['TabItem', 'featuredImage'],
    ['TabItem', 'url'],
    ['AboutMe', 'featuredMediaUrl'],
    ['WhyChooseUs', 'featuredMediaUrl'],
    ['MissionStatement', 'featuredImage'],
    ['CustomTabItem', 'featuredImage'],
    ['CustomTabItem', 'url'],
    ['Setting', 'value'],
  ]

  console.log('Auditing Postgres only (no Laravel MySQL connection).\n')

  const legacyHits: Hit[] = []
  const appHits: Hit[] = []
  let scanned = 0

  for (const [table, column] of scans) {
    scanned++
    try {
      const legacy = await countLike(table, column, 'https?://.*/storage/ecard/')
      const app = await countLike(table, column, 'https?://app\\.vbizme\\.com/storage/')
      if (legacy.count) legacyHits.push(legacy)
      if (app.count) appHits.push(app)
      console.log(`${table}.${column}: legacy_storage=${legacy.count} app_storage=${app.count}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`${table}.${column}: SKIP (${message.split('\n')[0]})`)
    }
  }

  // High-level profile + media totals from new DB
  const [profiles, posts, attachments] = await Promise.all([
    prisma.profile.count(),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.attachment.count(),
  ])

  const s3Attachments = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "Attachment"
    WHERE url IS NOT NULL
      AND (
        url ILIKE '%amazonaws.com%'
        OR url ILIKE '%.s3.%'
        OR url ILIKE '%cloudfront.net%'
      )
  `

  console.log('\n--- Summary ---')
  console.log(`profiles=${profiles} posts=${posts} attachments=${attachments}`)
  console.log(`attachments_with_s3ish_url=${s3Attachments[0]?.count ?? 0}`)
  console.log(`columns_scanned=${scanned}`)
  console.log(`legacy_/storage/ecard/_hits=${legacyHits.reduce((n, h) => n + h.count, 0)}`)
  console.log(`app.vbizme.com/storage_hits=${appHits.reduce((n, h) => n + h.count, 0)}`)

  if (legacyHits.length) {
    console.log('\nLegacy absolute media URLs still in Postgres:')
    for (const hit of legacyHits) {
      console.log(`  ${hit.table}.${hit.column}: ${hit.count}`)
      for (const s of hit.samples) console.log(`    - ${s}`)
    }
  }

  if (appHits.length) {
    console.log('\napp.vbizme.com/storage URLs still in Postgres:')
    for (const hit of appHits) {
      console.log(`  ${hit.table}.${hit.column}: ${hit.count}`)
      for (const s of hit.samples) console.log(`    - ${s}`)
    }
  }

  // Presence of LARAVEL_MYSQL_URL in this process env (value not printed)
  const mysqlSet = Boolean(process.env.LARAVEL_MYSQL_URL?.trim())
  console.log(`\nLARAVEL_MYSQL_URL in this env: ${mysqlSet ? 'SET (remove from production shared/.env)' : 'UNSET'}`)
  console.log('Runtime API does not open MySQL. Safe to unset LARAVEL_MYSQL_URL after this audit looks clean.')

  // unused helpers keep intent clear for reviewers
  void LEGACY_ABS
  void APP_STORAGE
  void S3ISH

  if (legacyHits.some((h) => h.count > 0) || appHits.some((h) => h.count > 0)) {
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
  })
