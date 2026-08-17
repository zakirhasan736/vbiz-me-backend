import { prisma } from '../utils/prisma'
import { isPrismaColumnMismatch, isPrismaMissingTable } from '../utils/prismaErrors'
import { getTabByKey, getTabByPublicSectionName, type DirectSectionStorage } from './tabRegistry'

export type DirectSectionRow = {
  id: string
  title: string | null
  description: string | null
  url: string | null
  featuredImage: string | null
  status: string
  sortOrder: number
  metas?: unknown
  createdAt: Date
}

export type ListSectionStorage = Exclude<
  DirectSectionStorage,
  'about_me' | 'service' | 'review' | 'gallery' | 'blog' | 'why_choose_us'
>
export type SingletonSectionStorage = 'why_choose_us'
type GenericStorage = ListSectionStorage | SingletonSectionStorage
type Loader = (profileId: string, take?: number) => Promise<DirectSectionRow[]>

const where = (profileId: string) => ({ profileId, deletedAt: null, status: '1' })
const orderBy = [{ sortOrder: 'asc' as const }, { createdAt: 'desc' as const }]

/** Live `Faq` / `MissionStatement` / `BlogDirect` columns — never select `metas`. */
export const LIVE_POST_STYLE_SELECT = {
  id: true,
  profileId: true,
  legacyPostId: true,
  legacyPostTypeId: true,
  title: true,
  description: true,
  url: true,
  featuredImage: true,
  status: true,
  sortOrder: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

const publicLiveWhere = (profileId: string) => ({
  profileId,
  deletedAt: null,
  status: { notIn: ['0', 'false', 'inactive', 'draft'] },
})

async function loadLivePostStyleRows(
  table: 'Faq' | 'MissionStatement',
  profileId: string,
  take?: number
): Promise<DirectSectionRow[]> {
  const limit = Math.min(200, Math.max(1, take ?? 100))
  const args = {
    where: publicLiveWhere(profileId),
    orderBy,
    take: limit,
    select: LIVE_POST_STYLE_SELECT,
  }
  try {
    const rows = table === 'Faq' ? await prisma.faq.findMany(args) : await prisma.missionStatement.findMany(args)
    return rows
  } catch (error) {
    if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
    const sql =
      table === 'Faq'
        ? prisma.$queryRaw<DirectSectionRow[]>`
            SELECT id, title, description, url, "featuredImage", status, "sortOrder", "createdAt"
            FROM "Faq"
            WHERE "profileId" = ${profileId}
              AND "deletedAt" IS NULL
              AND status NOT IN ('0', 'false', 'inactive', 'draft')
            ORDER BY "sortOrder" ASC, "createdAt" DESC
            LIMIT ${limit}
          `
        : prisma.$queryRaw<DirectSectionRow[]>`
            SELECT id, title, description, url, "featuredImage", status, "sortOrder", "createdAt"
            FROM "MissionStatement"
            WHERE "profileId" = ${profileId}
              AND "deletedAt" IS NULL
              AND status NOT IN ('0', 'false', 'inactive', 'draft')
            ORDER BY "sortOrder" ASC, "createdAt" DESC
            LIMIT ${limit}
          `
    return sql.catch((rawError) => {
      if (!isPrismaMissingTable(rawError) && !isPrismaColumnMismatch(rawError)) throw rawError
      return []
    })
  }
}

export const LIST_SECTION_MODELS = {
  client: prisma.client,
  video: prisma.video,
  general_post: prisma.generalPost,
  bbb_accreditation: prisma.bbbAccreditation,
  licensing: prisma.licensing,
  dcp: prisma.dcp,
  certificate_license: prisma.certificateLicense,
  insurance_license: prisma.insuranceLicense,
  faq: prisma.faq,
  calendar_section: prisma.calendarSection,
  property_listing: prisma.propertyListing,
  profile_event: prisma.profileEvent,
  media_press: prisma.mediaPress,
  mission_statement: prisma.missionStatement,
  video_explainer: prisma.videoExplainer,
  menu_section: prisma.menuSection,
  announcement_direct: prisma.announcementDirect,
  join_my_team: prisma.joinMyTeam,
  booking: prisma.booking,
  additional_service: prisma.additionalService,
  video_link: prisma.videoLink,
  inventory: prisma.inventory,
  home_solar: prisma.homeSolar,
  resiliency_product: prisma.resiliencyProduct,
  breakfast: prisma.breakfast,
  lunch: prisma.lunch,
  dinner: prisma.dinner,
  product: prisma.product,
  sales_person: prisma.salesPerson,
  team_member: prisma.teamMember,
} satisfies Record<ListSectionStorage, unknown>

export const DIRECT_SECTION_LOADERS: Record<GenericStorage, Loader> = {
  client: (profileId, take) => prisma.client.findMany({ where: where(profileId), orderBy, take }),
  video: (profileId, take) => prisma.video.findMany({ where: where(profileId), orderBy, take }),
  general_post: (profileId, take) => prisma.generalPost.findMany({ where: where(profileId), orderBy, take }),
  bbb_accreditation: (profileId, take) => prisma.bbbAccreditation.findMany({ where: where(profileId), orderBy, take }),
  licensing: (profileId, take) => prisma.licensing.findMany({ where: where(profileId), orderBy, take }),
  dcp: (profileId, take) => prisma.dcp.findMany({ where: where(profileId), orderBy, take }),
  certificate_license: (profileId, take) =>
    prisma.certificateLicense.findMany({ where: where(profileId), orderBy, take }),
  insurance_license: (profileId, take) => prisma.insuranceLicense.findMany({ where: where(profileId), orderBy, take }),
  faq: (profileId, take) => loadLivePostStyleRows('Faq', profileId, take),
  calendar_section: (profileId, take) => prisma.calendarSection.findMany({ where: where(profileId), orderBy, take }),
  property_listing: (profileId, take) => prisma.propertyListing.findMany({ where: where(profileId), orderBy, take }),
  profile_event: (profileId, take) => prisma.profileEvent.findMany({ where: where(profileId), orderBy, take }),
  media_press: (profileId, take) => prisma.mediaPress.findMany({ where: where(profileId), orderBy, take }),
  mission_statement: (profileId, take) => loadLivePostStyleRows('MissionStatement', profileId, take),
  video_explainer: (profileId, take) => prisma.videoExplainer.findMany({ where: where(profileId), orderBy, take }),
  menu_section: (profileId, take) => prisma.menuSection.findMany({ where: where(profileId), orderBy, take }),
  why_choose_us: async (profileId) => {
    const row = await prisma.whyChooseUs.findUnique({ where: { profileId } })
    return row && row.status === '1'
      ? [
          {
            ...row,
            url: null,
            featuredImage: row.featuredMediaUrl,
            sortOrder: 0,
            metas: null,
          },
        ]
      : []
  },
  announcement_direct: (profileId, take) =>
    prisma.announcementDirect.findMany({ where: where(profileId), orderBy, take }),
  join_my_team: (profileId, take) => prisma.joinMyTeam.findMany({ where: where(profileId), orderBy, take }),
  booking: (profileId, take) => prisma.booking.findMany({ where: where(profileId), orderBy, take }),
  additional_service: (profileId, take) =>
    prisma.additionalService.findMany({ where: where(profileId), orderBy, take }),
  video_link: (profileId, take) => prisma.videoLink.findMany({ where: where(profileId), orderBy, take }),
  inventory: (profileId, take) => prisma.inventory.findMany({ where: where(profileId), orderBy, take }),
  home_solar: (profileId, take) => prisma.homeSolar.findMany({ where: where(profileId), orderBy, take }),
  resiliency_product: (profileId, take) =>
    prisma.resiliencyProduct.findMany({ where: where(profileId), orderBy, take }),
  breakfast: (profileId, take) => prisma.breakfast.findMany({ where: where(profileId), orderBy, take }),
  lunch: (profileId, take) => prisma.lunch.findMany({ where: where(profileId), orderBy, take }),
  dinner: (profileId, take) => prisma.dinner.findMany({ where: where(profileId), orderBy, take }),
  product: (profileId, take) => prisma.product.findMany({ where: where(profileId), orderBy, take }),
  sales_person: (profileId, take) => prisma.salesPerson.findMany({ where: where(profileId), orderBy, take }),
  team_member: (profileId, take) => prisma.teamMember.findMany({ where: where(profileId), orderBy, take }),
}

export function isGenericDirectStorage(storage: DirectSectionStorage): storage is GenericStorage {
  return storage in DIRECT_SECTION_LOADERS
}

export function isListSectionStorage(storage: DirectSectionStorage): storage is ListSectionStorage {
  return storage in LIST_SECTION_MODELS
}

export function isSingletonSectionStorage(storage: DirectSectionStorage): storage is SingletonSectionStorage {
  return storage === 'why_choose_us'
}

export async function countPublicSection(storage: DirectSectionStorage, profileId: string): Promise<number> {
  if (isListSectionStorage(storage)) {
    const model = LIST_SECTION_MODELS[storage] as unknown as {
      count(args: { where: { profileId: string; deletedAt: null; status: string } }): Promise<number>
    }
    return model.count({ where: where(profileId) })
  }
  if (isSingletonSectionStorage(storage)) {
    return prisma.whyChooseUs.count({ where: { profileId, status: '1' } })
  }
  switch (storage) {
    case 'about_me':
      return prisma.aboutMe.count({ where: { profileId, status: '1' } })
    case 'service':
      return prisma.service.count({ where: { profileId, status: 1 } })
    case 'review':
      return prisma.review.count({ where: { profileId, status: 1 } })
    case 'gallery':
      return prisma.gallery.count({ where: where(profileId) })
    case 'blog':
      return prisma.blog.count({ where: where(profileId) })
  }
}

/**
 * Returns every populated dedicated public storage in one database round trip.
 * Physical names follow Prisma's model names, including explicit @@map names.
 */
async function listPopulatedStoragesFromPosts(profileId: string): Promise<Set<DirectSectionStorage>> {
  const populated = new Set<DirectSectionStorage>()
  const [posts, about, services, reviews, blogs] = await Promise.all([
    prisma.post.findMany({
      where: { profileId, deletedAt: null, status: '1' },
      include: { postType: true },
      distinct: ['postTypeId'],
    }),
    prisma.aboutMe.count({ where: { profileId, status: '1' } }),
    prisma.service.count({ where: { profileId, status: 1 } }),
    prisma.review.count({ where: { profileId, status: 1 } }),
    prisma.blog.count({ where: { profileId, deletedAt: null, status: '1' } }),
  ])
  if (about > 0) populated.add('about_me')
  if (services > 0) populated.add('service')
  if (reviews > 0) populated.add('review')
  if (blogs > 0) populated.add('blog')
  const [portfolioCount, galleryCount, faqCount, clientCount, tabKeys] = await Promise.all([
    prisma.portfolio.count({ where: { profileId, status: 1 } }).catch(() => 0),
    prisma.gallery.count({ where: { profileId, deletedAt: null, status: '1' } }).catch(() => 0),
    prisma.faq.count({ where: { profileId, deletedAt: null, status: '1' } }).catch(() => 0),
    prisma.client.count({ where: { profileId, deletedAt: null, status: '1' } }).catch(() => 0),
    prisma.tabItem
      .findMany({
        where: { profileId, deletedAt: null, status: '1' },
        distinct: ['tabKey'],
        select: { tabKey: true },
      })
      .catch(() => [] as Array<{ tabKey: string }>),
  ])
  if (portfolioCount > 0 || galleryCount > 0) populated.add('gallery')
  if (faqCount > 0) populated.add('faq')
  if (clientCount > 0) populated.add('client')
  for (const row of tabKeys) {
    const tab = getTabByKey(row.tabKey)
    if (tab) populated.add(tab.storage)
  }
  for (const post of posts) {
    const tab =
      getTabByPublicSectionName(post.postType?.name || '') || getTabByPublicSectionName(post.postType?.title || '')
    if (tab) populated.add(tab.storage)
  }
  return populated
}

export async function listPopulatedStorages(profileId: string): Promise<Set<DirectSectionStorage>> {
  try {
    const rows = await prisma.$queryRaw<Array<{ storage: DirectSectionStorage }>>`
    SELECT 'about_me' AS storage WHERE EXISTS (SELECT 1 FROM "AboutMe" WHERE "profileId" = ${profileId} AND status = '1')
    UNION ALL SELECT 'service' WHERE EXISTS (SELECT 1 FROM "Service" WHERE "profileId" = ${profileId} AND status = 1)
    UNION ALL SELECT 'review' WHERE EXISTS (SELECT 1 FROM "Review" WHERE "profileId" = ${profileId} AND status = 1)
    UNION ALL SELECT 'gallery' WHERE EXISTS (SELECT 1 FROM "Gallery" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'gallery' WHERE EXISTS (SELECT 1 FROM "Portfolio" WHERE "profileId" = ${profileId} AND status = 1)
    UNION ALL SELECT 'blog' WHERE EXISTS (SELECT 1 FROM "BlogDirect" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'client' WHERE EXISTS (SELECT 1 FROM "Client" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'video' WHERE EXISTS (SELECT 1 FROM "Video" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'general_post' WHERE EXISTS (SELECT 1 FROM "GeneralPost" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'bbb_accreditation' WHERE EXISTS (SELECT 1 FROM "BBBAccreditation" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'licensing' WHERE EXISTS (SELECT 1 FROM "Licensing" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'dcp' WHERE EXISTS (SELECT 1 FROM "DCP" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'certificate_license' WHERE EXISTS (SELECT 1 FROM "CertificateLicense" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'insurance_license' WHERE EXISTS (SELECT 1 FROM "InsuranceLicense" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'faq' WHERE EXISTS (SELECT 1 FROM "Faq" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'calendar_section' WHERE EXISTS (SELECT 1 FROM "CalendarSection" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'property_listing' WHERE EXISTS (SELECT 1 FROM "PropertyListing" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'profile_event' WHERE EXISTS (SELECT 1 FROM "Event" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'media_press' WHERE EXISTS (SELECT 1 FROM "MediaPress" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'mission_statement' WHERE EXISTS (SELECT 1 FROM "MissionStatement" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'video_explainer' WHERE EXISTS (SELECT 1 FROM "VideoExplainer" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'menu_section' WHERE EXISTS (SELECT 1 FROM "MenuSection" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'why_choose_us' WHERE EXISTS (SELECT 1 FROM "WhyChooseUs" WHERE "profileId" = ${profileId} AND status = '1')
    UNION ALL SELECT 'announcement_direct' WHERE EXISTS (SELECT 1 FROM "AnnouncementDirect" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'join_my_team' WHERE EXISTS (SELECT 1 FROM "JoinMyTeam" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'booking' WHERE EXISTS (SELECT 1 FROM "Booking" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'additional_service' WHERE EXISTS (SELECT 1 FROM "AdditionalService" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'video_link' WHERE EXISTS (SELECT 1 FROM "VideoLink" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'inventory' WHERE EXISTS (SELECT 1 FROM "Inventory" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'home_solar' WHERE EXISTS (SELECT 1 FROM "HomeSolar" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'resiliency_product' WHERE EXISTS (SELECT 1 FROM "ResiliencyProduct" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'breakfast' WHERE EXISTS (SELECT 1 FROM "Breakfast" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'lunch' WHERE EXISTS (SELECT 1 FROM "Lunch" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'dinner' WHERE EXISTS (SELECT 1 FROM "Dinner" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'product' WHERE EXISTS (SELECT 1 FROM "Product" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'sales_person' WHERE EXISTS (SELECT 1 FROM "SalesPerson" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
    UNION ALL SELECT 'team_member' WHERE EXISTS (SELECT 1 FROM "TeamMember" WHERE "profileId" = ${profileId} AND "deletedAt" IS NULL AND status = '1')
  `
    const dedicated = new Set(rows.map((row) => row.storage))
    const fallback = await listPopulatedStoragesFromPosts(profileId)
    return new Set([...dedicated, ...fallback])
  } catch (error) {
    if (!isPrismaMissingTable(error)) throw error
    return listPopulatedStoragesFromPosts(profileId)
  }
}
