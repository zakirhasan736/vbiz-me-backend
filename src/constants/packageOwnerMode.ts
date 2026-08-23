import { isStaffRole } from './userRole'

export const OWNER_MODES = ['single', 'corporate'] as const
export type OwnerMode = (typeof OWNER_MODES)[number]

export const SINGLE_PACKAGE_SLUGS = ['free', 'professional', 'professional-concierge', 'single-starter'] as const
export const CORPORATE_PACKAGE_SLUGS = ['corporate', 'corporate-starter'] as const
export const CATALOG_PACKAGE_SLUGS = ['free', 'professional', 'professional-concierge', 'corporate'] as const
export const FREE_CATALOG_SLUG = 'free'
export const CORPORATE_CATALOG_SLUG = 'corporate'

const SINGLE_SLUG_SET = new Set<string>(SINGLE_PACKAGE_SLUGS)
const CORPORATE_SLUG_SET = new Set<string>(CORPORATE_PACKAGE_SLUGS)

export function normalizePackageSlug(slug?: string | null): string {
  return (slug || '').trim().toLowerCase()
}

export function parseStoredOwnerMode(value?: string | null): OwnerMode | null {
  const raw = (value || '').trim().toLowerCase()
  if (raw === 'corporate') return 'corporate'
  if (raw === 'single') return 'single'
  return null
}

export function inferOwnerModeFromCatalog(pkg: { slug?: string | null; name?: string | null }): OwnerMode {
  const slug = normalizePackageSlug(pkg.slug)
  if (CORPORATE_SLUG_SET.has(slug) || slug.startsWith('corporate')) return 'corporate'
  if (SINGLE_SLUG_SET.has(slug)) return 'single'

  const name = (pkg.name || '').trim().toLowerCase()
  if (name.includes('corporate')) return 'corporate'
  if (name.includes('concierge') || name.includes('professional') || name === 'free' || name.includes('single')) {
    return 'single'
  }

  return 'single'
}

/**
 * Catalog rule: stored Package.ownerMode first, then slug/name fallback.
 * Free / Professional / Concierge → Single. Corporate → Corporate.
 */
export function resolveOwnerMode(pkg: {
  ownerMode?: string | null
  slug?: string | null
  name?: string | null
}): OwnerMode {
  return parseStoredOwnerMode(pkg.ownerMode) ?? inferOwnerModeFromCatalog(pkg)
}

export function prismaOwnerMode(mode: OwnerMode): 'SINGLE' | 'CORPORATE' {
  return mode === 'corporate' ? 'CORPORATE' : 'SINGLE'
}

export function roleForOwnerMode(mode: OwnerMode): 'vcard-owner' | 'corporate-owner' {
  return mode === 'corporate' ? 'corporate-owner' : 'vcard-owner'
}

export function ownerModeLabel(mode: OwnerMode): string {
  return mode === 'corporate' ? 'Corporate back office' : 'Single back office'
}

export function canUseCorporateBackOffice(ownerMode: OwnerMode | null | undefined): boolean {
  return ownerMode === 'corporate'
}

export function homePathForOwnerMode(ownerMode: OwnerMode | null | undefined): string {
  return ownerMode === 'corporate' ? '/teamvcard' : '/'
}

export function directoryPathForOwnerMode(ownerMode: OwnerMode | null | undefined): string {
  return ownerMode === 'corporate' ? '/teamvcard' : '/vcards'
}

export function isCardEditorPath(pathname: string): boolean {
  return pathname.startsWith('/vcards/create') || pathname.startsWith('/vcards/edit')
}

export function isCorporateOfficePath(pathname: string): boolean {
  return pathname === '/teamvcard' || pathname.startsWith('/teamvcard/')
}

export function isSingleDirectoryPath(pathname: string): boolean {
  return pathname === '/vcards' || pathname === '/vcards/'
}

export function ownerOfficeRedirectPath(input: {
  pathname: string
  role?: string | null
  ownerMode?: OwnerMode | null
}): string | null {
  const pathname = input.pathname || '/'
  if (isStaffRole(input.role)) {
    if (pathname.startsWith('/admin') || isCardEditorPath(pathname)) return null
    return '/admin/dashboard'
  }

  const ownerMode = input.ownerMode === 'corporate' || input.ownerMode === 'single' ? input.ownerMode : null
  if (!ownerMode) return null
  if (isCardEditorPath(pathname)) return null
  if (ownerMode === 'single' && isCorporateOfficePath(pathname)) return homePathForOwnerMode('single')
  if (ownerMode === 'corporate' && isSingleDirectoryPath(pathname)) return homePathForOwnerMode('corporate')
  return null
}

export function parsePackageMaxCards(
  features: { featureKey: string; featureValue?: string | null }[] | undefined | null
): number | null {
  const feature = (features || []).find((row) => row.featureKey.trim().toLowerCase() === 'max_cards')
  if (feature?.featureValue == null || String(feature.featureValue).trim() === '') return null
  const raw = String(feature.featureValue).trim().toLowerCase()
  if (raw === 'unlimited' || raw === '-1') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

export function resolveProvisionCardQuantity(input: {
  ownerMode: OwnerMode
  packageMaxCards: number | null
  cardLimit?: number | null
}): number | null {
  if (
    input.ownerMode === 'corporate' &&
    input.cardLimit != null &&
    Number.isInteger(input.cardLimit) &&
    input.cardLimit >= 0
  ) {
    return input.cardLimit
  }
  return input.packageMaxCards
}
