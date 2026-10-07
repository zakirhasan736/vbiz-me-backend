import { formatProfileLocation } from './personalAddress'

export type SaveContactProfileInput = {
  name?: string | null
  email?: string | null
  phone?: string | null
  companyName?: string | null
  professionName?: string | null
  prof?: string | null
  designation?: string | null
  genderName?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
  about?: string | null
}

export type SaveContactFields = {
  name: string
  email: string
  phone: string
  company: string
  /** Public-card Profession line: profession, or designation when profession is empty. */
  profession: string
  designation: string
  gender: string
  website: string
  note: string
  /** Same line the public card shows: street, city, state, postal code. */
  address: string
}

function cleanContactText(value?: string | null): string {
  return (value || '')
    .replace(/\s*\|\|\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function buildSaveContactFields(profile: SaveContactProfileInput): SaveContactFields {
  const profession = cleanContactText(profile.professionName || profile.prof)
  const designation = cleanContactText(profile.designation)
  return {
    name: cleanContactText(profile.name),
    email: cleanContactText(profile.email),
    phone: cleanContactText(profile.phone),
    company: cleanContactText(profile.companyName),
    profession: profession || designation,
    designation,
    gender: cleanContactText(profile.genderName),
    website: cleanContactText(profile.website),
    note: cleanContactText(profile.about),
    address: formatProfileLocation(profile) || '',
  }
}
