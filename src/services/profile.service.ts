import { randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { UserRole } from '../../generated/prisma/client'
import { AccountStatus } from '../../generated/prisma/enums'
import { buildAdminTeamCardsScopeWhere } from '../constants/adminTeamCards'
import { buildFrontendPublicCardPath } from '../constants/frontendPublicCardPath'
import {
  CORPORATE_CARD_LIMIT_REACHED,
  FEATURE_LIMIT_REACHED,
  featureLimitReachedError,
} from '../constants/packageErrors'
import { resolveOwnerMode } from '../constants/packageOwnerMode'
import { isStaffRole, toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { slugify } from '../middlewares/ownership'
import {
  ABOUT_ME_MEDIA_FOCUS_Y_KEY,
  clampAboutMeMediaFocusY,
  readAboutMeMediaFocusY,
  upsertAboutMeMediaFocusY,
} from '../utils/aboutMeMediaFocus'
import authUtils from '../utils/auth.utils'
import {
  cardActivationIssueMessage,
  cardCreationIssueMessage,
  collectCardActivationIssues,
  collectCardCreationIssues,
  createContactConflictMessage,
  findCreateContactConflict,
  normalizeCardEmail,
  normalizeCardPhone,
  type CardActivationInput,
} from '../utils/cardActivation'
import {
  ensureStatusByName,
  isCardLifecycleStatus,
  lifecycleStatusFlags,
  normalizeCardStatusName,
  resolveInitialCardLifecycle,
} from '../utils/cardStatus'
import {
  DASHBOARD_ALL_CHART_DAYS,
  SOCIAL_CHANNELS,
  SOCIAL_CHANNEL_LABELS,
  buildDailyPoints,
  countDistinctGuests,
  countDistinctGuestsByChannel,
  countDistinctGuestsByDay,
  dayKey,
  eventTypeLabel,
  formatRelativeTime,
  guestIdFromPayload,
  parsePlatformFromUa,
  resolveDashboardWindowDays,
  trendPercent,
  viewerFromPayload,
  type DashboardPeriod,
  type SocialChannel,
} from '../utils/dashboardAnalytics'
import {
  POST_STYLE_CLONE_SELECT,
  blankDuplicatedIdentityFields,
  cloneRecord,
  duplicatedCardOwnership,
  omitCloneKeys,
  remapDuplicatedCardSettings,
  settingsMapFromRows,
  unknownPrismaCreateArgs,
  unknownPrismaSelectFields,
} from '../utils/duplicateCard'
import { fillMissingGalleryMedia, listGalleriesForProfile } from '../utils/galleryMedia'
import liveClicksHub, { type LiveSocialClickRow } from '../utils/liveClicksHub'
import logger from '../utils/logger'
import { catalogGateForWallpaperChange, catalogGatesForSettingChange } from '../utils/mediaFeatureGates'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import {
  canCreateAnotherCard,
  countFilledExtraFields,
  countFilledSocialLinks,
  remainingCardSlots,
} from '../utils/packageLimits'
import { prisma } from '../utils/prisma'
import {
  isPrismaColumnMismatch,
  isPrismaMissingTable,
  isPrismaSchemaDrift,
  isPrismaTypeMismatch,
  isPrismaUniqueConstraint,
  isPrismaUnknownArgument,
  safePrismaQuery,
} from '../utils/prismaErrors'
import { loadProfileEngagementMetrics } from '../utils/profileListMetrics'
import type { PublicViewerIdentity } from '../utils/publicVisitor'
import announcementService from './announcement.service'
import {
  assertCatalogFeatureGate,
  assertCountWithinPackageLimit,
  getEffectiveEntitlements,
} from './entitlement.service'
import pushService from './push.service'
import { normalizeSeoSettings } from './seoMetadata.service'
import subscriptionService from './subscription.service'

type LifecycleNotifyActor = { id: string; email: string; name?: string | null }

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Email + backoffice announcement when admin pauses or suspends a card. */
const notifyCardPausedOrSuspended = async (
  actor: LifecycleNotifyActor,
  profileId: string,
  action: 'paused' | 'suspended'
) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        userId: true,
        companyUserId: true,
        user: { select: { email: true, name: true, role: true } },
        companyUser: { select: { email: true, name: true, role: true } },
      },
    })
    if (!profile) return

    const userRole = profile.user?.role ? toApiRole(profile.user.role) : null
    const companyRole = profile.companyUser?.role ? toApiRole(profile.companyUser.role) : null
    const isCorporate = companyRole === 'corporate-owner' || userRole === 'corporate-owner'

    const cardEmail = profile.email?.trim().toLowerCase() || ''
    const ownerEmail = (profile.user?.email || '').trim().toLowerCase()
    const corporateOwnerEmail = (profile.companyUser?.email || (userRole === 'corporate-owner' ? ownerEmail : '') || '')
      .trim()
      .toLowerCase()

    const cardLabel = profile.name?.trim() || profile.slug?.trim() || 'your card'
    const actionLabel = action === 'paused' ? 'paused' : 'suspended'
    const subject = `Your vCard has been ${actionLabel}`
    const bodyText =
      action === 'paused'
        ? `Your card "${cardLabel}" has been paused by an administrator. It is no longer public and has been moved to draft. Please contact support to re-enable it.`
        : `Your card "${cardLabel}" has been suspended by an administrator. It is disabled and counts toward your package capacity. Please contact support to restore access.`

    let emailRecipients: string[] = []
    let announcementEmails: string[] = []

    if (isCorporate) {
      emailRecipients = [...new Set([cardEmail, corporateOwnerEmail || ownerEmail].filter(Boolean))]
      announcementEmails = [...new Set([corporateOwnerEmail || ownerEmail].filter(Boolean))]
    } else {
      emailRecipients = [...new Set([cardEmail || ownerEmail].filter(Boolean))]
      announcementEmails = [...new Set([ownerEmail || cardEmail].filter(Boolean))]
    }

    const html = `<div style="font-family:sans-serif;line-height:1.5"><p>${escapeHtml(bodyText)}</p></div>`

    await Promise.all(
      emailRecipients.map((email) =>
        authUtils.sendEmail({ receiverMail: email, subject, html }).catch((err) => {
          logger.error(`Failed to send card ${action} email`, email, err)
        })
      )
    )

    if (announcementEmails.length) {
      try {
        await announcementService.create(actor, {
          type: 'warning',
          kind: 'warning',
          title: `Card ${actionLabel}: ${cardLabel}`,
          body: bodyText,
          status: 'active',
          targetType: 'specific',
          targetEmails: announcementEmails,
          meta: { profileId: profile.id, action },
        })
      } catch (error) {
        logger.error(`Failed to create card ${action} announcement`, error)
      }
    }
  } catch (error) {
    logger.error(`Failed to notify card ${action}`, error)
  }
}

/** Inbox-only (navbar/push) notice when admin resumes a locked card. */
const notifyCardActivated = async (actor: LifecycleNotifyActor, profileId: string) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        userId: true,
        companyUserId: true,
        user: { select: { email: true, name: true, role: true } },
        companyUser: { select: { email: true, name: true, role: true } },
      },
    })
    if (!profile) return

    const userRole = profile.user?.role ? toApiRole(profile.user.role) : null
    const companyRole = profile.companyUser?.role ? toApiRole(profile.companyUser.role) : null
    const isCorporate = companyRole === 'corporate-owner' || userRole === 'corporate-owner'

    const cardEmail = profile.email?.trim().toLowerCase() || ''
    const ownerEmail = (profile.user?.email || '').trim().toLowerCase()
    const corporateOwnerEmail = (profile.companyUser?.email || (userRole === 'corporate-owner' ? ownerEmail : '') || '')
      .trim()
      .toLowerCase()

    const announcementEmails = isCorporate
      ? [...new Set([corporateOwnerEmail || ownerEmail].filter(Boolean))]
      : [...new Set([ownerEmail || cardEmail].filter(Boolean))]

    if (!announcementEmails.length) return

    const cardLabel = profile.name?.trim() || profile.slug?.trim() || 'your card'
    const bodyText = `Your card "${cardLabel}" has been reactivated by an administrator and is public again.`

    await announcementService.archiveLockNotices({ profileId: profile.id })

    try {
      await announcementService.create(actor, {
        type: 'success',
        kind: 'announcement',
        title: `Card resumed: ${cardLabel}`,
        body: bodyText,
        status: 'active',
        targetType: 'specific',
        targetEmails: announcementEmails,
        meta: { profileId: profile.id, action: 'activated', channel: 'inbox', sendPush: '1' },
      })
    } catch (error) {
      logger.error('Failed to create card activated announcement', error)
    }
  } catch (error) {
    logger.error('Failed to notify card activated', error)
  }
}

/** Controllers pass API roles (`super-admin`); tolerate Prisma enum values too. */
const isAdminRole = (role: string) => isStaffRole(role) || role === 'ADMIN' || role === 'SUPER_ADMIN'

const RECENT_ENGAGEMENT_LIMIT = 10

/** Setting keys that store media URLs shown on the admin vCards grid. */
const LIST_MEDIA_SETTING_KEYS = new Set(['profile_media_url', 'background_media_url'])

type ProfileCoreInclude = {
  gender: true
  maritalStatus: true
  profession: true
  status: true
  settings: true
  profileSettings: true
  socialLinks: true
  addresses: true
  attachments: { include: { attachmentType: true } }
}

type ProfileDetail = Prisma.ProfileGetPayload<{ include: ProfileCoreInclude }> & {
  education: unknown[]
  experiences: unknown[]
  services: Array<{
    title?: string | null
    imageUrl?: string | null
    attachmentUrl?: string | null
    attachmentName?: string | null
  }>
  portfolios: Array<{
    title?: string | null
    imageUrl?: string | null
    attachmentUrl?: string | null
    attachmentName?: string | null
  }>
  reviews: unknown[]
  skillTags: unknown[]
  galleries: Awaited<ReturnType<typeof listGalleriesForProfile>>
}

const withEmptyCollections = (profile: Record<string, unknown>): ProfileDetail =>
  ({
    ...profile,
    education: profile.education ?? [],
    experiences: profile.experiences ?? [],
    services: profile.services ?? [],
    portfolios: profile.portfolios ?? [],
    galleries: profile.galleries ?? [],
    reviews: profile.reviews ?? [],
    skillTags: profile.skillTags ?? [],
    addresses: profile.addresses ?? [],
    attachments: profile.attachments ?? [],
    settings: profile.settings ?? [],
    socialLinks: profile.socialLinks ?? [],
  }) as ProfileDetail

const withCanonicalCustomTabsSetting = (profile: ProfileDetail): ProfileDetail => {
  const galleries = fillMissingGalleryMedia(profile.galleries || [], profile.portfolios || [])
  return galleries === profile.galleries ? profile : { ...profile, galleries }
}

const listPortfoliosSafe = async (profileId: string) => {
  const full = await safePrismaQuery(
    () => prisma.portfolio.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }),
    null
  )
  if (full) return full
  const slim = await safePrismaQuery(
    () =>
      prisma.portfolio.findMany({
        where: { profileId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          profileId: true,
          title: true,
          description: true,
          status: true,
          sortOrder: true,
          url: true,
          imageUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    []
  )
  return slim.map((row) => ({ ...row, attachmentUrl: null, attachmentName: null, legacyId: null }))
}

const loadProfileCollections = async (profileId: string) => {
  const [education, experiences, services, portfolios, reviews, skillTags, galleries] = await Promise.all([
    safePrismaQuery(() => prisma.education.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    safePrismaQuery(() => prisma.experience.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    safePrismaQuery(() => prisma.service.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    listPortfoliosSafe(profileId),
    safePrismaQuery(() => prisma.review.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    safePrismaQuery(() => prisma.skillTag.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    listGalleriesForProfile(profileId),
  ])
  return { education, experiences, services, portfolios, reviews, skillTags, galleries }
}

const loadProfileRelations = async (profileId: string) => {
  const [settings, profileSettings, socialLinks, addresses, attachments] = await Promise.all([
    safePrismaQuery(() => prisma.setting.findMany({ where: { profileId } }), []),
    safePrismaQuery(() => prisma.profileSetting.findUnique({ where: { profileId } }), null),
    safePrismaQuery(() => prisma.socialLink.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }), []),
    safePrismaQuery(() => prisma.address.findMany({ where: { profileId } }), []),
    safePrismaQuery(
      () =>
        prisma.attachment.findMany({
          where: { profileId },
          include: { attachmentType: true },
        }),
      []
    ),
  ])
  return { settings, profileSettings, socialLinks, addresses, attachments }
}

const loadProfileRow = async (where: Prisma.ProfileWhereInput): Promise<Record<string, unknown> | null> => {
  const id = typeof where.id === 'string' ? where.id : null
  if (!id) {
    return safePrismaQuery(async () => {
      const row = await prisma.profile.findFirst({ where, select: { id: true } })
      if (!row) return null
      const full = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM "Profile" WHERE id = ${row.id} LIMIT 1
      `
      return full[0] ?? null
    }, null)
  }
  const or = where.OR
  if (Array.isArray(or) && or.length) {
    const userIds = or
      .map((clause) => {
        if (clause && typeof clause === 'object' && 'userId' in clause) return String(clause.userId)
        if (clause && typeof clause === 'object' && 'companyUserId' in clause) return String(clause.companyUserId)
        return ''
      })
      .filter(Boolean)
    const ownerId = userIds[0]
    if (ownerId) {
      const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM "Profile"
        WHERE id = ${id}
          AND ("userId" = ${ownerId} OR "companyUserId" = ${ownerId})
        LIMIT 1
      `
      return rows[0] ?? null
    }
  }
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "Profile" WHERE id = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

const attachProfileLookups = async (row: Record<string, unknown>) => {
  const genderId = typeof row.genderId === 'string' ? row.genderId : null
  const maritalStatusId = typeof row.maritalStatusId === 'string' ? row.maritalStatusId : null
  const professionId = typeof row.professionId === 'string' ? row.professionId : null
  const statusId = typeof row.statusId === 'string' ? row.statusId : null
  const [gender, maritalStatus, profession, status] = await Promise.all([
    genderId ? safePrismaQuery(() => prisma.gender.findUnique({ where: { id: genderId } }), null) : null,
    maritalStatusId
      ? safePrismaQuery(() => prisma.maritalStatus.findUnique({ where: { id: maritalStatusId } }), null)
      : null,
    professionId ? safePrismaQuery(() => prisma.profession.findUnique({ where: { id: professionId } }), null) : null,
    statusId ? safePrismaQuery(() => prisma.status.findUnique({ where: { id: statusId } }), null) : null,
  ])
  return { gender, maritalStatus, profession, status }
}

const loadProfileDetail = async (where: Prisma.ProfileWhereInput): Promise<ProfileDetail | null> => {
  try {
    const row = await loadProfileRow(where)
    if (!row?.id || typeof row.id !== 'string') return null
    const profileId = row.id
    const [lookups, relations, collections] = await Promise.all([
      attachProfileLookups(row),
      loadProfileRelations(profileId),
      loadProfileCollections(profileId),
    ])
    return withCanonicalCustomTabsSetting(
      withEmptyCollections({
        ...row,
        ...lookups,
        ...relations,
        ...collections,
      })
    )
  } catch (error) {
    logger.error('loadProfileDetail failed; returning empty collections', error)
    try {
      const row = await loadProfileRow(where)
      if (!row?.id || typeof row.id !== 'string') return null
      return withCanonicalCustomTabsSetting(
        withEmptyCollections({
          ...row,
          settings: [],
          socialLinks: [],
          addresses: [],
          attachments: [],
        })
      )
    } catch (inner) {
      logger.error('loadProfileDetail fallback failed', inner)
      return null
    }
  }
}

const syncCustomTabsJson = async (profileId: string, rawJson: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new AppError(400, 'custom_tabs_json must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new AppError(400, 'custom_tabs_json must be an array')
  const tabs = parsed.filter((tab): tab is Record<string, unknown> => Boolean(tab && typeof tab === 'object'))
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.customTab.findMany({ where: { profileId }, select: { id: true, key: true } })
      const retainedIds: string[] = []
      for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
        const input = tabs[tabIndex]
        const inputId = typeof input.id === 'string' ? input.id.trim() : ''
        const editorId = inputId.startsWith('custom-tab-') ? inputId : ''
        const matched =
          (editorId && existing.some((row) => row.id === editorId || row.key === editorId)) ||
          existing.some((row) => row.id === inputId)
        const matchedId = matched
          ? existing.find((row) => row.id === editorId || row.key === editorId || row.id === inputId)?.id || editorId
          : ''
        const label = String(input.label || 'Custom tab').trim() || 'Custom tab'
        const slug = slugify(label) || 'custom-tab'
        const tab = matchedId
          ? await tx.customTab.update({
              where: { id: matchedId },
              data: {
                label,
                sortOrder: tabIndex,
                slug,
                isEnabled: true,
                isPublic: true,
                status: '1',
                ...(editorId && !existing.some((row) => row.key === editorId && row.id !== matchedId)
                  ? { key: editorId }
                  : {}),
              },
            })
          : await tx.customTab.create({
              data: {
                ...(editorId ? { id: editorId } : {}),
                profileId,
                key: editorId || `custom-${slug}-${randomBytes(4).toString('hex')}`,
                label,
                slug,
                sortOrder: tabIndex,
                isEnabled: true,
                isPublic: true,
                status: '1',
              },
            })
        retainedIds.push(tab.id)
        await tx.customTabItem.deleteMany({ where: { customTabId: tab.id } })
        const items = Array.isArray(input.items) ? input.items : []
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const item = items[itemIndex]
          if (!item || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const itemId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined
          const mediaUrl = typeof row.mediaUrl === 'string' ? row.mediaUrl.trim() : ''
          const linkUrl = typeof row.url === 'string' ? row.url.trim() : ''
          await tx.customTabItem.create({
            data: {
              ...(itemId ? { id: itemId } : {}),
              customTabId: tab.id,
              profileId,
              title: row.title == null ? null : String(row.title),
              description: row.description == null ? null : String(row.description),
              url: linkUrl || null,
              featuredImage: mediaUrl || null,
              sortOrder: itemIndex,
              status: row.active === false ? '0' : '1',
              data: {
                mediaName: row.mediaName ?? null,
                mediaKind: row.mediaKind ?? null,
                gallery: Array.isArray(row.gallery) ? row.gallery : [],
              } as Prisma.InputJsonValue,
            },
          })
        }
      }
      await tx.customTab.deleteMany({
        where: retainedIds.length ? { profileId, id: { notIn: retainedIds } } : { profileId },
      })
    })
  } catch (error) {
    if (!isPrismaMissingTable(error)) throw error
  }
  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key: 'custom_tabs_json' } },
    create: { profileId, key: 'custom_tabs_json', value: rawJson },
    update: { value: rawJson },
  })
}

const listInclude = {
  status: { select: { id: true, name: true } },
  profession: true,
  profileSettings: true,
  settings: true,
  socialLinks: { orderBy: { sortOrder: 'asc' as const } },
  attachments: { include: { attachmentType: true } },
  _count: { select: { services: true, portfolios: true, posts: true } },
} satisfies Prisma.ProfileInclude

type ListProfileRow = Prisma.ProfileGetPayload<{ include: typeof listInclude }>

export type CardCapacity = {
  limit: number | null
  used: number
  remaining: number | null
  canCreate: boolean
}

export type ProfileListPage = {
  items: EnrichedListProfile[]
  total: number
  skip: number
  limit: number
  capacity: CardCapacity
}

type EnrichedListProfile = ListProfileRow & {
  clickCount: number
  saveCount: number
  shareCount: number
  socialClicks: Array<{ channel: string; label: string; clickCount: number }>
}

/** Absolutize avatar / media settings / attachment URLs for admin list responses. */
const absolutizeListProfile = (profile: ListProfileRow): ListProfileRow => {
  const legacyId = profile.legacyId ?? null
  const slug = profile.slug ?? null

  const avatar =
    ensureAbsoluteMediaUrl(profile.avatar, {
      docName: profile.avatar,
      attachmentTypeLegacyId: 13,
      attachmentTypeName: 'Profile Picture',
      profileLegacyId: legacyId,
      profileSlug: slug,
    }) || profile.avatar

  const settings = profile.settings.map((row) => {
    if (!LIST_MEDIA_SETTING_KEYS.has(row.key) || !row.value?.trim()) return row
    const isBackground = row.key === 'background_media_url'
    const absolute =
      ensureAbsoluteMediaUrl(row.value, {
        docName: row.value,
        attachmentTypeLegacyId: isBackground ? 9 : 13,
        attachmentTypeName: isBackground ? 'Background Video' : 'Profile Picture',
        profileLegacyId: legacyId,
        profileSlug: slug,
      }) || row.value
    return { ...row, value: absolute }
  })

  const attachments = profile.attachments.map((att) => {
    const absolute =
      ensureAbsoluteMediaUrl(att.url, {
        docName: att.docName,
        attachmentTypeLegacyId: att.attachmentType?.legacyId ?? null,
        attachmentTypeName: att.attachmentType?.name ?? null,
        profileLegacyId: legacyId,
        profileSlug: slug,
      }) || att.url
    return { ...att, url: absolute }
  })

  return { ...profile, avatar, settings, attachments }
}

export type ProfileListScope = 'created' | undefined

export type ListProfilesFilters = {
  scope?: ProfileListScope
  q?: string
  status?: 'all' | 'active' | 'inactive' | 'paused' | 'suspended' | 'draft'
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | 'viewCount'
  sortDir?: 'asc' | 'desc'
  skip?: number
  limit?: number
}

const isStaff = (role: string) => role === 'admin' || role === 'super-admin'

const resolveAdminPortfolioUserIds = async (userId: string, role: string): Promise<string[]> => {
  const ids = new Set<string>([userId])

  const invited = await prisma.user.findMany({
    where: {
      createdById: userId,
      role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
    },
    select: { id: true },
  })
  for (const row of invited) ids.add(row.id)

  if (role === 'super-admin' || role === 'SUPER_ADMIN') {
    const staff = await prisma.user.findMany({
      where: { role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] } },
      select: { id: true },
    })
    for (const row of staff) ids.add(row.id)
  }

  return [...ids]
}

/**
 * VBizMe Team Cards / scope=created for staff:
 * Exactly the eight curated portfolio slugs — nothing else.
 */
const resolveCreatedScopeWhere = async (userId: string, role: string): Promise<Prisma.ProfileWhereInput> => {
  if (!isAdminRole(role)) {
    return { createdById: userId }
  }

  return buildAdminTeamCardsScopeWhere()
}

const resolveOwnershipWhere = async (
  userId: string,
  role: string,
  scope?: ProfileListScope
): Promise<Prisma.ProfileWhereInput> => {
  if (scope === 'created') return resolveCreatedScopeWhere(userId, role)
  if (isAdminRole(role) || isStaff(role)) return {}
  return { OR: [{ userId }, { companyUserId: userId }] }
}

const getCardCapacity = async (userId: string, role: string): Promise<CardCapacity> => {
  const where = await resolveOwnershipWhere(userId, role)
  if (isStaff(role) || isAdminRole(role)) {
    const used = await prisma.profile.count({ where })
    return { limit: null, used, remaining: null, canCreate: true }
  }

  if (role === 'corporate-owner' || role === 'vcard-owner') {
    await subscriptionService.ensureOwnerStarterSubscription(userId, role)
  }

  const [entitlements, used] = await Promise.all([
    getEffectiveEntitlements(userId, role),
    prisma.profile.count({ where }),
  ])
  const limit = entitlements.limits.maxCards
  return {
    limit,
    used,
    remaining: remainingCardSlots(used, limit),
    canCreate: canCreateAnotherCard(used, limit),
  }
}

const assertCanCreateCard = async (userId: string, role: string) => {
  if (isStaff(role) || isAdminRole(role)) return
  const capacity = await getCardCapacity(userId, role)
  if (capacity.canCreate) return

  const entitlements = await getEffectiveEntitlements(userId, role)
  const { used, limit, remaining } = capacity
  const corporate = entitlements.ownerMode === 'corporate'
  const noCapacity = limit != null && limit <= 0
  const message = noCapacity
    ? 'No active package with card capacity. Upgrade your package to create cards.'
    : corporate
      ? `Corporate card limit reached (${used}/${limit}). Existing cards were not removed.`
      : `Card limit reached (${used}/${limit}). Upgrade your package to create more cards.`

  throw featureLimitReachedError(
    message,
    { limit, used, remaining },
    {
      code: corporate ? CORPORATE_CARD_LIMIT_REACHED : FEATURE_LIMIT_REACHED,
    }
  )
}

const buildListFiltersWhere = async (
  userId: string,
  role: string,
  filters: ListProfilesFilters
): Promise<Prisma.ProfileWhereInput> => {
  const where: Prisma.ProfileWhereInput = { ...(await resolveOwnershipWhere(userId, role, filters.scope)) }

  const q = filters.q?.trim()
  if (q) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { companyName: { contains: q, mode: 'insensitive' } },
          { designation: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
        ],
      },
    ]
  }

  const status = filters.status && filters.status !== 'all' ? filters.status : undefined
  if (status === 'draft') {
    where.isDraft = true
  } else if (status === 'active') {
    where.isDraft = false
    where.isPublic = true
    where.NOT = {
      status: { name: { in: ['paused', 'suspended', 'inactive'], mode: 'insensitive' } },
    }
  } else if (status === 'inactive') {
    where.isDraft = false
    where.OR = [
      { status: { name: { equals: 'inactive', mode: 'insensitive' } } },
      {
        isPublic: false,
        NOT: { status: { name: { in: ['paused', 'suspended', 'draft'], mode: 'insensitive' } } },
      },
    ]
  } else if (status === 'paused') {
    where.status = { name: { equals: 'paused', mode: 'insensitive' } }
  } else if (status === 'suspended') {
    where.status = { name: { equals: 'suspended', mode: 'insensitive' } }
  }

  return where
}

const listForUser = async (userId: string, role: string, scope?: ProfileListScope) => {
  const profiles = await prisma.profile.findMany({
    where: await resolveOwnershipWhere(userId, role, scope),
    include: listInclude,
    orderBy: { updatedAt: 'desc' },
  })
  const metricsByProfile = await loadProfileEngagementMetrics(profiles.map((p) => p.id))
  return profiles.map((profile) => {
    const base = absolutizeListProfile(profile)
    const metrics = metricsByProfile.get(profile.id)
    return {
      ...base,
      clickCount: metrics?.clickCount ?? 0,
      saveCount: metrics?.saveCount ?? 0,
      shareCount: metrics?.shareCount ?? 0,
      socialClicks: metrics?.socialClicks ?? [],
    } satisfies EnrichedListProfile
  })
}

/** Lightweight card rows for dashboard KPIs — never uses the heavy list include. */
const listAnalyticsProfiles = async (userId: string, role: string, scope?: ProfileListScope) => {
  return prisma.profile.findMany({
    where: await resolveOwnershipWhere(userId, role, scope),
    select: {
      id: true,
      name: true,
      slug: true,
      viewCount: true,
      isDraft: true,
      status: { select: { name: true } },
      _count: { select: { services: true, portfolios: true, posts: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
}

const listOwnedProfileIds = async (userId: string, role: string, scope?: ProfileListScope) => {
  const rows = await prisma.profile.findMany({
    where: await resolveOwnershipWhere(userId, role, scope),
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

const isActiveAnalyticsCard = (statusName?: string | null) => {
  const status = (statusName || '').trim().toLowerCase()
  return !status || status === 'active'
}

const listProfilesPage = async (
  userId: string,
  role: string,
  filters: ListProfilesFilters = {}
): Promise<ProfileListPage> => {
  const skip = filters.skip ?? 0
  const limit = filters.limit ?? 24
  const sortBy = filters.sortBy ?? 'updatedAt'
  const sortDir = filters.sortDir ?? 'desc'
  const where = await buildListFiltersWhere(userId, role, filters)

  const [rows, total, capacity] = await Promise.all([
    prisma.profile.findMany({
      where,
      include: listInclude,
      orderBy: { [sortBy]: sortDir },
      skip,
      take: limit,
    }),
    prisma.profile.count({ where }),
    getCardCapacity(userId, role),
  ])

  const metricsByProfile = await loadProfileEngagementMetrics(rows.map((p) => p.id))

  return {
    items: rows.map((profile) => {
      const base = absolutizeListProfile(profile)
      const metrics = metricsByProfile.get(profile.id)
      return {
        ...base,
        clickCount: metrics?.clickCount ?? 0,
        saveCount: metrics?.saveCount ?? 0,
        shareCount: metrics?.shareCount ?? 0,
        socialClicks: metrics?.socialClicks ?? [],
      } satisfies EnrichedListProfile
    }),
    total,
    skip,
    limit,
    capacity,
  }
}

const getOwned = async (profileId: string, userId: string, role: string) => {
  const profile = isAdminRole(role)
    ? await loadProfileDetail({ id: profileId })
    : await loadProfileDetail({ id: profileId, OR: [{ userId }, { companyUserId: userId }] })
  if (!profile) throw new AppError(404, 'Profile not found')
  return profile
}

/** Ownership + status only — never load collections. Used by tab/post writes and nested GETs. */
const getOwnedLite = async (profileId: string, userId: string, role: string) => {
  const where: Prisma.ProfileWhereInput = isAdminRole(role)
    ? { id: profileId }
    : { id: profileId, OR: [{ userId }, { companyUserId: userId }] }

  const lite = await safePrismaQuery(
    () =>
      prisma.profile.findFirst({
        where,
        select: {
          id: true,
          userId: true,
          companyUserId: true,
          name: true,
          companyName: true,
          status: { select: { id: true, name: true } },
        },
      }),
    null
  )
  if (lite) return lite

  const row = await loadProfileRow(where)
  if (!row?.id || typeof row.id !== 'string') throw new AppError(404, 'Profile not found')
  if (!isAdminRole(role)) {
    const ownerId = typeof row.userId === 'string' ? row.userId : ''
    const companyId = typeof row.companyUserId === 'string' ? row.companyUserId : ''
    if (ownerId !== userId && companyId !== userId) throw new AppError(404, 'Profile not found')
  }
  const lookups = await attachProfileLookups(row)
  return {
    id: row.id,
    userId: typeof row.userId === 'string' ? row.userId : null,
    companyUserId: typeof row.companyUserId === 'string' ? row.companyUserId : null,
    name: typeof row.name === 'string' ? row.name : null,
    companyName: typeof row.companyName === 'string' ? row.companyName : null,
    status: lookups.status,
  }
}

const assertOwnerAccountCanMutateVcards = async (userId: string, role: string) => {
  if (isAdminRole(role)) return
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountStatus: true, isActive: true, deletedAt: true },
  })
  if (!user || user.deletedAt) {
    throw new AppError(403, 'Account is not available')
  }
  const status = user.accountStatus ?? (user.isActive ? 'ACTIVE' : 'PAUSED')
  if (status === 'PAUSED') {
    throw new AppError(403, 'Account is paused. You cannot create or edit vCards. Please contact support.')
  }
  if (status === 'SUSPENDED') {
    throw new AppError(403, 'Account is suspended. Contact an administrator to restore access.')
  }
}

const assertOwnerCanMutateCard = (profile: { status?: { name?: string | null } | null }, role: string) => {
  if (isAdminRole(role)) return
  if (normalizeCardStatusName(profile.status?.name) === 'suspended') {
    throw new AppError(403, 'This card is suspended. Contact an administrator to restore access.')
  }
}

const getOwnedForWrite = async (profileId: string, userId: string, role: string) => {
  await assertOwnerAccountCanMutateVcards(userId, role)
  const profile = await getOwnedLite(profileId, userId, role)
  assertOwnerCanMutateCard(profile, role)
  return profile
}

const ensureUniqueSlug = async (base: string, excludeId?: string) => {
  let slug = slugify(base) || `card-${Date.now()}`
  let i = 0
  while (true) {
    const existing = await prisma.profile.findFirst({
      where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    })
    if (!existing) return slug
    i += 1
    slug = `${slugify(base)}-${i}`
  }
}

const checkSlugAvailability = async (rawSlug: string, excludeId?: string) => {
  const slug = slugify(rawSlug)
  if (!slug) {
    return { slug: '', available: false, suggestion: '' }
  }

  const existing = await prisma.profile.findFirst({
    where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
  })

  if (!existing) {
    return { slug, available: true, suggestion: slug }
  }

  const suggestion = await ensureUniqueSlug(slug, excludeId)
  return { slug, available: false, suggestion }
}

const asOptionalString = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  const trimmed = String(value).trim()
  return trimmed || undefined
}

const assertCardIdentityForCreate = (input: Pick<CardActivationInput, 'email' | 'phone' | 'dob'>) => {
  const issue = collectCardCreationIssues(input)[0]
  if (!issue) return
  throw new AppError(400, cardCreationIssueMessage(issue))
}

const assertCreateContactsAvailable = async (email: unknown, phone: unknown) => {
  const normalizedEmail = normalizeCardEmail(email)
  const digits = normalizeCardPhone(phone)

  if (normalizedEmail) {
    const hit = await prisma.profile.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: { email: true, phone: true },
    })
    if (hit && findCreateContactConflict({ email, phone }, hit) === 'email') {
      throw new AppError(409, createContactConflictMessage('email'))
    }
  }

  if (!digits) return

  const hits = await prisma.$queryRaw<Array<{ email: string | null; phone: string | null }>>`
    SELECT email, phone
    FROM "Profile"
    WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ${digits}
    LIMIT 1
  `
  const phoneHit = hits[0]
  if (phoneHit && findCreateContactConflict({ email, phone }, phoneHit) === 'phone') {
    throw new AppError(409, createContactConflictMessage('phone'))
  }
}

const assertCardCanActivate = (input: CardActivationInput) => {
  const issues = collectCardActivationIssues(input)
  if (issues.length) throw new AppError(422, cardActivationIssueMessage(issues))
}

/** Upsert the primary Address row used for street address (line1) + zip. */
const upsertPrimaryAddress = async (
  profileId: string,
  fields: {
    address?: unknown
    zipCode?: unknown
  }
) => {
  const addressProvided = Object.prototype.hasOwnProperty.call(fields, 'address')
  const zipProvided = Object.prototype.hasOwnProperty.call(fields, 'zipCode')
  const line1 = addressProvided ? (asOptionalString(fields.address) ?? null) : undefined
  const zipCode = zipProvided ? (asOptionalString(fields.zipCode) ?? null) : undefined

  if (line1 === undefined && zipCode === undefined) return

  const existing =
    (await prisma.address.findFirst({ where: { profileId, isPrimary: true } })) ||
    (await prisma.address.findFirst({ where: { profileId }, orderBy: { createdAt: 'asc' } }))

  const data = {
    ...(line1 !== undefined ? { line1 } : {}),
    ...(zipCode !== undefined ? { zipCode } : {}),
    isPrimary: true,
  }

  if (existing) {
    await prisma.address.update({ where: { id: existing.id }, data })
  } else {
    await prisma.address.create({
      data: {
        profileId,
        line1: line1 ?? null,
        zipCode: zipCode ?? null,
        isPrimary: true,
      },
    })
  }
}

const create = async (
  userId: string,
  role: string,
  input: {
    name: string
    email?: string
    slug?: string
    companyName?: string
    designation?: string
    phone?: string
    whatsapp?: string
    website?: string
    address?: string
    about?: string
    prof?: string
    isPublic?: boolean
    isDraft?: boolean
    template?: string
    facebook?: string
    instagram?: string
    twitter?: string
    tiktok?: string
    youtube?: string
    linkedin?: string
    ownerUserId?: string
    creationKey?: string
    settings?: Record<string, string>
    profileSettings?: {
      profileTemplate?: string
      layoutStyle?: string
      buttonStyle?: string
      cornerStyle?: string
      themeConfig?: unknown
    }
    [key: string]: unknown
  }
) => {
  const actor = await prisma.user.findUnique({ where: { id: userId } })
  if (!actor) throw new AppError(404, 'User not found')

  await assertOwnerAccountCanMutateVcards(userId, role)

  const {
    ownerUserId: requestedOwnerUserId,
    creationKey: creationKeyRaw,
    settings,
    profileSettings,
    skipCreateContactRules: skipCreateContactRulesRaw,
    ...raw
  } = input
  const creationKey = typeof creationKeyRaw === 'string' ? creationKeyRaw.trim() : ''
  const normalizedSettings = settings ? normalizeSeoSettings(settings) : undefined

  if (creationKey) {
    const existing = await prisma.profile.findFirst({
      where: { creationKey, createdById: userId },
      select: { id: true },
    })
    if (existing) {
      const detail = await loadProfileDetail({ id: existing.id })
      if (!detail) throw new AppError(404, 'Profile not found')
      return detail
    }
  }

  let profileOwnerId = userId
  let profileOwnerEmail = actor.email
  let createdById = userId
  // Admin self-created cards stay on the admin/company portfolio (My Cards).
  let companyUserId: string | undefined = isAdminRole(actor.role) || isAdminRole(role) ? userId : undefined
  let capacityUserId = userId
  let capacityRole = role

  const assignOwnerId = isStaff(role) && typeof requestedOwnerUserId === 'string' ? requestedOwnerUserId.trim() : ''

  if (assignOwnerId) {
    const target = await prisma.user.findFirst({
      where: { id: assignOwnerId, deletedAt: null },
    })
    if (!target) throw new AppError(404, 'Owner user not found')

    const targetApiRole = toApiRole(target.role)
    if (!target.isActive || target.accountStatus !== AccountStatus.ACTIVE) {
      throw new AppError(400, 'Owner account is not active')
    }

    if (isStaffRole(targetApiRole)) {
      const portfolioIds = await resolveAdminPortfolioUserIds(userId, role)
      if (!portfolioIds.includes(target.id)) {
        throw new AppError(400, 'Owner must be you or a team member in your portfolio')
      }
      profileOwnerId = target.id
      profileOwnerEmail = target.email
      createdById = userId
      companyUserId = userId
      capacityUserId = userId
      capacityRole = role
    } else if (targetApiRole === 'vcard-owner' || targetApiRole === 'corporate-owner') {
      profileOwnerId = target.id
      profileOwnerEmail = target.email
      createdById = userId
      const targetEntitlements = await getEffectiveEntitlements(target.id, targetApiRole)
      companyUserId = targetEntitlements.ownerMode === 'corporate' ? target.id : undefined
      capacityUserId = target.id
      capacityRole = targetApiRole
    } else {
      throw new AppError(400, 'Owner must be a single or corporate card owner')
    }
  }

  await assertCanCreateCard(capacityUserId, capacityRole)

  const slug = await ensureUniqueSlug(String(raw.slug || raw.name))
  const resolvedEmail =
    'email' in raw ? (typeof raw.email === 'string' ? raw.email.trim() : '') : profileOwnerEmail.trim()
  const initialLifecycle = resolveInitialCardLifecycle({
    isDraft: raw.isDraft as boolean | undefined,
    isPublic: raw.isPublic as boolean | undefined,
  })
  const skipCreateContactRules = Boolean(skipCreateContactRulesRaw)
  if (!skipCreateContactRules) {
    assertCardIdentityForCreate({
      email: resolvedEmail,
      phone: raw.phone,
      dob: raw.dob,
    })
    await assertCreateContactsAvailable(resolvedEmail, raw.phone)
  }
  if (initialLifecycle.statusName === 'active') {
    assertCardCanActivate({
      slug,
      name: raw.name,
      email: resolvedEmail,
      dob: raw.dob,
      phone: raw.phone,
    })
  }
  const initialStatus = await ensureStatusByName(initialLifecycle.statusName)
  let profile: { id: string }
  try {
    profile = await prisma.profile.create({
      data: {
        userId: profileOwnerId,
        createdById,
        companyUserId,
        creationKey: creationKey || undefined,
        name: String(raw.name),
        email: resolvedEmail,
        slug,
        companyName: raw.companyName as string | undefined,
        designation: raw.designation as string | undefined,
        phone: raw.phone as string | undefined,
        whatsapp: raw.whatsapp as string | undefined,
        website: raw.website as string | undefined,
        address: raw.address as string | undefined,
        city: asOptionalString(raw.city),
        state: asOptionalString(raw.state),
        zipCode: raw.zipCode as string | undefined,
        about: raw.about as string | undefined,
        prof: raw.prof as string | undefined,
        dob: raw.dob ? new Date(String(raw.dob)) : undefined,
        template: (raw.template as string) || 'default',
        themeConfig: (profileSettings?.themeConfig ?? raw.themeConfig) as object | undefined,
        statusId: initialStatus.id,
        isPublic: initialLifecycle.isPublic,
        isDraft: initialLifecycle.isDraft,
        facebook: raw.facebook as string | undefined,
        instagram: raw.instagram as string | undefined,
        twitter: raw.twitter as string | undefined,
        tiktok: raw.tiktok as string | undefined,
        youtube: raw.youtube as string | undefined,
        linkedin: raw.linkedin as string | undefined,
        profileSettings: {
          create: {
            profileTemplate:
              profileSettings?.profileTemplate ||
              (raw.template === 'dynamic' ? 'v1' : raw.template === 'classic' ? 'v2' : 'v3'),
            layoutStyle: profileSettings?.layoutStyle,
            buttonStyle: profileSettings?.buttonStyle,
            cornerStyle: profileSettings?.cornerStyle,
            themeConfig: profileSettings?.themeConfig as object | undefined,
          },
        },
      },
      select: { id: true },
    })
  } catch (error) {
    if (!creationKey || !isPrismaUniqueConstraint(error, 'creationKey')) throw error
    const existing = await prisma.profile.findFirst({
      where: { creationKey, createdById: userId },
      select: { id: true },
    })
    if (!existing) throw error
    const detail = await loadProfileDetail({ id: existing.id })
    if (!detail) throw new AppError(404, 'Profile not found')
    return detail
  }

  await upsertPrimaryAddress(profile.id, {
    address: raw.address,
    zipCode: raw.zipCode,
  })

  if (normalizedSettings) {
    await Promise.all(
      Object.entries(normalizedSettings).map(([key, value]) =>
        prisma.setting.create({
          data: { profileId: profile.id, key, value },
        })
      )
    )
    if (typeof normalizedSettings.custom_tabs_json === 'string') {
      await syncCustomTabsJson(profile.id, normalizedSettings.custom_tabs_json)
    }
  }

  const created = await loadProfileDetail({ id: profile.id })
  if (!created) throw new AppError(404, 'Profile not found')
  return created
}

const clonePrimaryProfileCollections = async (
  sourceProfileId: string,
  targetProfileId: string,
  customTabIdMap?: Map<string, string>
) => {
  const listModels = [
    'education',
    'experience',
    'service',
    'portfolio',
    'review',
    'skillTag',
    'socialLink',
    'blog',
    'tabItem',
    'gallery',
    'video',
    'bbbAccreditation',
    'licensing',
    'dcp',
    'certificateLicense',
    'faq',
    'calendarSection',
    'propertyListing',
    'profileEvent',
    'mediaPress',
    'missionStatement',
    'menuSection',
    'announcementDirect',
    'joinMyTeam',
    'booking',
    'additionalService',
    'videoLink',
    'inventory',
    'homeSolar',
    'resiliencyProduct',
    'breakfast',
    'lunch',
    'dinner',
    'product',
    'salesPerson',
    'teamMember',
    'client',
    'generalPost',
    'insuranceLicense',
    'videoExplainer',
    'address',
  ] as const

  type ListDelegate = {
    findMany: (args: {
      where: { profileId: string }
      select?: Record<string, boolean>
    }) => Promise<Array<Record<string, unknown>>>
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>
  }

  const pascalModel = (model: string) => model.charAt(0).toUpperCase() + model.slice(1)

  const rememberAttachable = (
    map: Record<string, Map<string, string>>,
    type: string,
    sourceId: string,
    createdId: string
  ) => {
    if (!map[type]) map[type] = new Map()
    map[type].set(sourceId, createdId)
  }

  const findManyCloneRows = async (
    delegate: ListDelegate,
    profileId: string
  ): Promise<Array<Record<string, unknown>>> => {
    try {
      return await delegate.findMany({ where: { profileId } })
    } catch (error) {
      if (isPrismaMissingTable(error)) return []
      if (!isPrismaSchemaDrift(error) && !isPrismaUnknownArgument(error)) throw error
    }

    const select: Record<string, boolean> = { ...POST_STYLE_CLONE_SELECT }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return await delegate.findMany({ where: { profileId }, select })
      } catch (error) {
        if (isPrismaMissingTable(error)) return []
        const unknown = unknownPrismaSelectFields(error)
        if (!unknown.length) break
        for (const key of unknown) delete select[key]
        if (!Object.keys(select).length) return []
      }
    }

    try {
      return await delegate.findMany({
        where: { profileId },
        select: {
          id: true,
          profileId: true,
          title: true,
          description: true,
          url: true,
          featuredImage: true,
          status: true,
          sortOrder: true,
        },
      })
    } catch {
      return []
    }
  }

  const createClonedRow = async (delegate: ListDelegate, data: Record<string, unknown>) => {
    let payload = data
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await delegate.create({ data: payload })
      } catch (error) {
        const unknownArgs = [...unknownPrismaCreateArgs(error), ...unknownPrismaSelectFields(error)]
        if (unknownArgs.length) {
          payload = omitCloneKeys(payload, unknownArgs)
          continue
        }
        if (isPrismaTypeMismatch(error) && 'status' in payload) {
          const status = payload.status
          const nextStatus = typeof status === 'number' ? String(status) : Number(status)
          if (nextStatus === status || (typeof nextStatus === 'number' && Number.isNaN(nextStatus))) throw error
          payload = { ...payload, status: nextStatus }
          continue
        }
        throw error
      }
    }
    return delegate.create({ data: payload })
  }

  const cloneListRow = async (
    delegate: ListDelegate,
    model: string,
    row: Record<string, unknown>,
    attachableIdMap: Record<string, Map<string, string>>
  ) => {
    if (row.deletedAt) return
    const cloned = cloneRecord(row)
    if ('status' in row && cloned.status === undefined) {
      cloned.status = typeof row.status === 'number' ? 1 : '1'
    }
    if ('sortOrder' in row && cloned.sortOrder === undefined) {
      cloned.sortOrder = 0
    }
    try {
      const created = (await createClonedRow(delegate, {
        ...cloned,
        profileId: targetProfileId,
      })) as { id?: string }
      const sourceId = typeof row.id === 'string' ? row.id : ''
      if (sourceId && created?.id) rememberAttachable(attachableIdMap, pascalModel(model), sourceId, created.id)
    } catch (error) {
      logger.error(`duplicate clone failed for ${model}`, error)
    }
  }

  await prisma.$transaction(
    async (tx) => {
      const client = tx as unknown as Record<string, ListDelegate>
      const readClient = prisma as unknown as Record<string, ListDelegate>
      const attachableIdMap: Record<string, Map<string, string>> = {
        Service: new Map(),
        Portfolio: new Map(),
        Post: new Map(),
        Gallery: new Map(),
        Video: new Map(),
        VideoLink: new Map(),
        VideoExplainer: new Map(),
        Review: new Map(),
        Client: new Map(),
      }

      await tx.address.deleteMany({ where: { profileId: targetProfileId } })

      for (const model of listModels) {
        const writer = client[model]
        const reader = readClient[model]
        if (!writer?.create) continue
        if (model === 'gallery') {
          let galleries: Array<Record<string, unknown>> = (await listGalleriesForProfile(
            sourceProfileId,
            200
          )) as unknown as Array<Record<string, unknown>>
          if (!galleries.length && reader) {
            galleries = await findManyCloneRows(reader, sourceProfileId)
          }
          for (const row of galleries) {
            await cloneListRow(writer, model, row, attachableIdMap)
          }
          continue
        }
        if (!reader) continue
        const rows = await findManyCloneRows(reader, sourceProfileId)
        for (const row of rows) {
          await cloneListRow(writer, model, row, attachableIdMap)
        }
      }

      const aboutMe = await tx.aboutMe.findUnique({ where: { profileId: sourceProfileId } })
      if (aboutMe) {
        await tx.aboutMe.create({
          data: {
            profileId: targetProfileId,
            title: aboutMe.title,
            description: aboutMe.description,
            featuredMediaUrl: aboutMe.featuredMediaUrl,
            status: aboutMe.status,
          },
        })
      }

      const whyChooseUs = await tx.whyChooseUs.findUnique({ where: { profileId: sourceProfileId } }).catch(() => null)
      if (whyChooseUs) {
        const cloned = cloneRecord(whyChooseUs as unknown as Record<string, unknown>)
        if ('status' in whyChooseUs && cloned.status === undefined) cloned.status = '1'
        await createClonedRow(tx.whyChooseUs as unknown as ListDelegate, {
          ...cloned,
          profileId: targetProfileId,
        })
      }

      const sourceTabs = await tx.customTab.findMany({
        where: { profileId: sourceProfileId },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { sortOrder: 'asc' },
      })
      const targetTabs = await tx.customTab.findMany({
        where: { profileId: targetProfileId },
        orderBy: { sortOrder: 'asc' },
      })
      const unusedTargets = [...targetTabs]

      const takeTarget = (match: (tab: (typeof targetTabs)[number]) => boolean) => {
        const index = unusedTargets.findIndex(match)
        if (index < 0) return null
        return unusedTargets.splice(index, 1)[0]
      }

      for (const sourceTab of sourceTabs) {
        const remappedKey = customTabIdMap?.get(sourceTab.key)
        const targetTab =
          (remappedKey ? takeTarget((tab) => tab.key === remappedKey) : null) ||
          takeTarget((tab) => tab.key === sourceTab.key) ||
          takeTarget((tab) => tab.label === sourceTab.label) ||
          unusedTargets.shift() ||
          (await tx.customTab.create({
            data: {
              profileId: targetProfileId,
              key: sourceTab.key.startsWith('custom-tab-')
                ? `custom-tab-${randomBytes(6).toString('hex')}`
                : sourceTab.key,
              label: sourceTab.label,
              slug: sourceTab.slug,
              description: sourceTab.description,
              icon: sourceTab.icon,
              sortOrder: sourceTab.sortOrder,
              isEnabled: sourceTab.isEnabled,
              isPublic: sourceTab.isPublic,
              status: sourceTab.status,
              layoutType: sourceTab.layoutType,
              settings: sourceTab.settings === null ? undefined : (sourceTab.settings as Prisma.InputJsonValue),
            },
          }))

        await tx.customTabItem.deleteMany({ where: { customTabId: targetTab.id } })
        for (const item of sourceTab.items) {
          await tx.customTabItem.create({
            data: {
              customTabId: targetTab.id,
              profileId: targetProfileId,
              title: item.title,
              description: item.description,
              url: item.url,
              featuredImage: item.featuredImage,
              sortOrder: item.sortOrder,
              status: item.status,
              data: item.data === null ? undefined : (item.data as Prisma.InputJsonValue),
            },
          })
        }
      }

      const sourceMenus = await tx.menu.findMany({
        where: { profileId: sourceProfileId },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      })
      for (const menu of sourceMenus) {
        const createdMenu = await tx.menu.create({
          data: { profileId: targetProfileId, name: menu.name },
        })
        for (const item of menu.items) {
          await tx.menuItem.create({
            data: {
              menuId: createdMenu.id,
              title: item.title,
              url: item.url,
              price: item.price,
              description: item.description,
              sortOrder: item.sortOrder,
            },
          })
        }
      }

      const sourcePosts = await tx.post.findMany({
        where: { profileId: sourceProfileId, deletedAt: null },
        include: { metas: true },
      })
      for (const post of sourcePosts) {
        const createdPost = await tx.post.create({
          data: {
            profileId: targetProfileId,
            postTypeId: post.postTypeId,
            title: post.title,
            description: post.description,
            status: post.status,
            url: post.url,
            featuredImage: post.featuredImage,
            sortOrder: post.sortOrder,
          },
        })
        attachableIdMap.Post.set(post.id, createdPost.id)
        for (const meta of post.metas) {
          await tx.postMeta.create({
            data: { postId: createdPost.id, metaKey: meta.metaKey, metaValue: meta.metaValue },
          })
        }
      }

      const attachments = await tx.attachment.findMany({ where: { profileId: sourceProfileId } })
      for (const attachment of attachments) {
        const type = attachment.attachableType
        const typeKey = type.split(/\\|\//).pop() || type
        let postId = attachment.postId
        let attachableId: string
        if (type === 'Profile' || typeKey === 'Profile') {
          attachableId = targetProfileId
        } else {
          const mapped =
            attachableIdMap[type]?.get(attachment.attachableId) ||
            attachableIdMap[typeKey]?.get(attachment.attachableId)
          if (!mapped) continue
          attachableId = mapped
          if (type === 'Post' || typeKey === 'Post') postId = mapped
        }
        if (postId && type !== 'Post' && typeKey !== 'Post') {
          postId = attachableIdMap.Post.get(postId) || null
        }
        try {
          await tx.attachment.create({
            data: {
              attachmentTypeId: attachment.attachmentTypeId,
              attachableType: type,
              attachableId,
              profileId: targetProfileId,
              postId: type === 'Post' || typeKey === 'Post' ? attachableId : postId,
              docName: attachment.docName,
              url: attachment.url,
              publicId: attachment.publicId,
              resourceType: attachment.resourceType,
              format: attachment.format,
              bytes: attachment.bytes,
              extension: attachment.extension,
              mimeType: attachment.mimeType,
            },
          })
        } catch (error) {
          logger.error('duplicate clone failed for attachment', error)
        }
      }

      const assistantConfig = await tx.profileAssistantConfig.findUnique({ where: { profileId: sourceProfileId } })
      if (assistantConfig) {
        await tx.profileAssistantConfig.upsert({
          where: { profileId: targetProfileId },
          create: {
            profileId: targetProfileId,
            enabled: assistantConfig.enabled,
            businessBrief: assistantConfig.businessBrief,
            systemPromptAddendum: assistantConfig.systemPromptAddendum,
          },
          update: {
            enabled: assistantConfig.enabled,
            businessBrief: assistantConfig.businessBrief,
            systemPromptAddendum: assistantConfig.systemPromptAddendum,
          },
        })
      }

      const knowledge = await tx.profileAssistantKnowledge.findMany({ where: { profileId: sourceProfileId } })
      for (const item of knowledge) {
        await tx.profileAssistantKnowledge.create({
          data: {
            profileId: targetProfileId,
            sourceType: item.sourceType,
            tabScope: item.tabScope,
            label: item.label,
            sha256: item.sha256,
            extractedText: item.extractedText,
            extractionMethod: item.extractionMethod,
          },
        })
      }
    },
    { timeout: 60_000, maxWait: 15_000 }
  )
}

const duplicate = async (profileId: string, userId: string, role: string) => {
  const source = await getOwned(profileId, userId, role)
  const customTabIdMap = new Map<string, string>()
  const settings = remapDuplicatedCardSettings(settingsMapFromRows(source.settings), profileId, customTabIdMap)
  const ownership = duplicatedCardOwnership(
    {
      userId: typeof source.userId === 'string' ? source.userId : null,
      companyUserId: typeof source.companyUserId === 'string' ? source.companyUserId : null,
      createdById: typeof source.createdById === 'string' ? source.createdById : null,
    },
    userId
  )
  const created = await create(userId, role, {
    name: '',
    email: '',
    skipCreateContactRules: true,
    ownerUserId: ownership.userId || undefined,
    companyName: source.companyName || undefined,
    designation: source.designation || undefined,
    website: source.website || undefined,
    address: source.address || undefined,
    city: source.city || undefined,
    state: source.state || undefined,
    zipCode: source.zipCode || undefined,
    about: source.about || undefined,
    prof: source.prof || undefined,
    template: source.template,
    themeConfig: source.themeConfig || undefined,
    facebook: source.facebook || undefined,
    instagram: source.instagram || undefined,
    twitter: source.twitter || undefined,
    tiktok: source.tiktok || undefined,
    youtube: source.youtube || undefined,
    linkedin: source.linkedin || undefined,
    isDraft: true,
    isPublic: false,
    settings,
    profileSettings: source.profileSettings
      ? {
          profileTemplate: source.profileSettings.profileTemplate,
          layoutStyle: source.profileSettings.layoutStyle || undefined,
          buttonStyle: source.profileSettings.buttonStyle || undefined,
          cornerStyle: source.profileSettings.cornerStyle || undefined,
          themeConfig: source.profileSettings.themeConfig || undefined,
        }
      : undefined,
  })

  try {
    await prisma.profile.update({
      where: { id: created.id },
      data: {
        ...blankDuplicatedIdentityFields(),
        ...ownership,
        avatar: source.avatar,
        colorCode: source.colorCode,
        rumble: source.rumble,
        truth: source.truth,
        pinterest: source.pinterest,
        isEmploy: source.isEmploy,
        professionId: source.profession?.id ?? (typeof source.professionId === 'string' ? source.professionId : null),
        whatsapp: source.whatsapp,
        countryCode: source.countryCode,
        maritalStatusId:
          source.maritalStatus?.id ?? (typeof source.maritalStatusId === 'string' ? source.maritalStatusId : null),
      },
    })
    await clonePrimaryProfileCollections(profileId, created.id, customTabIdMap)
  } catch (error) {
    await prisma.profile.delete({ where: { id: created.id } }).catch(() => undefined)
    throw error
  }

  const duplicated = await loadProfileDetail({ id: created.id })
  if (!duplicated) throw new AppError(404, 'Duplicated profile not found')
  return duplicated
}

const update = async (
  profileId: string,
  userId: string,
  role: string,
  data: {
    settings?: Record<string, string>
    profileSettings?: {
      profileTemplate?: string
      layoutStyle?: string
      buttonStyle?: string
      cornerStyle?: string
      themeConfig?: unknown
    }
    [key: string]: unknown
  }
) => {
  const owned = await getOwnedLite(profileId, userId, role)
  const staff = isAdminRole(role)
  const currentName = normalizeCardStatusName(owned.status?.name)

  await assertOwnerAccountCanMutateVcards(userId, role)

  if (!staff && currentName === 'suspended') {
    throw new AppError(403, 'This card is suspended. Contact an administrator to restore access.')
  }

  const { settings, profileSettings, status: rawStatus, ...raw } = data
  const normalizedSettings = settings ? normalizeSeoSettings(settings) : undefined
  const profileData = { ...raw } as Prisma.ProfileUpdateInput
  const requestedStatus = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : undefined

  if ('email' in raw) {
    profileData.email = typeof raw.email === 'string' ? raw.email.trim() : ''
  }

  if ('dob' in raw) {
    const dobValue = raw.dob
    profileData.dob = dobValue === null || dobValue === undefined || dobValue === '' ? null : new Date(String(dobValue))
  }

  if ('zipCode' in raw) {
    const zipValue = raw.zipCode
    profileData.zipCode =
      zipValue === null || zipValue === undefined || String(zipValue).trim() === '' ? null : String(zipValue).trim()
  }

  if ('city' in raw) {
    const cityValue = raw.city
    profileData.city =
      cityValue === null || cityValue === undefined || String(cityValue).trim() === '' ? null : String(cityValue).trim()
  }

  if ('state' in raw) {
    const stateValue = raw.state
    profileData.state =
      stateValue === null || stateValue === undefined || String(stateValue).trim() === ''
        ? null
        : String(stateValue).trim()
  }

  if (typeof profileData.slug === 'string') {
    profileData.slug = await ensureUniqueSlug(profileData.slug, profileId)
  }

  const currentProfile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      slug: true,
      name: true,
      email: true,
      dob: true,
      phone: true,
      isDraft: true,
      isPublic: true,
      themeConfig: true,
    },
  })
  if (!currentProfile) throw new AppError(404, 'Profile not found')

  const nextDraft = 'isDraft' in raw ? Boolean(raw.isDraft) : currentProfile.isDraft
  const nextPublic = 'isPublic' in raw ? Boolean(raw.isPublic) : currentProfile.isPublic
  const willBeActive = requestedStatus ? requestedStatus === 'active' : !nextDraft && nextPublic
  const isActivationTransition = willBeActive && currentName !== 'active'
  if (isActivationTransition) {
    assertCardCanActivate({
      slug: 'slug' in raw ? raw.slug : currentProfile.slug,
      name: 'name' in raw ? raw.name : currentProfile.name,
      email: 'email' in raw ? raw.email : currentProfile.email,
      dob: 'dob' in raw ? raw.dob : currentProfile.dob,
      phone: 'phone' in raw ? raw.phone : currentProfile.phone,
    })
  }

  if (requestedStatus) {
    if (!isCardLifecycleStatus(requestedStatus)) {
      throw new AppError(400, 'Invalid card status')
    }
    if (!staff) {
      if (requestedStatus === 'paused' || requestedStatus === 'suspended') {
        throw new AppError(403, 'Only administrators can pause or suspend a card.')
      }
      if (currentName === 'paused' || currentName === 'suspended') {
        throw new AppError(403, 'This card is locked by an administrator.')
      }
    }
    const statusRow = await ensureStatusByName(requestedStatus)
    profileData.status = { connect: { id: statusRow.id } }
    const flags = lifecycleStatusFlags(requestedStatus)
    profileData.isDraft = flags.isDraft
    profileData.isPublic = flags.isPublic
  }

  if ('isPublic' in raw && !requestedStatus) {
    const nextPublic = Boolean(raw.isPublic)
    if (!staff && nextPublic && (currentName === 'paused' || currentName === 'suspended')) {
      throw new AppError(403, 'This card is hidden by an administrator and cannot be made public.')
    }
    if (currentName !== 'paused' && currentName !== 'suspended') {
      const statusRow = await ensureStatusByName(nextPublic ? 'active' : 'inactive')
      profileData.status = { connect: { id: statusRow.id } }
      profileData.isDraft = false
    }
  }

  if ('isDraft' in raw && !requestedStatus) {
    const nextDraft = Boolean(raw.isDraft)
    profileData.isDraft = nextDraft
    if (nextDraft) {
      profileData.isPublic = false
      if (currentName !== 'paused' && currentName !== 'suspended') {
        const statusRow = await ensureStatusByName('draft')
        profileData.status = { connect: { id: statusRow.id } }
      }
    } else if (currentName === 'paused' || currentName === 'suspended' || currentName === 'inactive') {
      if (!('isPublic' in raw)) profileData.isPublic = false
    } else {
      if (!('isPublic' in raw)) profileData.isPublic = true
      if (!('isPublic' in raw) || Boolean(raw.isPublic)) {
        const statusRow = await ensureStatusByName('active')
        profileData.status = { connect: { id: statusRow.id } }
      }
    }
  }

  // Complete entitlement validation before changing the parent Profile. A denied
  // setting must not leave scalar fields partially saved behind an error response.
  let existingSettingsMap: Map<string, string | null> | null = null
  if (normalizedSettings) {
    const existingSettings = await safePrismaQuery(
      () => prisma.setting.findMany({ where: { profileId }, select: { key: true, value: true } }),
      [] as Array<{ key: string; value: string }>
    )
    existingSettingsMap = new Map(existingSettings.map((row) => [row.key, row.value]))
    if ('extra_fields_json' in normalizedSettings) {
      const nextCount = countFilledExtraFields(normalizedSettings.extra_fields_json)
      const currentCount = countFilledExtraFields(existingSettingsMap.get('extra_fields_json'))
      if (nextCount > currentCount) {
        await assertCountWithinPackageLimit(userId, role, 'maxExtraFields', nextCount)
      }
    }
    for (const [key, value] of Object.entries(normalizedSettings)) {
      const gates = catalogGatesForSettingChange(key, value, existingSettingsMap.get(key))
      for (const gate of gates) {
        await assertCatalogFeatureGate(userId, role, gate)
      }
    }
  }

  if (profileSettings?.themeConfig !== undefined) {
    const existingTheme = await safePrismaQuery(
      () => prisma.profileSetting.findUnique({ where: { profileId }, select: { themeConfig: true } }),
      null as { themeConfig: unknown } | null
    )
    const wallpaperGate = catalogGateForWallpaperChange(
      profileSettings.themeConfig,
      existingTheme?.themeConfig ?? currentProfile.themeConfig
    )
    if (wallpaperGate) await assertCatalogFeatureGate(userId, role, wallpaperGate)
  }

  try {
    await prisma.profile.update({
      where: { id: profileId },
      data: profileData,
    })
  } catch (error) {
    if (!isPrismaUniqueConstraint(error, 'email')) throw error
    throw new AppError(409, 'This email is already used by another card.', {
      code: 'PROFILE_EMAIL_CONFLICT',
      data: { field: 'email' },
    })
  }

  if ('address' in raw || 'zipCode' in raw) {
    await upsertPrimaryAddress(profileId, {
      ...('address' in raw ? { address: raw.address } : {}),
      ...('zipCode' in raw ? { zipCode: raw.zipCode } : {}),
    })
  }

  if (normalizedSettings) {
    const existingMap = existingSettingsMap ?? new Map<string, string | null>()
    const changedEntries = Object.entries(normalizedSettings).filter(([key, value]) => existingMap.get(key) !== value)
    if (changedEntries.length) {
      await Promise.all(
        changedEntries.map(([key, value]) =>
          prisma.setting.upsert({
            where: { profileId_key: { profileId, key } },
            create: { profileId, key, value },
            update: { value },
          })
        )
      )
    }
    const nextCustomTabs =
      typeof normalizedSettings.custom_tabs_json === 'string' ? normalizedSettings.custom_tabs_json : null
    if (nextCustomTabs != null && existingMap.get('custom_tabs_json') !== nextCustomTabs) {
      await syncCustomTabsJson(profileId, nextCustomTabs)
    }
  }

  if (profileSettings) {
    await prisma.profileSetting.upsert({
      where: { profileId },
      create: {
        profileId,
        profileTemplate: profileSettings.profileTemplate || 'v3',
        layoutStyle: profileSettings.layoutStyle,
        buttonStyle: profileSettings.buttonStyle,
        cornerStyle: profileSettings.cornerStyle,
        themeConfig: profileSettings.themeConfig as object | undefined,
      },
      update: {
        ...(profileSettings.profileTemplate ? { profileTemplate: profileSettings.profileTemplate } : {}),
        ...(profileSettings.layoutStyle !== undefined ? { layoutStyle: profileSettings.layoutStyle } : {}),
        ...(profileSettings.buttonStyle !== undefined ? { buttonStyle: profileSettings.buttonStyle } : {}),
        ...(profileSettings.cornerStyle !== undefined ? { cornerStyle: profileSettings.cornerStyle } : {}),
        ...(profileSettings.themeConfig !== undefined ? { themeConfig: profileSettings.themeConfig as object } : {}),
      },
    })

    // Keep Profile.themeConfig in sync so public myCard / wallets match ProfileSetting.
    if (profileSettings.themeConfig !== undefined && !('themeConfig' in raw)) {
      await prisma.profile.update({
        where: { id: profileId },
        data: { themeConfig: profileSettings.themeConfig as object },
      })
    }
  }

  const updated = await loadProfileDetail({ id: profileId })
  if (!updated) throw new AppError(404, 'Profile not found')

  if (staff && requestedStatus && requestedStatus !== currentName) {
    const actor = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    })
    if (actor) {
      if (requestedStatus === 'paused' || requestedStatus === 'suspended') {
        void notifyCardPausedOrSuspended(actor, profileId, requestedStatus)
      } else if (requestedStatus === 'active' && (currentName === 'paused' || currentName === 'suspended')) {
        void notifyCardActivated(actor, profileId)
      }
    }
  }

  const themeTouched = Boolean(
    profileSettings &&
    (profileSettings.profileTemplate !== undefined ||
      profileSettings.layoutStyle !== undefined ||
      profileSettings.buttonStyle !== undefined ||
      profileSettings.cornerStyle !== undefined ||
      profileSettings.themeConfig !== undefined ||
      'colorCode' in raw ||
      'template' in raw ||
      'themeConfig' in raw)
  )
  const contactKeys = [
    'email',
    'phone',
    'whatsapp',
    'website',
    'facebook',
    'instagram',
    'twitter',
    'tiktok',
    'youtube',
    'rumble',
    'truth',
    'linkedin',
    'pinterest',
    'address',
    'countryCode',
  ]
  const contactTouched = contactKeys.some((key) => key in raw)
  const lifecycleStatusChange = Boolean(requestedStatus)

  if (themeTouched) {
    pushService.notifyProfileUpdate(profileId, {
      type: 'theme_updates',
      title: 'Theme updated',
      body: `${updated.companyName || updated.name} updated their card design.`,
    })
  } else if (contactTouched) {
    pushService.notifyProfileUpdate(profileId, {
      type: 'contact_updates',
      title: 'Contact info updated',
      body: `${updated.companyName || updated.name} updated their contact info.`,
    })
  } else if (!lifecycleStatusChange) {
    pushService.notifyProfileUpdate(profileId, {
      type: 'business_hours',
      title: 'Profile updated',
      body: `${updated.companyName || updated.name} updated their profile.`,
    })
  }

  return updated
}

const remove = async (profileId: string, userId: string, role: string) => {
  await getOwnedForWrite(profileId, userId, role)
  await prisma.profile.delete({ where: { id: profileId } })
  return { id: profileId, deleted: true }
}

const COLLECTION_DELEGATE = {
  education: 'education',
  experiences: 'experience',
  services: 'service',
  portfolios: 'gallery',
  reviews: 'review',
  skillTags: 'skillTag',
  socialLinks: 'socialLink',
  addresses: 'address',
} as const

type CollectionKind = keyof typeof COLLECTION_DELEGATE

const replaceCollection = async <T extends Record<string, unknown>>(
  profileId: string,
  userId: string,
  role: string,
  kind: CollectionKind,
  items: T[],
  mapItem: (item: T) => Record<string, unknown>
) => {
  await getOwnedForWrite(profileId, userId, role)
  if (kind === 'socialLinks') {
    const nextCount = countFilledSocialLinks(items)
    const existing = await prisma.socialLink.findMany({
      where: { profileId },
      select: { name: true, url: true },
    })
    const currentCount = countFilledSocialLinks(existing)
    if (nextCount > currentCount) {
      await assertCountWithinPackageLimit(userId, role, 'maxSocialLinks', nextCount)
    }
  }
  const delegate = COLLECTION_DELEGATE[kind]
  await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (tx as any)[delegate]
    if (!model?.deleteMany || !model?.create) {
      throw new AppError(500, `Unknown collection model: ${kind}`)
    }
    await model.deleteMany({ where: { profileId } })
    // Prefer per-row `create` over `createMany` so Prisma applies `@default(cuid())`
    // and `@updatedAt` (createMany skips those client-side defaults).
    for (let index = 0; index < items.length; index += 1) {
      await model.create({
        data: {
          profileId,
          sortOrder: index,
          ...mapItem(items[index]),
        },
      })
    }
    if (kind === 'portfolios') {
      await tx.portfolio.deleteMany({ where: { profileId } })
      for (let index = 0; index < items.length; index += 1) {
        const mapped = mapItem(items[index])
        const statusValue = Number(mapped.status)
        await tx.portfolio.create({
          data: {
            profileId,
            sortOrder: index,
            title: typeof mapped.title === 'string' ? mapped.title : null,
            description: typeof mapped.description === 'string' ? mapped.description : null,
            status: Number.isFinite(statusValue) ? statusValue : 1,
            url: typeof mapped.url === 'string' ? mapped.url : null,
            imageUrl:
              typeof mapped.featuredImage === 'string'
                ? mapped.featuredImage
                : typeof mapped.imageUrl === 'string'
                  ? mapped.imageUrl
                  : null,
            attachmentUrl: typeof mapped.attachmentUrl === 'string' ? mapped.attachmentUrl : null,
            attachmentName: typeof mapped.attachmentName === 'string' ? mapped.attachmentName : null,
          },
        })
      }
    }
  })
  const owned = await getOwnedLite(profileId, userId, role)
  const preferenceType = pushService.preferenceKeyForCollection(kind)
  if (preferenceType) {
    const titles: Record<string, { title: string; action: string }> = {
      service_updates: { title: 'Services updated', action: 'updated their services' },
      portfolio_updates: { title: 'Portfolio updated', action: 'added new photos or videos' },
      contact_updates: { title: 'Contact links updated', action: 'updated their contact links' },
      business_hours: { title: 'Professional info updated', action: 'updated their professional info' },
    }
    const copy = titles[preferenceType] || { title: 'Card updated', action: 'has a new update' }
    const businessName = owned.companyName || owned.name
    pushService.notifyProfileUpdate(profileId, {
      type: preferenceType,
      title: copy.title,
      body: `${businessName} ${copy.action}.`,
    })
  }
  return owned
}

const serializeAboutMe = (
  row: {
    id: string
    profileId: string
    title: string
    description: string | null
    featuredMediaUrl: string | null
    status: string
    legacyPostId: number | null
    createdAt: Date
    updatedAt: Date
  },
  featuredMediaFocusY: number | null = null
) => ({
  id: row.id,
  profileId: row.profileId,
  title: row.title?.trim() || '',
  description: row.description,
  featuredMediaUrl: row.featuredMediaUrl,
  featuredMediaFocusY,
  status: row.status,
  legacyPostId: row.legacyPostId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const ABOUT_ME_TITLE_KEY = 'about_me_title'
const ABOUT_ME_MEDIA_KEY = 'about_me_featured_media_url'
const ABOUT_ME_STATUS_KEY = 'about_me_status'

const serializeAboutMeFromProfile = async (profileId: string) => {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      about: true,
      createdAt: true,
      updatedAt: true,
      settings: {
        where: {
          key: { in: [ABOUT_ME_TITLE_KEY, ABOUT_ME_MEDIA_KEY, ABOUT_ME_STATUS_KEY, ABOUT_ME_MEDIA_FOCUS_Y_KEY] },
        },
        select: { key: true, value: true },
      },
    },
  })
  if (!profile) return null
  const map = Object.fromEntries(profile.settings.map((row) => [row.key, row.value || '']))
  const description = profile.about?.trim() || ''
  const title = map[ABOUT_ME_TITLE_KEY]?.trim() || ''
  const featuredMediaUrl = map[ABOUT_ME_MEDIA_KEY]?.trim() || ''
  const focusRaw = map[ABOUT_ME_MEDIA_FOCUS_Y_KEY]?.trim()
  const featuredMediaFocusY = focusRaw && Number.isFinite(Number(focusRaw)) ? clampAboutMeMediaFocusY(focusRaw) : null
  if (!description && !title && !featuredMediaUrl) return null
  return {
    id: profileId,
    profileId,
    title: title || 'About Me',
    description: description || null,
    featuredMediaUrl: featuredMediaUrl || null,
    featuredMediaFocusY,
    status: map[ABOUT_ME_STATUS_KEY] || '1',
    legacyPostId: null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

const upsertAboutMeSettingsFallback = async (
  profileId: string,
  input: {
    title?: string | null
    description?: string | null
    featuredMediaUrl?: string | null
    featuredMediaFocusY?: number | null
    status?: string | null
  }
) => {
  if (input.description !== undefined) {
    await prisma.profile.update({
      where: { id: profileId },
      data: { about: input.description == null ? null : String(input.description) },
    })
  }
  const pairs: Array<[string, string | null | undefined]> = [
    [ABOUT_ME_TITLE_KEY, input.title],
    [ABOUT_ME_MEDIA_KEY, input.featuredMediaUrl],
    [ABOUT_ME_STATUS_KEY, input.status],
  ]
  await Promise.all(
    pairs
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        prisma.setting.upsert({
          where: { profileId_key: { profileId, key } },
          create: { profileId, key, value: value == null ? '' : String(value) },
          update: { value: value == null ? '' : String(value) },
        })
      )
  )
  await upsertAboutMeMediaFocusY(prisma, profileId, input.featuredMediaFocusY)
  return serializeAboutMeFromProfile(profileId)
}

const getAboutMe = async (profileId: string, userId: string, role: string) => {
  await getOwnedLite(profileId, userId, role)
  const focusY = await readAboutMeMediaFocusY(prisma, profileId)
  try {
    const row = await prisma.aboutMe.findUnique({ where: { profileId } })
    if (row) return serializeAboutMe(row, focusY)
    const fallback = await serializeAboutMeFromProfile(profileId)
    return fallback
  } catch (error) {
    if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
    return serializeAboutMeFromProfile(profileId)
  }
}

const upsertAboutMe = async (
  profileId: string,
  userId: string,
  role: string,
  input: {
    title?: string | null
    description?: string | null
    featuredMediaUrl?: string | null
    featuredMediaFocusY?: number | null
    status?: string | null
  }
) => {
  await getOwnedForWrite(profileId, userId, role)
  // Title is the public headline under fixed "About Me" chrome — empty is allowed.
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const description =
    input.description === undefined ? undefined : input.description == null ? null : String(input.description)
  const featuredMediaUrl =
    input.featuredMediaUrl === undefined
      ? undefined
      : input.featuredMediaUrl == null || !String(input.featuredMediaUrl).trim()
        ? null
        : String(input.featuredMediaUrl).trim()
  const status =
    input.status === undefined || input.status == null || !String(input.status).trim()
      ? undefined
      : String(input.status).trim()

  let row
  try {
    row = await prisma.aboutMe.upsert({
      where: { profileId },
      create: {
        profileId,
        title,
        description: description ?? null,
        featuredMediaUrl: featuredMediaUrl ?? null,
        status: status ?? '1',
      },
      update: {
        title,
        ...(description !== undefined ? { description } : {}),
        ...(featuredMediaUrl !== undefined ? { featuredMediaUrl } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    })
  } catch (error) {
    if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
    const fallback = await upsertAboutMeSettingsFallback(profileId, {
      title,
      description,
      featuredMediaUrl,
      featuredMediaFocusY: input.featuredMediaFocusY,
      status,
    })
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: { name: true, companyName: true },
    })
    const businessName = profile?.companyName || profile?.name || 'vBiz Me'
    pushService.notifyProfileUpdate(profileId, {
      type: 'business_hours',
      title: 'About Me updated',
      body: `${businessName} updated their About Me section.`,
    })
    return fallback
  }

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { name: true, companyName: true },
  })
  const businessName = profile?.companyName || profile?.name || 'vBiz Me'
  pushService.notifyProfileUpdate(profileId, {
    type: 'business_hours',
    title: 'About Me updated',
    body: `${businessName} updated their About Me section.`,
  })

  await upsertAboutMeMediaFocusY(prisma, profileId, input.featuredMediaFocusY)
  const focusY = await readAboutMeMediaFocusY(prisma, profileId)
  return serializeAboutMe(row, focusY)
}

const deleteAboutMe = async (profileId: string, userId: string, role: string) => {
  await getOwnedForWrite(profileId, userId, role)
  try {
    await prisma.aboutMe.deleteMany({ where: { profileId } })
  } catch (error) {
    if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
  }
  await prisma.profile.update({ where: { id: profileId }, data: { about: null } })
  await prisma.setting.deleteMany({
    where: {
      profileId,
      key: { in: [ABOUT_ME_TITLE_KEY, ABOUT_ME_MEDIA_KEY, ABOUT_ME_STATUS_KEY, ABOUT_ME_MEDIA_FOCUS_Y_KEY] },
    },
  })
  return { deleted: true as const }
}

type PostDocumentInput = {
  url: string
  name?: string
  type?: string
}

const extensionFromDoc = (doc: PostDocumentInput) => {
  const fromName = doc.name?.includes('.') ? doc.name.split('.').pop() : undefined
  if (fromName) return fromName.toLowerCase()
  if (doc.type?.includes('/')) return doc.type.split('/')[1]?.toLowerCase()
  try {
    const pathname = new URL(doc.url).pathname
    const ext = pathname.includes('.') ? pathname.split('.').pop() : undefined
    return ext?.toLowerCase()
  } catch {
    return undefined
  }
}

const syncPostDocuments = async (postId: string, profileId: string, documents: PostDocumentInput[]) => {
  await prisma.attachment.deleteMany({ where: { postId } })
  const valid = documents.filter((d) => typeof d?.url === 'string' && d.url.trim())
  if (!valid.length) return
  await prisma.attachment.createMany({
    data: valid.map((doc) => ({
      attachableType: 'Post',
      attachableId: postId,
      postId,
      profileId,
      docName: doc.name?.trim() || 'document',
      url: doc.url.trim(),
      mimeType: doc.type || undefined,
      extension: extensionFromDoc(doc),
    })),
  })
}

const createPost = async (
  profileId: string,
  userId: string,
  role: string,
  input: {
    title?: string
    description?: string
    postTypeName?: string
    postTypeId?: string
    url?: string
    featuredImage?: string
    status?: string
    metas?: Record<string, string>
    documents?: PostDocumentInput[]
  }
) => {
  await getOwnedForWrite(profileId, userId, role)
  let postTypeId = input.postTypeId
  if (!postTypeId && input.postTypeName) {
    const existing = await prisma.postType.findFirst({
      where: { name: { equals: input.postTypeName, mode: 'insensitive' } },
    })
    const pt =
      existing || (await prisma.postType.create({ data: { name: input.postTypeName, title: input.postTypeName } }))
    postTypeId = pt.id
  }

  const primaryDocUrl = input.documents?.find((d) => d?.url?.trim())?.url?.trim()
  const featuredImage = input.featuredImage?.trim() || primaryDocUrl || undefined

  const post = await prisma.post.create({
    data: {
      profileId,
      postTypeId,
      title: input.title,
      description: input.description,
      url: input.url,
      featuredImage,
      status: input.status ?? '1',
      createdById: userId,
      metas: input.metas
        ? {
            create: Object.entries(input.metas).map(([metaKey, metaValue]) => ({ metaKey, metaValue })),
          }
        : undefined,
    },
    include: { postType: true, metas: true, attachments: true },
  })

  if (Array.isArray(input.documents)) {
    await syncPostDocuments(post.id, profileId, input.documents)
  }

  const created = await prisma.post.findUniqueOrThrow({
    where: { id: post.id },
    include: { postType: true, metas: true, attachments: true },
  })

  const preferenceType = pushService.preferenceKeyForPostType(created.postType?.name || input.postTypeName)
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { name: true, companyName: true },
  })
  const businessName = profile?.companyName || profile?.name || 'vBiz Me'
  pushService.notifyProfileUpdate(profileId, {
    type: preferenceType,
    title: created.title?.trim() || 'New post',
    body: `${businessName} published a new update.`,
  })

  return created
}

const updatePost = async (
  postId: string,
  userId: string,
  role: string,
  data: {
    title?: string
    description?: string
    url?: string
    featuredImage?: string
    status?: string
    sortOrder?: number
    metas?: Record<string, string>
    documents?: PostDocumentInput[]
  }
) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwnedForWrite(post.profileId, userId, role)

  const primaryDocUrl = Array.isArray(data.documents)
    ? data.documents.find((d) => d?.url?.trim())?.url?.trim()
    : undefined
  const featuredImage =
    data.featuredImage !== undefined ? data.featuredImage : primaryDocUrl !== undefined ? primaryDocUrl : undefined

  await prisma.post.update({
    where: { id: postId },
    data: {
      title: data.title,
      description: data.description,
      url: data.url,
      featuredImage,
      status: data.status,
      sortOrder: data.sortOrder,
      updatedById: userId,
    },
  })

  if (data.metas && typeof data.metas === 'object') {
    await Promise.all(
      Object.entries(data.metas).map(async ([metaKey, metaValue]) => {
        const existing = await prisma.postMeta.findFirst({ where: { postId, metaKey } })
        const value = metaValue == null ? '' : String(metaValue)
        if (existing) {
          await prisma.postMeta.update({ where: { id: existing.id }, data: { metaValue: value } })
        } else if (value) {
          await prisma.postMeta.create({ data: { postId, metaKey, metaValue: value } })
        }
      })
    )
  }

  if (Array.isArray(data.documents)) {
    await syncPostDocuments(postId, post.profileId, data.documents)
  }

  const updatedPost = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
    include: { postType: true, metas: true, attachments: true },
  })

  const preferenceType = pushService.preferenceKeyForPostType(updatedPost.postType?.name)
  const profile = await prisma.profile.findUnique({
    where: { id: post.profileId },
    select: { name: true, companyName: true },
  })
  const businessName = profile?.companyName || profile?.name || 'vBiz Me'
  pushService.notifyProfileUpdate(post.profileId, {
    type: preferenceType,
    title: updatedPost.title?.trim() || 'Post updated',
    body: `${businessName} updated a post.`,
  })

  return updatedPost
}

const deletePost = async (postId: string, userId: string, role: string) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwnedForWrite(post.profileId, userId, role)
  await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date(), status: '0' } })
  return { id: postId, deleted: true }
}

const listPosts = async (
  profileId: string,
  userId: string,
  role: string,
  postTypeName?: string,
  skip = 0,
  limit = 200
) => {
  await getOwnedLite(profileId, userId, role)
  const take = Math.min(200, Math.max(1, limit))
  const start = Math.max(0, skip)
  const where = {
    profileId,
    deletedAt: null,
    ...(postTypeName ? { postType: { name: { equals: postTypeName, mode: 'insensitive' as const } } } : {}),
  }
  const [items, total] = await Promise.all([
    prisma.post.findMany({
      where,
      include: { postType: true, metas: true, attachments: true },
      orderBy: { sortOrder: 'asc' },
      skip: start,
      take,
    }),
    prisma.post.count({ where }),
  ])
  return { items, total, skip: start, limit: take }
}

const emptyProfileIds = (profileIds: string[]) => profileIds.length === 0

const emptyDashboardStats = (now: Date, chartDays: number, period: DashboardPeriod) => ({
  cards: 0,
  activeCards: 0,
  totalViews: 0,
  viewsLast30Days: 0,
  contactsLast30Days: 0,
  notesLast30Days: 0,
  guestsLast30Days: 0,
  contactSaves: 0,
  uniqueViews: 0,
  shares: 0,
  period,
  visitsChart: { total: 0, trendPercent: 0, points: buildDailyPoints(now, chartDays, new Map()) },
  socialChannels: [] as Array<{
    channel: (typeof SOCIAL_CHANNELS)[number]
    label: string
    count: number
    trendPercent: number
  }>,
  recentEngagement: [] as Array<{
    id: string
    event: string
    viewer: string
    time: string
    platform: string
    createdAt: string
  }>,
  profiles: [],
})

const getDashboardStats = async (
  userId: string,
  role: string,
  period: DashboardPeriod = 'all',
  scope?: ProfileListScope
) => {
  // Overview (no scope) is platform-wide for staff. My Cards passes scope=created.
  const profiles = await listAnalyticsProfiles(userId, role, scope)
  const profileIds = profiles.map((p) => p.id)
  const now = new Date()
  const windowDays = resolveDashboardWindowDays(period)
  const chartDays = windowDays ?? DASHBOARD_ALL_CHART_DAYS
  const since = windowDays != null ? new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000) : null
  const prevSince = since && windowDays != null ? new Date(since.getTime() - windowDays * 24 * 60 * 60 * 1000) : null
  const createdAtFilter = since ? { createdAt: { gte: since } } : {}

  if (emptyProfileIds(profileIds)) {
    return emptyDashboardStats(now, chartDays, period)
  }

  const [
    contacts,
    notes,
    guests,
    contactSaves,
    viewEvents,
    prevViewEvents,
    socialEvents,
    prevSocialEvents,
    recentLogs,
  ] = await Promise.all([
    prisma.contact.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),
    prisma.userNote.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),
    prisma.guestUserData.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),

    prisma.eventLog.count({
      where: {
        profileId: { in: profileIds },

        eventType: 'save_contact_download',

        ...createdAtFilter,
      },
    }),
    prisma.eventLog.findMany({
      where: { profileId: { in: profileIds }, eventType: 'profile_view', ...createdAtFilter },
      select: { createdAt: true, payload: true },
    }),
    prevSince && since
      ? prisma.eventLog.findMany({
          where: {
            profileId: { in: profileIds },
            eventType: 'profile_view',
            createdAt: { gte: prevSince, lt: since },
          },
          select: { payload: true },
        })
      : Promise.resolve([] as Array<{ payload: unknown }>),
    prisma.eventLog.findMany({
      where: { profileId: { in: profileIds }, eventType: 'social_click', ...createdAtFilter },
      select: { payload: true },
    }),
    prevSince && since
      ? prisma.eventLog.findMany({
          where: {
            profileId: { in: profileIds },
            eventType: 'social_click',
            createdAt: { gte: prevSince, lt: since },
          },
          select: { payload: true },
        })
      : Promise.resolve([] as Array<{ payload: unknown }>),
    prisma.eventLog.findMany({
      where: { profileId: { in: profileIds } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ENGAGEMENT_LIMIT,
      select: { id: true, eventType: true, payload: true, userAgent: true, createdAt: true },
    }),
  ])

  const views = countDistinctGuests(viewEvents)
  const prevViews = countDistinctGuests(prevViewEvents)
  const countsByDay = countDistinctGuestsByDay(viewEvents)
  const visitsPoints = buildDailyPoints(now, chartDays, countsByDay)

  const currentSocial = countDistinctGuestsByChannel(socialEvents)
  const prevSocial = countDistinctGuestsByChannel(prevSocialEvents)
  const shares = SOCIAL_CHANNELS.reduce((sum, channel) => sum + (currentSocial.get(channel) || 0), 0)
  const socialChannels = SOCIAL_CHANNELS.map((channel) => ({
    channel,
    label: SOCIAL_CHANNEL_LABELS[channel],
    count: currentSocial.get(channel) || 0,
    trendPercent: since ? trendPercent(currentSocial.get(channel) || 0, prevSocial.get(channel) || 0) : 0,
  })).filter((row) => row.count > 0)

  const totalViews = profiles.reduce((sum, p) => sum + p.viewCount, 0)
  const activeCards = profiles.filter((p) => isActiveAnalyticsCard(p.status?.name)).length
  const visitsChart = {
    total: views,
    trendPercent: since ? trendPercent(views, prevViews) : 0,
    points: visitsPoints,
  }
  const recentEngagement = recentLogs.map((row) => {
    const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : null
    return {
      id: row.id,
      event: eventTypeLabel(row.eventType, payload),
      viewer: viewerFromPayload(row.eventType, payload),
      time: formatRelativeTime(row.createdAt, now),
      platform: parsePlatformFromUa(row.userAgent),
      createdAt: row.createdAt.toISOString(),
    }
  })
  const profileRows =
    scope === 'created'
      ? profiles.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          viewCount: p.viewCount,
          services: p._count.services,
          portfolios: p._count.portfolios,
          posts: p._count.posts,
        }))
      : []

  return {
    cards: profiles.length,
    activeCards,
    totalViews,
    viewsLast30Days: views,
    contactsLast30Days: contacts,
    notesLast30Days: notes,
    guestsLast30Days: guests,
    contactSaves,
    uniqueViews: views,
    shares,
    period,
    visitsChart,
    socialChannels,
    recentEngagement,
    profiles: profileRows,
  }
}

const getDashboardSummary = async (
  userId: string,
  role: string,
  period: DashboardPeriod = 'all',
  scope?: ProfileListScope
) => {
  const [stats, contacts, social] = await Promise.all([
    getDashboardStats(userId, role, period, scope),
    listContacts(userId, role, undefined, 10, scope),
    getSocialClicksBundle(userId, role, scope),
  ])
  return {
    stats,
    recentEngagement: {
      items: stats.recentEngagement,
      total: stats.recentEngagement.length,
      skip: 0,
      limit: RECENT_ENGAGEMENT_LIMIT,
    },
    contactsPreview: contacts.slice(0, 10),
    socialClicks: social.socialClicks,
    socialClicksByCard: social.socialClicksByCard,
  }
}

type OwnerContactMeta = {
  privateNotes?: string
  lastReply?: string
  lastReplyAt?: string
}

function asMetaRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function readOwnerContactMeta(meta: unknown): OwnerContactMeta {
  const root = asMetaRecord(meta)
  const admin = asMetaRecord(root.admin)
  return {
    privateNotes: typeof admin.privateNotes === 'string' ? admin.privateNotes : undefined,
    lastReply: typeof admin.lastReply === 'string' ? admin.lastReply : undefined,
    lastReplyAt: typeof admin.lastReplyAt === 'string' ? admin.lastReplyAt : undefined,
  }
}

function mergeOwnerContactMeta(
  existingMeta: unknown,
  patch: { privateNotes?: string; lastReply?: string }
): Prisma.InputJsonValue {
  const root = { ...asMetaRecord(existingMeta) }
  const admin = { ...asMetaRecord(root.admin) }
  if (patch.privateNotes !== undefined) admin.privateNotes = patch.privateNotes
  if (patch.lastReply !== undefined) {
    admin.lastReply = patch.lastReply
    admin.lastReplyAt = new Date().toISOString()
  }
  root.admin = admin
  return root as Prisma.InputJsonValue
}

function metaString(meta: unknown, ...keys: string[]): string | null {
  const root = asMetaRecord(meta)
  for (const key of keys) {
    const value = root[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export type OwnerContactRow = {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  createdAt: Date | string
  profile: { id: string; name: string; slug: string | null } | null
  source: 'guest_save' | 'contact' | 'note'
  privateNotes?: string
  lastReply?: string
  lastReplyAt?: string
}

const listContacts = async (
  userId: string,
  role: string,
  profileId?: string,
  limit?: number,
  scope?: ProfileListScope
): Promise<OwnerContactRow[]> => {
  if (profileId) await getOwnedLite(profileId, userId, role)
  const ids = profileId ? [profileId] : await listOwnedProfileIds(userId, role, scope)
  if (emptyProfileIds(ids)) return []

  const profileSelect = { select: { id: true, name: true, slug: true } } as const

  const [guests, contacts, notes] = await Promise.all([
    prisma.guestUserData.findMany({
      where: { profileId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      include: { profile: profileSelect },
      ...(limit ? { take: limit } : {}),
    }),
    prisma.contact.findMany({
      where: { profileId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      include: { profile: profileSelect },
      ...(limit ? { take: limit } : {}),
    }),
    prisma.userNote.findMany({
      where: { profileId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      include: { profile: profileSelect },
      ...(limit ? { take: limit } : {}),
    }),
  ])

  const fromGuests: OwnerContactRow[] = guests.map((g) => {
    const admin = readOwnerContactMeta(g.meta)
    return {
      id: g.id,
      name: g.fullName,
      email: g.email,
      phone: g.phone,
      message: null,
      createdAt: g.createdAt,
      profile: g.profile,
      source: 'guest_save' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  })

  const fromContacts: OwnerContactRow[] = contacts.map((c) => {
    const admin = readOwnerContactMeta(c.meta)
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      message: c.message,
      createdAt: c.createdAt,
      profile: c.profile,
      source: 'contact' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  })

  const fromNotes: OwnerContactRow[] = notes.map((n) => {
    const admin = readOwnerContactMeta(n.meta)
    return {
      id: n.id,
      name: metaString(n.meta, 'fullName', 'name') || 'Guest',
      email: metaString(n.meta, 'email'),
      phone: metaString(n.meta, 'phone', 'phoneNumber'),
      message: n.content,
      createdAt: n.createdAt,
      profile: n.profile,
      source: 'note' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  })

  return [...fromGuests, ...fromContacts, ...fromNotes].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

const listContactsPage = async (
  userId: string,
  role: string,
  options?: {
    profileId?: string
    skip?: number
    limit?: number
    source?: 'guest_save' | 'note' | 'contact' | 'all'
    scope?: ProfileListScope
  }
): Promise<{ items: OwnerContactRow[]; total: number; skip: number; limit: number }> => {
  const skip = Math.max(0, options?.skip ?? 0)
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50))
  const source = options?.source ?? 'guest_save'
  const profileId = options?.profileId

  if (profileId) await getOwnedLite(profileId, userId, role)
  const ids = profileId ? [profileId] : await listOwnedProfileIds(userId, role, options?.scope)
  if (emptyProfileIds(ids)) {
    return { items: [], total: 0, skip, limit }
  }

  const profileSelect = { select: { id: true, name: true, slug: true } } as const
  const where = { profileId: { in: ids } }

  if (source === 'note') {
    const [total, rows] = await Promise.all([
      prisma.userNote.count({ where }),
      prisma.userNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { profile: profileSelect },
      }),
    ])
    const items: OwnerContactRow[] = rows.map((n) => {
      const admin = readOwnerContactMeta(n.meta)
      return {
        id: n.id,
        name: metaString(n.meta, 'fullName', 'name') || 'Guest',
        email: metaString(n.meta, 'email'),
        phone: metaString(n.meta, 'phone', 'phoneNumber'),
        message: n.content,
        createdAt: n.createdAt,
        profile: n.profile,
        source: 'note' as const,
        privateNotes: admin.privateNotes,
        lastReply: admin.lastReply,
        lastReplyAt: admin.lastReplyAt,
      }
    })
    return { items, total, skip, limit }
  }

  // Detailed saved-contact submissions; analytics save totals come from EventLog.
  const [total, rows] = await Promise.all([
    prisma.guestUserData.count({ where }),
    prisma.guestUserData.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { profile: profileSelect },
    }),
  ])
  const items: OwnerContactRow[] = rows.map((g) => {
    const admin = readOwnerContactMeta(g.meta)
    return {
      id: g.id,
      name: g.fullName,
      email: g.email,
      phone: g.phone,
      message: null,
      createdAt: g.createdAt,
      profile: g.profile,
      source: 'guest_save' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  })
  return { items, total, skip, limit }
}

const patchContact = async (
  userId: string,
  role: string,
  contactId: string,
  body: { privateNotes?: string; lastReply?: string; source?: 'guest_save' | 'contact' | 'note' }
): Promise<OwnerContactRow> => {
  const source = body.source
  const profiles = await listForUser(userId, role)
  const ownedIds = new Set(profiles.map((p) => p.id))

  const tryGuest = async () => {
    const existing = await prisma.guestUserData.findUnique({
      where: { id: contactId },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    if (!existing || !ownedIds.has(existing.profileId)) return null
    const updated = await prisma.guestUserData.update({
      where: { id: contactId },
      data: { meta: mergeOwnerContactMeta(existing.meta, body) },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    const admin = readOwnerContactMeta(updated.meta)
    return {
      id: updated.id,
      name: updated.fullName,
      email: updated.email,
      phone: updated.phone,
      message: null,
      createdAt: updated.createdAt,
      profile: updated.profile,
      source: 'guest_save' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  }

  const tryContact = async () => {
    const existing = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    if (!existing || !ownedIds.has(existing.profileId)) return null
    const updated = await prisma.contact.update({
      where: { id: contactId },
      data: { meta: mergeOwnerContactMeta(existing.meta, body) },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    const admin = readOwnerContactMeta(updated.meta)
    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      message: updated.message,
      createdAt: updated.createdAt,
      profile: updated.profile,
      source: 'contact' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  }

  const tryNote = async () => {
    const existing = await prisma.userNote.findUnique({
      where: { id: contactId },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    if (!existing || !ownedIds.has(existing.profileId)) return null
    const updated = await prisma.userNote.update({
      where: { id: contactId },
      data: { meta: mergeOwnerContactMeta(existing.meta, body) },
      include: { profile: { select: { id: true, name: true, slug: true } } },
    })
    const admin = readOwnerContactMeta(updated.meta)
    return {
      id: updated.id,
      name: metaString(updated.meta, 'fullName', 'name') || 'Guest',
      email: metaString(updated.meta, 'email'),
      phone: metaString(updated.meta, 'phone', 'phoneNumber'),
      message: updated.content,
      createdAt: updated.createdAt,
      profile: updated.profile,
      source: 'note' as const,
      privateNotes: admin.privateNotes,
      lastReply: admin.lastReply,
      lastReplyAt: admin.lastReplyAt,
    }
  }

  const row: OwnerContactRow | null =
    source === 'guest_save'
      ? await tryGuest()
      : source === 'contact'
        ? await tryContact()
        : source === 'note'
          ? await tryNote()
          : (await tryGuest()) || (await tryContact()) || (await tryNote())

  if (!row) throw new AppError(404, 'Contact not found')
  return row
}

const csvEscape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`

const exportContactsCsv = async (userId: string, role: string, profileId?: string) => {
  const rows = await listContacts(userId, role, profileId)
  const header = ['Name', 'Email', 'Phone', 'Card', 'Created', 'Source']
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [
        csvEscape(r.name),
        csvEscape(r.email),
        csvEscape(r.phone),
        csvEscape(r.profile?.name),
        csvEscape(typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString()),
        csvEscape(r.source),
      ].join(',')
    ),
  ]
  return lines.join('\n')
}

type RecentEngagementQuery = {
  skip?: number
  limit?: number
  profileId?: string
  eventType?: string
  from?: Date
  to?: Date
}

const listRecentEngagement = async (userId: string, role: string, query: RecentEngagementQuery = {}) => {
  const skip = Math.max(0, Number(query.skip) || 0)
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 10))

  if (query.profileId) {
    await getOwnedLite(query.profileId, userId, role)
  }

  const profileIds = query.profileId ? [query.profileId] : await listOwnedProfileIds(userId, role)

  if (emptyProfileIds(profileIds)) {
    return { items: [], total: 0, skip, limit }
  }

  const where: Prisma.EventLogWhereInput = {
    profileId: { in: profileIds },
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  }

  const now = new Date()
  const [total, rows] = await Promise.all([
    prisma.eventLog.count({ where }),
    prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: { id: true, eventType: true, payload: true, userAgent: true, createdAt: true },
    }),
  ])

  const items = rows.map((row) => {
    const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : null
    return {
      id: row.id,
      event: eventTypeLabel(row.eventType, payload),
      viewer: viewerFromPayload(row.eventType, payload),
      time: formatRelativeTime(row.createdAt, now),
      platform: parsePlatformFromUa(row.userAgent),
      createdAt: row.createdAt.toISOString(),
    }
  })

  return { items, total, skip, limit }
}

const listPackages = async () => {
  const rows = await prisma.package.findMany({
    where: { isActive: true },
    include: { features: true },
    orderBy: { sortOrder: 'asc' },
  })
  return rows.map((pkg) => ({ ...pkg, ownerMode: resolveOwnerMode(pkg) }))
}

const listSubscriptions = async (userId: string, role: string) => {
  const where = isAdminRole(role) ? {} : { userId }
  const rows = await prisma.subscription.findMany({
    where,
    include: { package: { include: { features: true } }, items: true, transactions: true },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((sub) => ({
    ...sub,
    package: sub.package ? { ...sub.package, ownerMode: resolveOwnerMode(sub.package) } : sub.package,
  }))
}

const getEntitlements = async (userId: string, role: string) => {
  return getEffectiveEntitlements(userId, role)
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** All-time social click counts for channels with at least one click. */
const toLiveSocialClickRows = (counts: Map<SocialChannel, number>): LiveSocialClickRow[] => {
  const rows: LiveSocialClickRow[] = []
  for (const channel of SOCIAL_CHANNELS) {
    const clickCount = counts.get(channel) || 0
    if (clickCount <= 0) continue
    rows.push({
      channel,
      label: SOCIAL_CHANNEL_LABELS[channel],
      clickCount,
    })
  }
  rows.sort((a, b) => b.clickCount - a.clickCount)
  return rows
}

const getSocialClicksBundle = async (
  userId: string,
  role: string,
  scope?: ProfileListScope
): Promise<{ socialClicks: LiveSocialClickRow[]; socialClicksByCard: SocialClicksByCardRow[] }> => {
  const profileIds = await listOwnedProfileIds(userId, role, scope)
  if (emptyProfileIds(profileIds)) return { socialClicks: [], socialClicksByCard: [] }

  const socialEvents = await prisma.eventLog.findMany({
    where: { profileId: { in: profileIds }, eventType: 'social_click' },
    select: { profileId: true, payload: true },
  })

  const byProfile = new Map<string, Array<{ payload: unknown }>>()
  for (const row of socialEvents) {
    if (!row.profileId) continue
    let bucket = byProfile.get(row.profileId)
    if (!bucket) {
      bucket = []
      byProfile.set(row.profileId, bucket)
    }
    bucket.push({ payload: row.payload })
  }

  const includePerCard = scope === 'created' || profileIds.length <= 80
  const socialClicksByCard: SocialClicksByCardRow[] = []
  if (includePerCard) {
    for (const profileId of profileIds) {
      const events = byProfile.get(profileId) || []
      socialClicksByCard.push({
        profileId,
        channels: toLiveSocialClickRows(countDistinctGuestsByChannel(events)),
      })
    }
  }

  return {
    socialClicks: toLiveSocialClickRows(countDistinctGuestsByChannel(socialEvents)),
    socialClicksByCard,
  }
}

const getLiveSocialClicks = async (userId: string, role: string, profileId?: string): Promise<LiveSocialClickRow[]> => {
  if (!profileId) {
    const bundle = await getSocialClicksBundle(userId, role)
    return bundle.socialClicks
  }
  const profile = await getOwnedLite(profileId, userId, role)
  const socialEvents = await prisma.eventLog.findMany({
    where: { profileId: profile.id, eventType: 'social_click' },
    select: { payload: true },
  })
  return toLiveSocialClickRows(countDistinctGuestsByChannel(socialEvents))
}

/** After a newly counted social_click, push refreshed totals to profile owners listening on SSE. */
const notifyLiveSocialClicks = async (profileId: string) => {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { userId: true, companyUserId: true },
  })
  if (!profile) return

  const ownerIds = Array.from(
    new Set([profile.userId, profile.companyUserId].filter((id): id is string => Boolean(id)))
  )

  await Promise.all(
    ownerIds.map(async (ownerId) => {
      const clicks = await getLiveSocialClicks(ownerId, 'vcard-owner')
      liveClicksHub.publishClickUpdate(ownerId, clicks)
    })
  )
}

/** Rolling last 7 days (ending now): views / social clicks / CTR from EventLog. */
const getWeeklyEngagement = async (userId: string, role: string, scope?: ProfileListScope, profileId?: string) => {
  let profiles = await prisma.profile.findMany({
    where: await resolveOwnershipWhere(userId, role, scope),
    select: { id: true, name: true },
    orderBy: { updatedAt: 'desc' },
  })

  if (profileId) {
    const owned = profiles.find((p) => p.id === profileId)
    if (!owned) {
      if (isAdminRole(role)) {
        const profile = await prisma.profile.findUnique({
          where: { id: profileId },
          select: { id: true, name: true },
        })
        if (!profile) throw new AppError(404, 'Profile not found')
        profiles = [profile as (typeof profiles)[number]]
      } else {
        throw new AppError(403, 'You do not have access to this profile')
      }
    } else {
      profiles = [owned]
    }
  }

  const profileIds = profiles.map((p) => p.id)
  const profileName = profileId
    ? profiles[0]?.name || 'Your card'
    : isAdminRole(role)
      ? scope === 'created'
        ? 'My cards'
        : 'All directory cards'
      : profiles.length > 1
        ? 'All cards'
        : profiles[0]?.name || 'Your card'

  const now = new Date()
  // Align to UTC midnight for stable day buckets: today and the 6 prior days.
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const rangeStart = new Date(todayUtc - 6 * 24 * 60 * 60 * 1000)
  const rangeEnd = new Date(todayUtc + 24 * 60 * 60 * 1000)

  const emptyDays = () => {
    const days = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(todayUtc - (6 - i) * 24 * 60 * 60 * 1000)
      const wd = d.getUTCDay()
      days.push({
        day: WEEKDAY_SHORT[wd],
        fullDay: WEEKDAY_FULL[wd],
        date: d.toISOString().slice(0, 10),
        views: 0,
        clicks: 0,
        ctr: 0,
      })
    }
    return {
      days,
      totals: { views: 0, clicks: 0, avgCtr: 0 },
      profileName,
      range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
    }
  }

  if (emptyProfileIds(profileIds)) return emptyDays()

  const [viewEvents, clickEvents] = await Promise.all([
    prisma.eventLog.findMany({
      where: {
        profileId: { in: profileIds },
        eventType: 'profile_view',
        createdAt: { gte: rangeStart, lt: rangeEnd },
      },
      select: { createdAt: true, payload: true },
    }),
    prisma.eventLog.findMany({
      where: {
        profileId: { in: profileIds },
        eventType: 'social_click',
        createdAt: { gte: rangeStart, lt: rangeEnd },
      },
      select: { createdAt: true, payload: true },
    }),
  ])

  const viewsByDay = countDistinctGuestsByDay(viewEvents)
  const clicksByDay = countDistinctGuestsByDay(clickEvents)

  const days: Array<{
    day: string
    fullDay: string
    date: string
    views: number
    clicks: number
    ctr: number
  }> = []
  let viewsSum = 0
  let clicksSum = 0

  for (let i = 0; i < 7; i++) {
    const d = new Date(todayUtc - (6 - i) * 24 * 60 * 60 * 1000)
    const key = dayKey(d)
    const wd = d.getUTCDay()
    const views = viewsByDay.get(key) || 0
    const clicks = clicksByDay.get(key) || 0
    const ctr = views > 0 ? parseFloat(((clicks / views) * 100).toFixed(1)) : 0
    viewsSum += views
    clicksSum += clicks
    days.push({
      day: WEEKDAY_SHORT[wd],
      fullDay: WEEKDAY_FULL[wd],
      date: d.toISOString().slice(0, 10),
      views,
      clicks,
      ctr,
    })
  }

  const avgCtr = viewsSum > 0 ? parseFloat(((clicksSum / viewsSum) * 100).toFixed(1)) : 0

  return {
    days,
    totals: { views: viewsSum, clicks: clicksSum, avgCtr },
    profileName,
    range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
  }
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const CONSOLIDATED_SERIES_COLORS = ['#4f46e5', '#ec4899', '#f59e0b', '#10b981', '#8b5cf6', '#94a3b8'] as const
const CONSOLIDATED_TOP_N = 5
const CONSOLIDATED_OTHERS = 'Others'
const CONSOLIDATED_UNSPECIFIED = 'Unspecified'
const CONSOLIDATED_MONTHS = 6

const normalizeDesignationLabel = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || CONSOLIDATED_UNSPECIFIED
}

const monthBucketKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`

/** Last 6 calendar months of profile views, rolled up by card designation (top 5 + Others). */
const getConsolidatedEngagement = async (userId: string, role: string, scope?: ProfileListScope) => {
  const now = new Date()
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (CONSOLIDATED_MONTHS - 1), 1))

  const monthSlots: Array<{ key: string; name: string }> = []
  for (let i = 0; i < CONSOLIDATED_MONTHS; i++) {
    const d = new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1))
    monthSlots.push({
      key: monthBucketKey(d),
      name: MONTH_SHORT[d.getUTCMonth()],
    })
  }

  const profiles = await prisma.profile.findMany({
    where: await resolveOwnershipWhere(userId, role, scope),
    select: { id: true, designation: true },
  })

  if (emptyProfileIds(profiles.map((p) => p.id))) {
    return {
      months: monthSlots.map((m) => ({ name: m.name, total: 0 })),
      series: [] as Array<{ key: string; label: string; color: string }>,
    }
  }

  const designationByProfileId = new Map(profiles.map((p) => [p.id, normalizeDesignationLabel(p.designation)] as const))
  const profileIds = profiles.map((p) => p.id)

  const viewEvents = await prisma.eventLog.findMany({
    where: {
      profileId: { in: profileIds },
      eventType: 'profile_view',
      createdAt: { gte: startMonth },
    },
    select: { createdAt: true, payload: true, profileId: true },
  })

  /** monthKey → designation → distinct guests */
  const byMonthDesignation = new Map<string, Map<string, { guests: Set<string>; legacy: number }>>()

  for (const row of viewEvents) {
    if (!row.profileId) continue
    const monthKey = monthBucketKey(row.createdAt)
    const designation = designationByProfileId.get(row.profileId) || CONSOLIDATED_UNSPECIFIED
    let byDesignation = byMonthDesignation.get(monthKey)
    if (!byDesignation) {
      byDesignation = new Map()
      byMonthDesignation.set(monthKey, byDesignation)
    }
    let bucket = byDesignation.get(designation)
    if (!bucket) {
      bucket = { guests: new Set(), legacy: 0 }
      byDesignation.set(designation, bucket)
    }
    const guestId = guestIdFromPayload(row.payload)
    if (guestId) bucket.guests.add(guestId)
    else bucket.legacy += 1
  }

  const totalsByDesignation = new Map<string, number>()
  for (const byDesignation of byMonthDesignation.values()) {
    for (const [designation, bucket] of byDesignation) {
      const count = bucket.guests.size + bucket.legacy
      totalsByDesignation.set(designation, (totalsByDesignation.get(designation) || 0) + count)
    }
  }

  const ranked = [...totalsByDesignation.entries()].sort((a, b) => b[1] - a[1])
  const topLabels = ranked.slice(0, CONSOLIDATED_TOP_N).map(([label]) => label)
  const topSet = new Set(topLabels)
  const hasOthers = ranked.slice(CONSOLIDATED_TOP_N).some(([, total]) => total > 0)

  const seriesLabels = hasOthers ? [...topLabels, CONSOLIDATED_OTHERS] : topLabels
  const series = seriesLabels.map((label, index) => ({
    key: label,
    label,
    color: CONSOLIDATED_SERIES_COLORS[Math.min(index, CONSOLIDATED_SERIES_COLORS.length - 1)],
  }))

  const months = monthSlots.map((slot) => {
    const row: Record<string, string | number> = { name: slot.name, total: 0 }
    for (const label of seriesLabels) row[label] = 0

    const byDesignation = byMonthDesignation.get(slot.key)
    if (byDesignation) {
      for (const [designation, bucket] of byDesignation) {
        const count = bucket.guests.size + bucket.legacy
        const target = topSet.has(designation) ? designation : CONSOLIDATED_OTHERS
        if (!(target in row) || target === 'name' || target === 'total') continue
        row[target] = (Number(row[target]) || 0) + count
        row.total = (Number(row.total) || 0) + count
      }
    }

    return row
  })

  return { months, series }
}

export type SocialClicksByCardRow = {
  profileId: string
  channels: LiveSocialClickRow[]
}

const getSocialClicksByCard = async (
  userId: string,
  role: string,
  scope?: ProfileListScope
): Promise<SocialClicksByCardRow[]> => {
  const bundle = await getSocialClicksBundle(userId, role, scope)
  return bundle.socialClicksByCard
}

export type TeamNoticeRow = {
  id: string
  text: string
  type: 'broadcast' | 'system' | 'info' | 'warning' | 'success'
  audience: 'all' | 'savers'
  targetCardId?: string
  recipientCount?: number
  createdAt: string
  status: string
  /** admin = staff Notice / banner; owner = card or corporate owner popup. */
  source?: 'admin' | 'owner'
}

function serializeTeamNotice(
  row: {
    id: string
    text: string
    type: string
    audience: string
    targetProfileId: string | null
    recipientCount: number | null
    createdAt: Date
    status: string
  },
  source?: 'admin' | 'owner'
): TeamNoticeRow {
  const allowed = new Set(['broadcast', 'system', 'info', 'warning', 'success'])
  const type = allowed.has(row.type) ? (row.type as TeamNoticeRow['type']) : 'broadcast'
  return {
    id: row.id,
    text: row.text,
    type,
    audience: row.audience === 'savers' ? 'savers' : 'all',
    targetCardId: row.targetProfileId || undefined,
    recipientCount: row.recipientCount ?? undefined,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    ...(source ? { source } : {}),
  }
}

async function isTeamNoticeSuppressed(
  profileId: string,
  noticeId: string,
  viewer?: PublicViewerIdentity
): Promise<boolean> {
  if (!viewer?.browserKey) return false

  const now = new Date()
  const viewerState = (
    prisma as unknown as {
      announcementViewerState: {
        findFirst: (args: unknown) => Promise<{ dismissedAt: Date | null; suppressUntil: Date | null } | null>
        upsert: (args: unknown) => Promise<unknown>
      }
    }
  ).announcementViewerState

  const row = await viewerState.findFirst({
    where: {
      announcementType: 'team_notice',
      announcementId: noticeId,
      profileId,
      OR: [{ browserKey: viewer.browserKey }, ...(viewer.visitorId ? [{ visitorId: viewer.visitorId }] : [])],
    },
    orderBy: { updatedAt: 'desc' },
  })

  if (!row) return false
  if (row.dismissedAt) return true
  if (row.suppressUntil && row.suppressUntil > now) return true
  return false
}

async function writeTeamNoticeViewerState(opts: {
  profileId: string
  noticeId: string
  viewer: PublicViewerIdentity
  dismissedAt?: Date | null
  suppressUntil?: Date | null
}) {
  const viewerState = (
    prisma as unknown as {
      announcementViewerState: { upsert: (args: unknown) => Promise<unknown> }
    }
  ).announcementViewerState

  await viewerState.upsert({
    where: {
      announcementType_announcementId_browserKey: {
        announcementType: 'team_notice',
        announcementId: opts.noticeId,
        browserKey: opts.viewer.browserKey,
      },
    },
    create: {
      announcementType: 'team_notice',
      announcementId: opts.noticeId,
      profileId: opts.profileId,
      visitorId: opts.viewer.visitorId,
      browserKey: opts.viewer.browserKey,
      dismissedAt: opts.dismissedAt ?? null,
      suppressUntil: opts.suppressUntil ?? null,
    },
    update: {
      profileId: opts.profileId,
      visitorId: opts.viewer.visitorId ?? undefined,
      dismissedAt: opts.dismissedAt === undefined ? undefined : opts.dismissedAt,
      suppressUntil: opts.suppressUntil === undefined ? undefined : opts.suppressUntil,
    },
  })
}

const listTeamNotices = async (userId: string): Promise<TeamNoticeRow[]> => {
  const rows = await prisma.teamNotice.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((row) => serializeTeamNotice(row))
}

const isOwnerOrCorporateRole = (role: string) =>
  role === 'vcard-owner' || role === 'corporate-owner' || role === 'VCARD_OWNER' || role === 'CORPORATE_OWNER'

const createTeamNotice = async (
  userId: string,
  role: string,
  input: {
    text: string
    type: 'broadcast' | 'system' | 'info' | 'warning' | 'success'
    audience: 'all' | 'savers'
    targetProfileId?: string
    deliver?: boolean
    onlyBackoffice?: boolean
  }
): Promise<TeamNoticeRow> => {
  const staff = isAdminRole(role)
  if (!staff && !isOwnerOrCorporateRole(role)) {
    throw new AppError(403, 'Only card owners can publish card notices')
  }

  const text = input.text.trim()
  if (!text) throw new AppError(400, 'Announcement text is required')

  let recipientCount: number | undefined
  const targetProfileId = input.targetProfileId || undefined
  const onlyBackoffice = Boolean(input.onlyBackoffice)

  // Public card banners must target one card — never publish globally without a card id.
  if (input.audience === 'all' && !targetProfileId && !onlyBackoffice) {
    throw new AppError(400, 'Select a specific card for this announcement. Global all-card banners are disabled.')
  }

  if (targetProfileId) {
    // Staff Notice is an admin action and may target any card (single or corporate).
    // Owners and corporate owners may only publish on cards they own.
    if (staff) {
      const target = await prisma.profile.findUnique({ where: { id: targetProfileId }, select: { id: true } })
      if (!target) throw new AppError(404, 'Profile not found')
    } else {
      const owned = await getOwnedLite(targetProfileId, userId, role)
      assertOwnerCanMutateCard(owned, role)
    }
  } else if (staff) {
    throw new AppError(400, 'Select a specific card for this admin notice.')
  }

  const shouldDeliver = Boolean(input.deliver) || (staff && Boolean(targetProfileId))

  if (onlyBackoffice && targetProfileId) {
    const [targetProfile, actor] = await Promise.all([
      prisma.profile.findUnique({
        where: { id: targetProfileId },
        select: {
          id: true,
          name: true,
          slug: true,
          email: true,
          user: { select: { email: true } },
          companyUser: { select: { email: true } },
        },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
    ])
    const ownerEmails = [targetProfile?.user?.email, targetProfile?.companyUser?.email, targetProfile?.email]
      .map((email) => (email || '').trim().toLowerCase())
      .filter(Boolean)
    recipientCount = ownerEmails.length

    if (actor && ownerEmails.length) {
      const subject =
        input.type === 'system' || input.type === 'warning'
          ? `Important notice from ${targetProfile?.name || 'vBiz Me'}`
          : `Update from ${targetProfile?.name || 'vBiz Me'}`
      const html = `<div style="font-family:sans-serif;line-height:1.5"><p>${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>')}</p></div>`
      await Promise.all(
        ownerEmails.map((email) =>
          authUtils.sendEmail({ receiverMail: email, subject, html }).catch((err) => {
            logger.error('Team notice owner email failed', email, err)
          })
        )
      )
      void announcementService
        .create(actor, {
          type:
            input.type === 'warning' || input.type === 'system'
              ? 'warning'
              : input.type === 'success'
                ? 'success'
                : 'info',
          title: `Card notice · ${targetProfile?.name || targetProfile?.slug || 'vCard'}`,
          body: text,
          status: 'active',
          targetType: 'specific',
          targetEmails: [...new Set(ownerEmails)],
          meta: { profileId: targetProfileId, source: 'card_notice', onlyBackoffice: '1' },
        })
        .catch((error) => logger.error('Card owner backoffice notice failed', { targetProfileId, error }))
    }

    const row = await prisma.teamNotice.create({
      data: {
        ownerId: userId,
        text,
        type: input.type,
        audience: 'savers',
        targetProfileId,
        recipientCount: recipientCount ?? 0,
        status: 'active',
      },
    })
    return serializeTeamNotice(row, staff ? 'admin' : 'owner')
  }

  if ((input.audience === 'savers' || shouldDeliver) && !onlyBackoffice) {
    const profiles = await listForUser(userId, role)
    const ids = targetProfileId ? [targetProfileId] : profiles.map((p) => p.id)
    if (!emptyProfileIds(ids)) {
      const [guests, contacts, targetProfile, actor] = await Promise.all([
        prisma.guestUserData.findMany({
          where: { profileId: { in: ids }, email: { not: null } },
          select: { email: true },
        }),
        prisma.contact.findMany({
          where: { profileId: { in: ids }, email: { not: null } },
          select: { email: true },
        }),
        targetProfileId
          ? prisma.profile.findUnique({
              where: { id: targetProfileId },
              select: {
                id: true,
                name: true,
                slug: true,
                email: true,
                user: { select: { email: true } },
                companyUser: { select: { email: true } },
              },
            })
          : null,
        prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
      ])
      const saverEmails = [
        ...new Set([...guests, ...contacts].map((r) => (r.email || '').trim().toLowerCase()).filter(Boolean)),
      ]
      const ownerEmails = shouldDeliver
        ? [targetProfile?.user?.email, targetProfile?.companyUser?.email, targetProfile?.email]
            .map((email) => (email || '').trim().toLowerCase())
            .filter(Boolean)
        : []
      const emails = [...new Set([...saverEmails, ...ownerEmails])]
      recipientCount = emails.length
      const subject =
        input.type === 'system' || input.type === 'warning'
          ? `Important notice from ${targetProfile?.name || 'vBiz Me'}`
          : `Update from ${targetProfile?.name || 'vBiz Me'}`
      const html = `<div style="font-family:sans-serif;line-height:1.5"><p>${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>')}</p></div>`

      await Promise.all(
        emails.map((email) =>
          authUtils.sendEmail({ receiverMail: email, subject, html }).catch((err) => {
            logger.error('Team notice email failed', email, err)
          })
        )
      )

      if (shouldDeliver && targetProfileId) {
        pushService.notifyProfileUpdate(targetProfileId, {
          title: subject,
          body: text,
          type: 'announcement_updates',
          url: targetProfile?.slug ? buildFrontendPublicCardPath(targetProfile.slug) : undefined,
        })

        if (actor && ownerEmails.length) {
          void announcementService
            .create(actor, {
              type:
                input.type === 'warning' || input.type === 'system'
                  ? 'warning'
                  : input.type === 'success'
                    ? 'success'
                    : 'info',
              title: `Card notice · ${targetProfile?.name || targetProfile?.slug || 'vCard'}`,
              body: text,
              status: 'active',
              targetType: 'specific',
              targetEmails: [...new Set(ownerEmails)],
              meta: { profileId: targetProfileId, source: 'card_notice', channel: 'inbox' },
            })
            .catch((error) => logger.error('Card owner backoffice notice failed', { targetProfileId, error }))
        }
      }
    } else {
      recipientCount = 0
    }
  }

  // Replace prior active banner for the same card so only one notice shows per card.
  if (targetProfileId && input.audience === 'all') {
    await prisma.teamNotice.updateMany({
      where: {
        targetProfileId,
        audience: 'all',
        status: 'active',
      },
      data: { status: 'archived' },
    })
  }

  const created = await prisma.teamNotice.create({
    data: {
      ownerId: userId,
      text,
      type: input.type,
      audience: input.audience,
      targetProfileId: targetProfileId || null,
      recipientCount: recipientCount ?? null,
      status: 'active',
    },
  })

  return serializeTeamNotice(created)
}

const deleteTeamNotice = async (userId: string, role: string, noticeId: string) => {
  const existing = await prisma.teamNotice.findFirst({
    where: { id: noticeId },
    select: { id: true, ownerId: true, targetProfileId: true },
  })
  if (!existing) throw new AppError(404, 'Notice not found')

  const staff = isAdminRole(role)

  if (existing.ownerId === userId) {
    // Creator may always delete their own notice — unless the target card is suspended (owners only).
    if (!staff && existing.targetProfileId) {
      const profile = await prisma.profile.findUnique({
        where: { id: existing.targetProfileId },
        select: { status: { select: { name: true } } },
      })
      if (profile) assertOwnerCanMutateCard(profile, role)
    }
  } else if (staff) {
    // Staff may clear any card-targeted notice from the admin vCard Notice action.
    if (!existing.targetProfileId) throw new AppError(403, 'Not allowed to delete this notice')
  } else if (existing.targetProfileId) {
    const owned = await getOwnedLite(existing.targetProfileId, userId, role)
    assertOwnerCanMutateCard(owned, role)
  } else {
    throw new AppError(403, 'Not allowed to delete this notice')
  }

  await prisma.teamNotice.delete({ where: { id: noticeId } })
  if (existing.targetProfileId) {
    await announcementService.archiveCardNotices(existing.targetProfileId)
  }
  return { id: noticeId, deleted: true }
}

/** Active public-banner notices for a profile — only notices targeted at this card. */
const listPublicTeamNoticesForProfile = async (
  profileId: string,
  _knownOwnerIds?: string[],
  viewer?: PublicViewerIdentity,
  origin?: 'admin' | 'owner'
): Promise<TeamNoticeRow[]> => {
  const id = profileId.trim()
  if (!id) return []

  const rows = await prisma.teamNotice.findMany({
    where: {
      status: 'active',
      audience: 'all',
      // Include admin-created notices (ownerId is the admin, not the card owner).
      // Never fan out null-target notices to every card — announcements are per-card.
      targetProfileId: id,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  const authorIds = [...new Set(rows.map((row) => row.ownerId).filter(Boolean))]
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, role: true },
      })
    : []
  const staffAuthorIds = new Set(
    authors.filter((author) => isAdminRole(toApiRole(author.role))).map((author) => author.id)
  )

  const filtered: TeamNoticeRow[] = []
  for (const row of rows) {
    if (await isTeamNoticeSuppressed(profileId, row.id, viewer)) continue
    const source: 'admin' | 'owner' = staffAuthorIds.has(row.ownerId) ? 'admin' : 'owner'
    if (origin && source !== origin) continue
    filtered.push(serializeTeamNotice(row, source))
  }
  return filtered
}

const getLatestPublicTeamNoticeForProfile = async (
  profileId: string,
  viewer?: PublicViewerIdentity,
  origin?: 'admin' | 'owner'
): Promise<TeamNoticeRow | null> => {
  const notices = await listPublicTeamNoticesForProfile(profileId, undefined, viewer, origin)
  return notices[0] ?? null
}

const dismissPublicTeamNotice = async (opts: { profileId: string; noticeId: string; viewer: PublicViewerIdentity }) => {
  const profileId = opts.profileId.trim()
  const noticeId = opts.noticeId.trim()
  if (!profileId || !noticeId) throw new AppError(400, 'profileId and noticeId are required')

  const existing = await prisma.teamNotice.findFirst({
    where: { id: noticeId, targetProfileId: profileId, status: 'active', audience: 'all' },
    select: { id: true },
  })
  if (!existing) throw new AppError(404, 'Notice not found')

  // Permanent dismiss (same contract as global public announcements) — not a 24h snooze.
  await writeTeamNoticeViewerState({
    profileId,
    noticeId,
    viewer: opts.viewer,
    dismissedAt: new Date(),
    suppressUntil: null,
  })

  return { id: noticeId, dismissed: true }
}

export type PortfolioMemberRow = {
  id: string
  name: string | null
  email: string
  role: string
  staffRole: string | null
}

const listPortfolioMembers = async (userId: string, role: string): Promise<PortfolioMemberRow[]> => {
  const ids = await resolveAdminPortfolioUserIds(userId, role)
  const rows = await prisma.user.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      role: { in: [UserRole.ADMIN, UserRole.SUPER_ADMIN] },
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      staffRole: true,
    },
  })

  const mapped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: toApiRole(row.role),
    staffRole: row.staffRole,
  }))

  mapped.sort((a, b) => {
    if (a.id === userId) return -1
    if (b.id === userId) return 1
    const aLabel = (a.name || a.email).toLowerCase()
    const bLabel = (b.name || b.email).toLowerCase()
    return aLabel.localeCompare(bLabel)
  })

  return mapped
}

const profileService = {
  listForUser,
  listProfilesPage,
  getCardCapacity,
  getOwned,
  getOwnedLite,
  getOwnedForWrite,
  create,
  duplicate,
  update,
  remove,
  replaceCollection,
  getAboutMe,
  upsertAboutMe,
  deleteAboutMe,
  createPost,
  updatePost,
  deletePost,
  listPosts,
  getDashboardStats,
  getDashboardSummary,
  getLiveSocialClicks,
  getSocialClicksByCard,
  notifyLiveSocialClicks,
  getWeeklyEngagement,
  getConsolidatedEngagement,
  listRecentEngagement,
  listContacts,
  listContactsPage,
  patchContact,
  exportContactsCsv,
  listTeamNotices,
  createTeamNotice,
  deleteTeamNotice,
  listPublicTeamNoticesForProfile,
  getLatestPublicTeamNoticeForProfile,
  dismissPublicTeamNotice,
  listPackages,
  listSubscriptions,
  getEntitlements,
  ensureUniqueSlug,
  checkSlugAvailability,
  listPortfolioMembers,
}

export default profileService

export type { LiveSocialClickRow, SocialChannel }
