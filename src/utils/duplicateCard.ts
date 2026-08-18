/** Contact and identity fields are preserved when duplicating a card. */
export function duplicateContactFields(source: { email?: string | null; dob?: Date | string | null }) {
  return {
    email: source.email || '',
    dob: source.dob ?? null,
  }
}
