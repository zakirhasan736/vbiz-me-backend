/** Contact fields are copied on duplicate; uniqueness is not re-checked. */
export function duplicateContactFields(source: { email?: string | null; dob?: Date | string | null }) {
  return {
    email: source.email || '',
    dob: source.dob ?? null,
  }
}
