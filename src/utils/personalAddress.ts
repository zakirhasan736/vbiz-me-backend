export function formatProfileLocation(profile: {
  address?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
}) {
  const cityState = [profile.city?.trim(), profile.state?.trim()].filter(Boolean).join(', ')
  const joined = [profile.address?.trim(), cityState, profile.zipCode?.trim()].filter(Boolean).join(', ')
  return joined || profile.address?.trim() || null
}

export function hasProfileLocationParts(profile: {
  address?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
}) {
  return Boolean(profile.address?.trim() || profile.city?.trim() || profile.state?.trim() || profile.zipCode?.trim())
}
