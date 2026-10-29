/**
 * Move every stored media URL to a new public base (bucket rename, CloudFront CDN,
 * custom domain) in one step. Keys never change, so files stay where they are.
 *
 * Rewrites `<from>/<key>` → `<S3_PUBLIC_BASE_URL>/<key>` in EVERY text/json column
 * of EVERY table (cards, tabs, settings, rich text, history, backups).
 *
 *   # 1. set S3_PUBLIC_BASE_URL in .env to the NEW base (e.g. https://media.vbizme.com)
 *   yarn media:rebase --from=https://aws-s3-vbizme-vcard.s3.us-east-2.amazonaws.com
 *   yarn media:rebase --from=https://aws-s3-vbizme-vcard.s3.us-east-2.amazonaws.com --apply
 */
import config from '../src/configs/config'
import { listTextColumns } from '../src/utils/cardMediaScan'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`)

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const from = (argv.find((a) => a.startsWith('--from='))?.slice('--from='.length) || '').trim().replace(/\/+$/, '')
  const to = (config.S3.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!from || !/^https?:\/\//.test(from)) throw new Error('Pass --from=<old public base URL>')
  if (!to) throw new Error('S3_PUBLIC_BASE_URL (the new base) is not set')
  if (from === to) throw new Error('--from equals S3_PUBLIC_BASE_URL — nothing to do')

  console.log(`${from}/…  →  ${to}/…${apply ? '' : '   (dry-run)'}`)
  let total = 0
  for (const col of await listTextColumns()) {
    const table = quoteIdent(col.table)
    const column = quoteIdent(col.column)
    const like = `%${escapeLike(from)}/%`
    if (!apply) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM ${table} WHERE ${column}::text LIKE $1`,
        like
      )
      const n = Number(row?.n || 0)
      if (n) console.log(`  ${col.table}.${col.column}: ${n} row(s)`)
      total += n
      continue
    }
    const cast = col.isJson ? `::${col.dataType}` : ''
    const n = await prisma.$executeRawUnsafe(
      `UPDATE ${table} SET ${column} = replace(${column}::text, $1, $2)${cast} WHERE ${column}::text LIKE $3`,
      `${from}/`,
      `${to}/`,
      like
    )
    if (n) console.log(`  ${col.table}.${col.column}: ${n} row(s) updated`)
    total += n
  }
  console.log(apply ? `Updated ${total} row(s).` : `${total} row(s) would change. Re-run with --apply.`)
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => undefined))
