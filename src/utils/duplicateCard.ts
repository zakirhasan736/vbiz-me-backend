/** Unique personal contact fields that must not be copied onto a duplicated vCard. */
export const clearedDuplicateContactFields = {
  email: '',
  phone: null,
  whatsapp: null,
  dob: null,
  countryCode: null,
} as const
