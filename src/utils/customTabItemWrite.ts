export type CustomTabItemWritePlan = {
  mode: 'update' | 'create'
  /** Set only when this save should keep the editor id. */
  id?: string
}

/**
 * Custom-tab saves reuse the editor's item id. Those rows are soft-retired, not deleted,
 * so a later save must update the existing row. Reusing another card's id, or the same id
 * twice in one payload, creates a new row instead.
 */
export function resolveCustomTabItemWrite(input: {
  requestedId?: string
  existingProfileId?: string | null
  cardProfileId: string
  alreadyUsed: boolean
}): CustomTabItemWritePlan {
  const id = input.requestedId?.trim() || ''
  if (!id || input.alreadyUsed) return { mode: 'create' }
  if (input.existingProfileId === input.cardProfileId) return { mode: 'update', id }
  if (input.existingProfileId) return { mode: 'create' }
  return { mode: 'create', id }
}
