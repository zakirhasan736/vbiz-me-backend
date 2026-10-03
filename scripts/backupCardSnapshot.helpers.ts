import { cloneRecord, SHARED_DUPLICATE_LIST_MODELS } from '../src/utils/duplicateCard'

export const CARD_SNAPSHOT_VERSION = 1 as const

/** Business/list tabs that corporate sibling sync can overwrite. */
export const SNAPSHOT_LIST_MODELS = [
  ...SHARED_DUPLICATE_LIST_MODELS.filter((model) => model !== 'socialLink' && model !== 'address'),
  'whyChooseUs',
] as const

export type CardSnapshot = {
  version: typeof CARD_SNAPSHOT_VERSION
  createdAt: string
  slug: string
  profileId: string
  name: string
  email: string
  /** Active/selected nav checkboxes, banners, home media URLs, custom tabs JSON, etc. */
  settings: Record<string, string>
  profile: {
    avatar: string | null
    about: string | null
    template: string
    themeConfig: unknown
    colorCode: string
  }
  profileSettings: {
    profileTemplate: string
    layoutStyle: string | null
    buttonStyle: string | null
    cornerStyle: string | null
    themeConfig: unknown
  } | null
  aboutMe: Record<string, unknown> | null
  /** custom tab key → tab + items (ids stripped) */
  customTabs: Array<{
    key: string
    label: string
    slug: string
    description: string | null
    icon: string | null
    sortOrder: number
    isEnabled: boolean
    isPublic: boolean
    status: string
    layoutType: string
    settings: unknown
    items: Array<Record<string, unknown>>
  }>
  lists: Record<string, Array<Record<string, unknown>>>
  posts: Array<{
    postTypeId: string | null
    title: string | null
    description: string | null
    status: string
    url: string | null
    featuredImage: string | null
    sortOrder: number
    metas: Array<{ metaKey: string; metaValue: string | null }>
  }>
  /** Media attachment URLs only (no binary). */
  attachments: Array<{
    url: string | null
    publicId: string | null
    typeName: string | null
    sortOrder?: number
  }>
  counts: Record<string, number>
}

export function stripRow(row: Record<string, unknown>): Record<string, unknown> {
  return cloneRecord(row)
}

export function summarizeSnapshot(snapshot: CardSnapshot) {
  return {
    slug: snapshot.slug,
    createdAt: snapshot.createdAt,
    settingKeys: Object.keys(snapshot.settings).length,
    customTabs: snapshot.customTabs.length,
    lists: Object.fromEntries(
      Object.entries(snapshot.lists)
        .map(([key, rows]): [string, number] => [key, rows.length])
        .filter((entry): entry is [string, number] => entry[1] > 0)
    ),
    posts: snapshot.posts.length,
    attachments: snapshot.attachments.length,
    hasAboutMe: Boolean(snapshot.aboutMe),
    hasDisplaySettings: Boolean(snapshot.settings.display_settings_json),
    hasTabSectionMeta: Boolean(snapshot.settings.tab_section_meta_json),
    hasCustomTabsJson: Boolean(snapshot.settings.custom_tabs_json),
    mediaHints: {
      avatar: snapshot.profile.avatar || null,
      background:
        snapshot.settings.background_media_url ||
        snapshot.settings.bg_media_url ||
        snapshot.settings.background_video_url ||
        null,
      profileMedia: snapshot.settings.profile_media_url || snapshot.settings.profile_image_url || null,
    },
  }
}
