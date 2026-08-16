import type { MasterBusinessProfile } from './businessProfile.schema'
import type { CardBlueprint } from './cardBlueprint.schema'

export type CompletenessReport = {
  completionScore: number
  found: string[]
  recommended: string[]
}

function present(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function buildCompletenessReport(input: {
  profile?: MasterBusinessProfile | null
  blueprint?: CardBlueprint | null
}): CompletenessReport {
  const profile = input.profile
  const blueprint = input.blueprint
  const personal = blueprint?.personal
  const found: string[] = []
  const recommended: string[] = []

  const checks: Array<{ label: string; ok: boolean; weight: number; hint?: string }> = [
    {
      label: 'Business Name',
      ok: present(profile?.businessName) || present(personal?.company) || present(personal?.fullName),
      weight: 12,
      hint: 'Add the public business or personal name.',
    },
    {
      label: 'Phone',
      ok: present(profile?.phone) || present(personal?.phone),
      weight: 10,
      hint: 'Add a phone number visitors can tap.',
    },
    {
      label: 'Email',
      ok: present(profile?.email) || present(personal?.email),
      weight: 10,
      hint: 'Add a public email address.',
    },
    {
      label: 'Website',
      ok: present(profile?.website) || present(personal?.website),
      weight: 6,
      hint: 'Add your website URL.',
    },
    {
      label: 'Address',
      ok: present(profile?.address) || present(personal?.address),
      weight: 6,
      hint: 'Add a service area or street address.',
    },
    {
      label: 'About',
      ok: present(profile?.businessDescription) || present(personal?.about),
      weight: 10,
      hint: 'Add a short About section.',
    },
    {
      label: 'Services',
      ok: (profile?.services?.length || 0) > 0 || (blueprint?.services?.length || 0) > 0,
      weight: 12,
      hint: 'List the services you offer.',
    },
    {
      label: 'Social profiles',
      ok:
        Object.values(profile?.socialMedia || {}).some(present) ||
        Object.values(blueprint?.socialHandles || {}).some(present),
      weight: 6,
      hint: 'Add Facebook, Instagram, or LinkedIn.',
    },
    {
      label: 'Reviews',
      ok: (profile?.verifiedReviews?.length || 0) + (profile?.existingTestimonials?.length || 0) > 0,
      weight: 6,
      hint: 'Add real customer reviews if you have them.',
    },
    {
      label: 'License or certification',
      ok:
        (profile?.licenses?.length || 0) +
          (profile?.certifications?.length || 0) +
          (profile?.credentials?.length || 0) >
        0,
      weight: 8,
      hint: 'Add a license number or certification.',
    },
    {
      label: 'Business hours',
      ok: (profile?.businessHours?.length || 0) > 0,
      weight: 4,
      hint: 'Add business hours.',
    },
    {
      label: 'FAQ',
      ok: (blueprint?.faqs?.length || 0) > 0,
      weight: 5,
      hint: 'Add a few frequently asked questions.',
    },
    {
      label: 'Portfolio or photos',
      ok: (profile?.portfolio?.length || 0) > 0 || (blueprint?.portfolio?.length || 0) > 0,
      weight: 5,
      hint: 'Upload project photos or a headshot after create.',
    },
  ]

  let earned = 0
  let total = 0
  for (const check of checks) {
    total += check.weight
    if (check.ok) {
      earned += check.weight
      if (check.label === 'Services') {
        const n = profile?.services?.length || blueprint?.services?.length || 0
        found.push(n ? `${n} Services` : check.label)
      } else {
        found.push(check.label)
      }
    } else if (check.hint) {
      recommended.push(check.hint)
    }
  }

  const socials = profile?.socialMedia || {}
  for (const [key, value] of Object.entries(socials)) {
    if (present(value) && ['facebook', 'instagram', 'linkedin', 'youtube', 'tiktok'].includes(key)) {
      found.push(key[0].toUpperCase() + key.slice(1))
    }
  }

  const completionScore = total ? Math.round((earned / total) * 100) : 0
  return { completionScore, found: Array.from(new Set(found)), recommended }
}
