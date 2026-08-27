/** True when Postgres/Prisma is querying a table that has not been migrated yet. */
export function isPrismaMissingTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  if (err.code === 'P2021' || err.code === 'P2010') return true
  const message = String(err.message || '')
  return /does not exist|relation .* does not exist|42P01/i.test(message)
}

/** True when Prisma selected a column the live table does not have (e.g. stale `metas`). */
export function isPrismaColumnMismatch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  if (err.code === 'P2022') return true
  const message = String(err.message || '')
  return /column .* does not exist|42703/i.test(message)
}

/** True when a live column type does not match Prisma (e.g. Gallery.status integer vs text). */
export function isPrismaTypeMismatch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  if (err.code === 'P2023' || err.code === 'P2032') return true
  const message = String(err.message || '')
  return /inconsistent column data|conversion failed|operator does not exist/i.test(message)
}

/** True when Postgres/Prisma rejected a unique constraint (P2002 / 23505). */
export function isPrismaUniqueConstraint(error: unknown, field?: string): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; meta?: { target?: unknown }; message?: string }
  const message = String(err.message || '')
  const isUnique = err.code === 'P2002' || /unique constraint|23505/i.test(message)
  if (!isUnique) return false
  if (!field) return true
  const target = Array.isArray(err.meta?.target) ? err.meta.target.map((value) => String(value).toLowerCase()) : []
  const needle = field.toLowerCase()
  return (
    target.some((value) => value.includes(needle)) ||
    message.toLowerCase().includes(needle) ||
    message.toLowerCase().includes('profile_email_unique')
  )
}

/** True when Prisma Client rejects a create/update field that is not on the generated model. */
export function isPrismaUnknownArgument(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || '')
  return /Unknown argument `/i.test(message)
}

export function isPrismaSchemaDrift(error: unknown): boolean {
  return isPrismaMissingTable(error) || isPrismaColumnMismatch(error) || isPrismaTypeMismatch(error)
}

export function missingPrismaTableName(error: unknown): string | null {
  const message = String((error as { message?: string })?.message || '')
  const columnOnModel = message.match(/column [`'](\w+)\.(\w+)[`']/i)
  if (columnOnModel) return columnOnModel[1]
  const match =
    message.match(/table [`'](?:public\.)?(\w+)[`']/i) ||
    message.match(/relation [`"](?:public\.)?(\w+)[`"] does not exist/i)
  return match?.[1] ?? null
}

export function missingPrismaColumnName(error: unknown): string | null {
  const message = String((error as { message?: string })?.message || '')
  const columnOnModel = message.match(/column [`'](\w+)\.(\w+)[`']/i)
  if (columnOnModel) return columnOnModel[2]
  const match = message.match(/column [`'](?:[\w.]+\.)?(\w+)[`']/i)
  return match?.[1] ?? null
}

/** Run a Prisma query; missing tables/columns return `fallback` instead of 500. */
export async function safePrismaQuery<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isPrismaSchemaDrift(error)) throw error
    return fallback
  }
}
