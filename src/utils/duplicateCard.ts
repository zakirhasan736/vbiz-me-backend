/** Unique or identity fields that must not be copied onto a duplicated vCard. Phone and WhatsApp may be reused. */
export const clearedDuplicateContactFields = {
  email: '',
  dob: null,
} as const
