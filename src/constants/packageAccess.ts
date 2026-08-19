import AppError from '../error/AppError'
import { prisma } from '../utils/prisma'
import { isStaffRole } from './userRole'

export const PACKAGE_ACCESS_FEATURES = [
  { key: 'allow_ai_assistance', label: 'AI assistance' },
  { key: 'allow_canva', label: 'Canva feature' },
  { key: 'allow_push_notification', label: 'Push notification' },
  { key: 'allow_email_notification', label: 'Email notification' },
  { key: 'allow_support_ticket', label: 'Contact support ticket' },
  { key: 'allow_auto_card_builder', label: 'Auto card builder' },
  { key: 'allow_seo', label: 'SEO' },
] as const

export type PackageAccessKey = (typeof PACKAGE_ACCESS_FEATURES)[number]['key']

export type PackageAccessMap = Record<PackageAccessKey, boolean>

export const RETIRED_PACKAGE_SLUGS = ['corporate-starter', 'single-starter'] as const

const ACCESS_KEY_SET = new Set<string>(PACKAGE_ACCESS_FEATURES.map((item) => item.key))
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled'])

export function isPackageAccessKey(key: string): key is PackageAccessKey {
  return ACCESS_KEY_SET.has(key.trim().toLowerCase())
}

export function allPackageAccessEnabled(): PackageAccessMap {
  return Object.fromEntries(PACKAGE_ACCESS_FEATURES.map((item) => [item.key, true])) as PackageAccessMap
}

export function parseAccessFlag(value: string | null | undefined, whenMissing = true): boolean {
  if (value == null || String(value).trim() === '') return whenMissing
  const normalized = String(value).trim().toLowerCase()
  if (FALSY.has(normalized)) return false
  if (TRUTHY.has(normalized)) return true
  return whenMissing
}

export function entitlementsFromFeatures(
  features: { featureKey: string; featureValue?: string | null }[] | undefined | null
): PackageAccessMap {
  const map = allPackageAccessEnabled()
  if (!features?.length) return map
  for (const item of PACKAGE_ACCESS_FEATURES) {
    const row = features.find((feature) => feature.featureKey.trim().toLowerCase() === item.key)
    if (row) map[item.key] = parseAccessFlag(row.featureValue, true)
  }
  return map
}

export async function getUserPackageAccess(userId: string, role?: string | null): Promise<PackageAccessMap> {
  if (isStaffRole(role)) return allPackageAccessEnabled()

  const now = new Date()
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return entitlementsFromFeatures(subscription?.package?.features)
}

export async function assertUserPackageAccess(
  userId: string,
  role: string | null | undefined,
  key: PackageAccessKey,
  message?: string
): Promise<void> {
  const access = await getUserPackageAccess(userId, role)
  if (access[key]) return
  const label = PACKAGE_ACCESS_FEATURES.find((item) => item.key === key)?.label || key
  throw new AppError(403, message || `${label} is not included in your package.`, {
    code: 'PACKAGE_FEATURE_LOCKED',
    data: { featureKey: key },
  })
}
