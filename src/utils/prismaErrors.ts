/** True when Postgres/Prisma is querying a table that has not been migrated yet. */
export function isPrismaMissingTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  if (err.code === 'P2021' || err.code === 'P2010') return true
  const message = String(err.message || '')
  return /does not exist|relation .* does not exist|42P01/i.test(message)
}
