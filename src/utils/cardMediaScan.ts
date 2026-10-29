import config from '../configs/config'
import { extractMediaKeys, replaceMediaKeys } from './mediaKeys'
import { prisma } from './prisma'

/**
 * Schema-driven scan of every text / JSON column that belongs to one card.
 *
 * Driven by information_schema instead of a hand-kept list of tables, so a new
 * tab / model / column holding media URLs is covered automatically (the old
 * hand-kept list missed Service.imageUrl, which is how sibling images got deleted).
 */

type TextColumn = { table: string; column: string; isJson: boolean; dataType: string }

type CardTableScope =
  /** Rows owned directly by the card. */
  | { kind: 'profileId' }
  /** The card row itself. */
  | { kind: 'self' }
  /** Child rows reached through a parent table that has profileId. */
  | { kind: 'parent'; fk: string; parentTable: string }

type CardTable = { table: string; scope: CardTableScope; columns: TextColumn[] }

/** Child tables without their own profileId, keyed by FK column → parent table. */
const PARENT_LINKS: Record<string, string> = {
  postId: 'Post',
  menuId: 'Menu',
  customTabId: 'CustomTab',
}

const TEXT_TYPES = new Set(['text', 'character varying', 'json', 'jsonb'])

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

let cachedColumns: Promise<TextColumn[]> | null = null
let cachedAllColumns: Promise<Map<string, Set<string>>> | null = null

async function loadColumns(): Promise<Map<string, Set<string>>> {
  if (!cachedAllColumns) {
    cachedAllColumns = prisma
      .$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()`
      )
      .then((rows) => {
        const map = new Map<string, Set<string>>()
        for (const row of rows) {
          if (!map.has(row.table_name)) map.set(row.table_name, new Set())
          map.get(row.table_name)!.add(row.column_name)
        }
        return map
      })
  }
  return cachedAllColumns
}

/** Every text/json column in the current schema (used by the global scanners too). */
export async function listTextColumns(): Promise<TextColumn[]> {
  if (!cachedColumns) {
    cachedColumns = prisma
      .$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string }>>(
        `SELECT c.table_name, c.column_name, c.data_type
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'`
      )
      .then((rows) =>
        rows
          .filter((r) => TEXT_TYPES.has(r.data_type) && !r.table_name.startsWith('_'))
          .map((r) => ({
            table: r.table_name,
            column: r.column_name,
            dataType: r.data_type,
            isJson: r.data_type === 'json' || r.data_type === 'jsonb',
          }))
      )
  }
  return cachedColumns
}

async function listCardTables(): Promise<CardTable[]> {
  const [columns, allColumns] = await Promise.all([listTextColumns(), loadColumns()])
  const byTable = new Map<string, TextColumn[]>()
  for (const col of columns) {
    if (col.column === 'id') continue
    if (!byTable.has(col.table)) byTable.set(col.table, [])
    byTable.get(col.table)!.push(col)
  }

  const tables: CardTable[] = []
  for (const [table, cols] of byTable) {
    const tableCols = allColumns.get(table) || new Set<string>()
    if (!tableCols.has('id')) continue
    if (table === 'Profile') {
      tables.push({ table, scope: { kind: 'self' }, columns: cols })
      continue
    }
    if (tableCols.has('profileId')) {
      tables.push({ table, scope: { kind: 'profileId' }, columns: cols })
      continue
    }
    for (const [fk, parentTable] of Object.entries(PARENT_LINKS)) {
      if (tableCols.has(fk) && allColumns.get(parentTable)?.has('profileId')) {
        tables.push({ table, scope: { kind: 'parent', fk, parentTable }, columns: cols })
        break
      }
    }
  }
  return tables
}

function scopeWhere(scope: CardTableScope): string {
  if (scope.kind === 'self') return `"id" = $1`
  if (scope.kind === 'profileId') return `"profileId" = $1`
  return `${quoteIdent(scope.fk)} IN (SELECT "id" FROM ${quoteIdent(scope.parentTable)} WHERE "profileId" = $1)`
}

type CardRow = { table: CardTable; id: string; values: Record<string, string | null> }

async function* iterateCardRows(profileId: string, options?: { skipTables?: Set<string> }) {
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!base) return
  const like = `%${base.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`
  for (const table of await listCardTables()) {
    if (options?.skipTables?.has(table.table)) continue
    const select = table.columns.map((c) => `${quoteIdent(c.column)}::text AS ${quoteIdent(c.column)}`).join(', ')
    const anyMatch = table.columns.map((c) => `${quoteIdent(c.column)}::text LIKE $2`).join(' OR ')
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
      `SELECT "id"::text AS "__id", ${select} FROM ${quoteIdent(table.table)}
        WHERE ${scopeWhere(table.scope)} AND (${anyMatch})`,
      profileId,
      like
    )
    for (const row of rows) {
      const { __id, ...values } = row
      yield { table, id: String(__id), values } as CardRow
    }
  }
}

/** Every bucket key referenced anywhere on this card (all tabs, settings, attachments, …). */
export async function collectCardMediaKeys(
  profileId: string,
  options?: { skipTables?: Set<string> }
): Promise<Set<string>> {
  const keys = new Set<string>()
  const base = config.S3.PUBLIC_BASE_URL || ''
  for await (const row of iterateCardRows(profileId, options)) {
    for (const value of Object.values(row.values)) {
      if (value) for (const key of extractMediaKeys(value, base)) keys.add(key)
    }
  }
  return keys
}

/**
 * Rewrite media URLs on one card: `<base>/<oldKey>` → `<base>/<newKey>` in every
 * card-owned text/json column. Attachment.publicId (a bare key) is rewritten too.
 */
export async function rewriteCardMediaKeys(
  profileId: string,
  keyMap: Map<string, string>,
  options?: { skipTables?: Set<string> }
): Promise<number> {
  if (!keyMap.size) return 0
  const base = config.S3.PUBLIC_BASE_URL || ''
  let updatedRows = 0
  for await (const row of iterateCardRows(profileId, options)) {
    const sets: string[] = []
    const params: unknown[] = [row.id]
    for (const col of row.table.columns) {
      const before = row.values[col.column]
      if (!before) continue
      const after = replaceMediaKeys(before, keyMap, base)
      if (after === before) continue
      params.push(after)
      const cast = col.isJson ? `::${col.dataType}` : ''
      sets.push(`${quoteIdent(col.column)} = $${params.length}${cast}`)
    }
    if (!sets.length) continue
    await prisma.$executeRawUnsafe(
      `UPDATE ${quoteIdent(row.table.table)} SET ${sets.join(', ')} WHERE "id"::text = $1`,
      ...params
    )
    updatedRows += 1
  }

  // Attachment.publicId stores the bare key (no base URL), so the URL regex above misses it.
  for (const [from, to] of keyMap) {
    await prisma.attachment.updateMany({ where: { profileId, publicId: from }, data: { publicId: to } })
  }
  return updatedRows
}

/**
 * Every bucket key referenced anywhere in the database — all tables, all text/json
 * columns, including soft-deleted rows, change-history snapshots and daily backups.
 * Used by the repair and orphan-cleanup scripts (never by request handlers).
 */
export async function collectAllReferencedMediaKeys(): Promise<Set<string>> {
  const keys = new Set<string>()
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  if (!base) return keys
  const like = `%${base.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`
  for (const col of await listTextColumns()) {
    const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(
      `SELECT ${quoteIdent(col.column)}::text AS v FROM ${quoteIdent(col.table)}
        WHERE ${quoteIdent(col.column)}::text LIKE $1`,
      like
    )
    for (const row of rows) {
      if (row.v) for (const key of extractMediaKeys(row.v, base)) keys.add(key)
    }
  }
  // Bare keys (no base URL) in Attachment.publicId
  const attachments = await prisma.attachment.findMany({
    where: { publicId: { not: null } },
    select: { publicId: true },
  })
  for (const att of attachments) {
    const key = att.publicId?.trim().replace(/^\/+/, '')
    if (key) keys.add(key)
  }
  return keys
}
