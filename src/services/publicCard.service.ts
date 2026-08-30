import type { Attachment, Prisma, Setting } from '../../generated/prisma/client'
import config from '../configs/config'
import { DIRECT_SECTION_LOADERS, isGenericDirectStorage } from '../constants/directSectionStorage'
import {
  applyCanonicalPublicNavOrder,
  mergeEnabledNavOrder,
  shouldPreserveCustomNavOrder,
} from '../constants/publicNavOrder'
import {
  getTabByPublicSectionName,
  NAV_CHECKBOX_TO_TAB_KEY,
  NAV_ID_TO_TAB_KEY,
  TAB_KEY_TO_NAV_ID,
  TAB_REGISTRY,
} from '../constants/tabRegistry'
import AppError from '../error/AppError'
import { publicReadableWhere, publicVisibleWhere, slugEquals } from '../utils/cardStatus'
import { fillMissingGalleryMedia, galleryHasMedia, listGalleriesForProfile } from '../utils/galleryMedia'
import { liveDashboardHub } from '../utils/liveDashboardHub'
import logger from '../utils/logger'
import { logPublicSectionMedia } from '../utils/logPublicSectionMedia'
import { ensureAbsoluteMediaUrl, looksLikeExternalPageUrl, looksLikeMediaAssetUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'
import { isPrismaColumnMismatch, isPrismaMissingTable, isPrismaSchemaDrift } from '../utils/prismaErrors'
import profileService from './profile.service'
import { getPublicAssistantSupplement } from './profileAssistant.service'
import { mediaFromProfile } from './push.service'

const RETURNING_SAVED_GUEST_EVENT = 'returning_saved_guest'
const RETURNING_SAVED_GUEST_DELAY_MS = 3 * 24 * 60 * 60 * 1000

const ATTACHMENT_TYPE_ALIASES: Record<string, string[]> = {
  profile: ['profile picture', 'profile pic', 'profile_pic', 'avatar', 'profile image', 'profile'],
  background: ['background video/image', 'background_media', 'bg_video', 'bg video', 'background video', 'background'],
  intro: ['intro vcard video', 'intro video', '2d explainer', '2d video', 'profile video', 'intro'],
  audio: ['background music', 'background audio', 'bg music', 'audio', 'music'],
}

type AttachmentWithType = Attachment & {
  attachmentType?: { name: string | null; legacyId?: number | null } | null
}

type MediaBlock = {
  enabled: boolean
  url: string | null
  video_url: string | null
  fallback_url?: string | null
  type?: string
  is_video: boolean
  doc_name?: string
  extension?: string
  youtube?: { link?: string; embed_url?: string; video_id?: string }
  regular_video?: { url?: string | null }
}

type BackgroundAudioBlock = {
  enabled: boolean
  use_youtube_link?: boolean
  url?: string
  doc_name?: string
  youtube?: { link?: string; video_id?: string; embed_url?: string }
  repeat?: boolean
}

function telHref(phone?: string | null): string | undefined {
  const digits = String(phone || '').replace(/[^\d+]/g, '')
  return digits ? `tel:${digits}` : undefined
}

function smsHref(phone?: string | null): string | undefined {
  const digits = String(phone || '').replace(/[^\d+]/g, '')
  return digits ? `sms:${digits}` : undefined
}

function parseMyInfoActions(map: Record<string, string>) {
  const defaults = {
    headline: 'Ready When You Are',
    showCall: true,
    showText: true,
    showEmail: true,
    callLabel: 'Call Now',
    textLabel: 'Shoot Me A Text',
    emailLabel: 'Email Me',
  }
  const raw = map.my_info_json
  if (!raw?.trim()) return defaults
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o)) return defaults
    const str = (value: unknown, fallback: string) =>
      typeof value === 'string' && value.trim() ? value.trim() : fallback
    const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
    return {
      headline: str(o.headline, defaults.headline),
      showCall: bool(o.showCall, defaults.showCall),
      showText: bool(o.showText, defaults.showText),
      showEmail: bool(o.showEmail, defaults.showEmail),
      callLabel: str(o.callLabel, defaults.callLabel),
      textLabel: str(o.textLabel, defaults.textLabel),
      emailLabel: str(o.emailLabel, defaults.emailLabel),
    }
  } catch {
    return defaults
  }
}

function parseDisplayNavState(map: Record<string, string>): { ids: string[]; customized: boolean } {
  const rawJson = map.display_settings_json
  if (!rawJson?.trim()) return { ids: [], customized: false }
  try {
    const parsed = JSON.parse(rawJson) as { editorNavOrder?: unknown; navOrderCustomized?: unknown }
    const order = Array.isArray(parsed.editorNavOrder) ? parsed.editorNavOrder : []
    const ids = Array.from(new Set(order.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))))
    return { ids, customized: parsed.navOrderCustomized === true }
  } catch {
    return { ids: [], customized: false }
  }
}

function collectEditorNavIds(
  map: Record<string, string>,
  enabledNavIds: string[],
  options?: { slug?: string | null }
): string[] {
  const { ids, customized } = parseDisplayNavState(map)
  const preserveCustom = shouldPreserveCustomNavOrder(options?.slug, customized)
  return mergeEnabledNavOrder(ids, enabledNavIds, { preserveCustom })
}

const EXTRA_NAV_POST_TYPES: Record<string, { name: string; title: string }> = {
  home: { name: 'Home', title: 'Home' },
  about: { name: 'About Me', title: 'About Me' },
  education: { name: 'Education', title: 'Education' },
  work: { name: 'Work Experience', title: 'Work Experience' },
  skills: { name: 'skills', title: 'Skills' },
  resume: { name: 'Resume', title: 'Resume' },
  profile: { name: 'Profile', title: 'Profile' },
  'public-cards': { name: 'Public Cards', title: 'Public Cards' },
  'my-info': { name: 'My Info', title: 'My Info' },
  'global-connection': { name: 'Global Connection', title: 'Global Connection' },
  'content-media': { name: 'Content & media', title: 'Content & media' },
  'contact-us': { name: 'Contact Us', title: 'Contact Us' },
}

function collectEnabledTabKeys(map: Record<string, string>): Set<string> {
  const keys = new Set<string>()
  for (const [checkbox, tabKey] of Object.entries(NAV_CHECKBOX_TO_TAB_KEY)) {
    const value = map[checkbox]
    if (value === '1' || value === 'true') keys.add(tabKey)
  }
  const rawJson = map.display_settings_json
  if (!rawJson?.trim()) return keys
  try {
    const parsed = JSON.parse(rawJson) as {
      editorNavOrder?: unknown
      fields?: Record<string, { visible?: boolean }>
    }
    const order = Array.isArray(parsed.editorNavOrder) ? parsed.editorNavOrder : []
    for (const id of order) {
      if (typeof id !== 'string') continue
      keys.add(id)
      const tabKey = NAV_ID_TO_TAB_KEY[id] || id
      if (TAB_REGISTRY[tabKey]) keys.add(tabKey)
    }
  } catch {
    /* ignore invalid snapshot */
  }
  return keys
}

function settingsToMap(settings: Setting[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const s of settings) {
    map[s.key] = s.value ?? ''
  }
  return map
}

function isSettingEnabled(settings: Record<string, string>, ...keys: string[]) {
  let sawDefined = false
  for (const key of keys) {
    const value = settings[key]
    if (value === undefined) continue
    sawDefined = true
    if (value === '1' || value === 'true') return true
  }
  // Missing checkbox defaults to enabled for media (legacy behavior).
  // If every provided key is explicitly off, treat as disabled.
  return !sawDefined
}

function extractYoutubeVideoId(url?: string | null): string | null {
  if (!url?.trim()) return null
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0]
      return id || null
    }
    if (host.endsWith('youtube.com')) {
      const fromQuery = parsed.searchParams.get('v')
      if (fromQuery) return fromQuery
      const parts = parsed.pathname.split('/').filter(Boolean)
      const embedIndex = parts.indexOf('embed')
      if (embedIndex >= 0 && parts[embedIndex + 1]) return parts[embedIndex + 1]
      const shortsIndex = parts.indexOf('shorts')
      if (shortsIndex >= 0 && parts[shortsIndex + 1]) return parts[shortsIndex + 1]
    }
  } catch {
    /* not a URL */
  }
  return null
}

function isYoutubeUrl(url?: string | null): boolean {
  return Boolean(extractYoutubeVideoId(url))
}

function splitExplainerMedia(
  featured?: string | null,
  url?: string | null
): { videoUrl: string; external: string | null } {
  const featuredValue = featured?.trim() || ''
  const urlValue = url?.trim() || ''
  const file = [featuredValue, urlValue].find((value) => value && !isYoutubeUrl(value)) || ''
  const youtube = [urlValue, featuredValue].find((value) => value && isYoutubeUrl(value)) || ''
  let external: string | null = youtube || null
  if (!external && urlValue && urlValue !== file && /^https?:\/\//i.test(urlValue)) {
    external = urlValue
  }
  return { videoUrl: file, external }
}

function isDurableMediaUrl(url?: string | null): boolean {
  if (!url?.trim()) return false
  const trimmed = url.trim()
  if (trimmed.startsWith('blob:')) return false
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')
}

function attachmentLabel(att: AttachmentWithType): string {
  return `${att.attachmentType?.name || ''} ${att.docName || ''}`.toLowerCase()
}

function scoreAttachmentAlias(label: string, aliases: string[]): number {
  let best = -1
  for (const alias of aliases) {
    if (!label.includes(alias)) continue
    best = Math.max(best, alias.length)
  }
  return best
}

function resolveAttachmentUrl(att: AttachmentWithType | undefined, profileLegacyId?: number | null) {
  if (!att) return null
  return ensureAbsoluteMediaUrl(att.url, {
    docName: att.docName,
    attachmentTypeLegacyId: att.attachmentType?.legacyId ?? null,
    attachmentTypeName: att.attachmentType?.name ?? null,
    profileLegacyId,
  })
}

function emptyMediaBlock(): MediaBlock {
  return { enabled: false, url: null, video_url: null, is_video: false }
}

function toMediaBlockFromUrl(
  url: string | null | undefined,
  enabled = true,
  extras?: { doc_name?: string; extension?: string; resourceType?: string | null }
): MediaBlock {
  if (!url || !isDurableMediaUrl(url)) return emptyMediaBlock()
  const youtubeId = extractYoutubeVideoId(url)
  if (youtubeId) {
    const embedUrl = `https://www.youtube.com/embed/${youtubeId}`
    return {
      enabled,
      url,
      video_url: embedUrl,
      fallback_url: url,
      type: 'video',
      is_video: true,
      youtube: { link: url, embed_url: embedUrl, video_id: youtubeId },
      doc_name: extras?.doc_name,
      extension: extras?.extension,
    }
  }
  const ext = extras?.extension?.toLowerCase()
  const isVideo =
    extras?.resourceType === 'video' ||
    Boolean(ext && ['mp4', 'webm', 'mov', 'm4v', 'ogg', 'ogv'].includes(ext)) ||
    /\.(mp4|webm|mov|m4v|ogg|ogv)(\?|$)/i.test(url)
  return {
    enabled,
    url,
    video_url: isVideo ? url : null,
    fallback_url: url,
    type: isVideo ? 'video' : 'image',
    is_video: isVideo,
    regular_video: isVideo ? { url } : undefined,
    doc_name: extras?.doc_name,
    extension: extras?.extension,
  }
}

function toMediaBlock(
  att: AttachmentWithType | undefined,
  enabled = true,
  profileLegacyId?: number | null
): MediaBlock {
  const url = resolveAttachmentUrl(att, profileLegacyId)
  return toMediaBlockFromUrl(url, enabled, {
    doc_name: att?.docName || undefined,
    extension: att?.extension || undefined,
    resourceType: att?.resourceType,
  })
}

async function getProfileBySlugOrThrow(slug: string) {
  const profile = await prisma.profile.findFirst({
    where: { slug: slugEquals(slug), ...publicReadableWhere() },
    include: {
      gender: true,
      maritalStatus: true,
      profession: true,
      status: true,
      settings: true,
      profileSettings: true,
      socialLinks: true,
      attachments: { include: { attachmentType: true } },
      addresses: true,
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  return profile
}

function pickAttachment(attachments: AttachmentWithType[], kind: keyof typeof ATTACHMENT_TYPE_ALIASES) {
  const aliases = ATTACHMENT_TYPE_ALIASES[kind]
  let best: AttachmentWithType | undefined
  let bestScore = -1

  for (const att of attachments) {
    const label = attachmentLabel(att)
    if (kind === 'background' && (label.includes('music') || /\baudio\b/.test(label))) continue
    if (kind === 'intro' && (label.includes('music') || label.includes('background'))) continue
    if (kind === 'audio' && !(label.includes('music') || label.includes('audio'))) continue
    if (kind === 'profile' && (label.includes('intro') || label.includes('background') || label.includes('music'))) {
      continue
    }

    const score = Math.max(
      scoreAttachmentAlias(att.attachmentType?.name?.toLowerCase() || '', aliases),
      scoreAttachmentAlias(att.docName?.toLowerCase() || '', aliases)
    )
    if (score > bestScore) {
      bestScore = score
      best = att
    }
  }

  return bestScore >= 0 ? best : undefined
}

function resolveIntroMedia(
  attachments: AttachmentWithType[],
  settings: Record<string, string>,
  legacyId?: number | null
): MediaBlock {
  const enabled = isSettingEnabled(settings, 'profile_video_checkbox', 'profile_video_link_checkbox')

  // Prefer settings URLs from the editor; empty string = intentional clear (no attachment fallback).
  if (Object.prototype.hasOwnProperty.call(settings, 'intro_video_url')) {
    const fileUrl = settings.intro_video_url?.trim()
    if (fileUrl && !isYoutubeUrl(fileUrl)) return toMediaBlockFromUrl(fileUrl, enabled)
    if (!fileUrl && Object.prototype.hasOwnProperty.call(settings, 'intro_youtube_url')) {
      const youtubeUrl = settings.intro_youtube_url?.trim()
      if (youtubeUrl) return toMediaBlockFromUrl(youtubeUrl, enabled)
      return emptyMediaBlock()
    }
    if (!fileUrl) return emptyMediaBlock()
  }

  const fileUrl = settings.intro_video_url?.trim()
  if (fileUrl && !isYoutubeUrl(fileUrl)) {
    return toMediaBlockFromUrl(fileUrl, enabled)
  }

  const youtubeUrl = settings.intro_youtube_url?.trim() || (isYoutubeUrl(fileUrl) ? fileUrl : '')
  if (youtubeUrl) return toMediaBlockFromUrl(youtubeUrl, enabled)

  const fromAttachment = toMediaBlock(pickAttachment(attachments, 'intro'), enabled, legacyId)
  if (fromAttachment.url) return fromAttachment

  return emptyMediaBlock()
}

function resolveBackgroundMedia(
  attachments: AttachmentWithType[],
  settings: Record<string, string>,
  legacyId?: number | null
): MediaBlock {
  const enabled = isSettingEnabled(settings, 'background_video_checkbox', 'bg_video_checkbox')

  if (Object.prototype.hasOwnProperty.call(settings, 'background_media_url')) {
    const fileUrl = settings.background_media_url?.trim()
    if (fileUrl) return toMediaBlockFromUrl(fileUrl, enabled)
    return emptyMediaBlock()
  }

  const fileUrl = settings.background_media_url?.trim()
  if (fileUrl) return toMediaBlockFromUrl(fileUrl, enabled)

  const fromAttachment = toMediaBlock(pickAttachment(attachments, 'background'), enabled, legacyId)
  if (fromAttachment.url) return fromAttachment

  return emptyMediaBlock()
}

function resolveProfileMedia(
  attachments: AttachmentWithType[],
  settings: Record<string, string>,
  avatar: string | null | undefined,
  legacyId?: number | null
): MediaBlock {
  const enabled = isSettingEnabled(settings, 'profile_image_checkbox')

  if (Object.prototype.hasOwnProperty.call(settings, 'profile_media_url')) {
    const fromSettings = settings.profile_media_url?.trim()
    if (fromSettings && isDurableMediaUrl(fromSettings)) {
      return toMediaBlockFromUrl(fromSettings, enabled)
    }
    return emptyMediaBlock()
  }

  const fromSettings = settings.profile_media_url?.trim()
  if (fromSettings && isDurableMediaUrl(fromSettings)) {
    return toMediaBlockFromUrl(fromSettings, enabled)
  }

  const fromAttachment = toMediaBlock(pickAttachment(attachments, 'profile'), enabled, legacyId)
  if (fromAttachment.url) return fromAttachment

  if (avatar?.trim()) {
    const absolute = ensureAbsoluteMediaUrl(avatar.trim(), {
      docName: avatar.trim(),
      profileLegacyId: legacyId,
    })
    if (absolute) return toMediaBlockFromUrl(absolute, enabled)
  }

  return emptyMediaBlock()
}

function resolveBackgroundAudio(
  attachments: AttachmentWithType[],
  settings: Record<string, string>,
  legacyId?: number | null
): BackgroundAudioBlock | undefined {
  const fileEnabled = isSettingEnabled(settings, 'background_music_checkbox')
  const youtubeEnabled = isSettingEnabled(settings, 'background_music_link_checkbox')
  const repeat = settings.repeat_bg_music_checkbox !== '0' && settings.repeat_bg_music_checkbox !== 'false'

  const fileSettingUrl = settings.background_music_file_url?.trim()
  if (fileSettingUrl && isDurableMediaUrl(fileSettingUrl) && !isYoutubeUrl(fileSettingUrl) && fileEnabled) {
    return {
      enabled: true,
      url: fileSettingUrl,
      repeat,
    }
  }

  const musicUrl = settings.background_music_url?.trim()
  if (musicUrl && youtubeEnabled && isYoutubeUrl(musicUrl)) {
    const videoId = extractYoutubeVideoId(musicUrl)!
    return {
      enabled: true,
      use_youtube_link: true,
      youtube: {
        link: musicUrl,
        video_id: videoId,
        embed_url: `https://www.youtube.com/embed/${videoId}`,
      },
      repeat,
    }
  }

  if (musicUrl && fileEnabled && isDurableMediaUrl(musicUrl) && !isYoutubeUrl(musicUrl)) {
    return {
      enabled: true,
      url: musicUrl,
      repeat,
    }
  }

  const audioAtt = pickAttachment(attachments, 'audio')
  const attachmentUrl = resolveAttachmentUrl(audioAtt, legacyId)
  if (attachmentUrl && fileEnabled) {
    return {
      enabled: true,
      url: attachmentUrl,
      doc_name: audioAtt?.docName || undefined,
      repeat,
    }
  }

  return undefined
}

function buildMyCard(profile: Awaited<ReturnType<typeof getProfileBySlugOrThrow>>) {
  const settings = settingsToMap(profile.settings)
  const features: Record<string, boolean | string | number> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (k.endsWith('_checkbox')) {
      features[k.replace('_checkbox', '')] = v === '1' || v === 'true'
    }
  }

  const legacyId = profile.legacyId
  const background_media = resolveBackgroundMedia(profile.attachments, settings, legacyId)
  const intro_video = resolveIntroMedia(profile.attachments, settings, legacyId)
  const background_audio = resolveBackgroundAudio(profile.attachments, settings, legacyId)
  const profile_media = resolveProfileMedia(profile.attachments, settings, profile.avatar, legacyId)
  const stillIcon = mediaFromProfile({
    avatar: profile.avatar,
    legacyId,
    settings: profile.settings,
    attachments: profile.attachments,
  }).icon
  const stillAvatar =
    stillIcon || (profile_media.is_video ? profile_media.fallback_url : profile_media.url) || profile.avatar

  const template = profile.profileSettings?.profileTemplate || profile.template || 'default'

  const address = profile.addresses.find((a) => a.isPrimary) || profile.addresses[0]

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      slug: profile.slug,
      avatar: stillAvatar || profile.avatar,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      zip_code: profile.zipCode ?? address?.zipCode ?? null,
      zipCode: profile.zipCode ?? address?.zipCode ?? null,
      country: address?.country ?? null,
      website: profile.website,
      company_name: profile.companyName,
      designation: profile.designation,
      description: profile.about,
      profession: profile.profession?.name ?? profile.prof ?? null,
      gender: profile.gender?.name ?? null,
      marital_status: profile.maritalStatus?.name ?? null,
      facebook: profile.facebook,
      instagram: profile.instagram,
      twitter: profile.twitter,
      tiktok: profile.tiktok,
      youtube: profile.youtube,
      rumble: profile.rumble,
      truth: profile.truth,
      linkedin: profile.linkedin,
      pinterest: profile.pinterest,
      whatsapp: profile.whatsapp,
    },
    settings,
    features,
    template,
    background_media,
    intro_video,
    profile_media: profile_media.is_video
      ? { ...profile_media, fallback_url: profile_media.fallback_url || stillIcon || profile_media.fallback_url }
      : profile_media,
    action_buttons: {
      my_info: { enabled: settings.my_info_checkbox !== '0', label: 'My Info' },
      save_contact: {
        enabled: settings.save_contact_checkbox !== '0',
        label: 'Save Contact',
        data: {
          name: profile.name,
          email: profile.email,
          phone: profile.phone || '',
          company: profile.companyName || '',
          website: profile.website || '',
          note: profile.about || '',
          imageUrl: stillIcon || stillAvatar || '',
          slug: profile.slug || '',
        },
      },
      share: { enabled: settings.share_checkbox !== '0', label: 'Share' },
      refresh: { enabled: true, label: 'Refresh' },
      language: { enabled: settings.language_checkbox === '1', label: 'Language' },
      view_counter: { enabled: settings.view_counter_checkbox === '1', count: profile.viewCount },
    },
    my_info: {
      personal: {
        name: { enabled: true, value: profile.name },
        dob: { enabled: Boolean(profile.dob), value: profile.dob ? profile.dob.toISOString().slice(0, 10) : '' },
        gender: { enabled: Boolean(profile.gender), value: profile.gender?.name || '' },
        marital_status: {
          enabled: Boolean(profile.maritalStatus),
          value: profile.maritalStatus?.name || '',
        },
      },
      professional: {
        profession: { enabled: true, value: profile.profession?.name || profile.prof || '' },
        company: { enabled: true, value: profile.companyName || '' },
        designation: { enabled: true, value: profile.designation || '' },
      },
      contact: {
        email: {
          enabled: Boolean(profile.email),
          value: profile.email || '',
          mailto_url: profile.email ? `mailto:${profile.email}` : undefined,
        },
        phone: {
          enabled: Boolean(profile.phone),
          value: profile.phone || '',
          tel_url: telHref(profile.phone),
          sms_url: smsHref(profile.phone || profile.whatsapp),
        },
        whatsapp: { enabled: Boolean(profile.whatsapp), value: profile.whatsapp || '' },
        website: { enabled: Boolean(profile.website), value: profile.website || '', url: profile.website || undefined },
        address: {
          enabled: Boolean(profile.address || profile.zipCode),
          value: [profile.address, profile.zipCode].filter((part) => Boolean(part?.trim())).join(', '),
        },
        zip_code: {
          enabled: Boolean(profile.zipCode),
          value: profile.zipCode || '',
        },
      },
      actions: parseMyInfoActions(settings),
      additional_fields: profile.socialLinks.map((s) => ({
        key: s.name || 'link',
        value: s.url || '',
        icon: s.icon || undefined,
      })),
    },
    background_audio,
    theme_config: profile.themeConfig || profile.profileSettings?.themeConfig || undefined,
  }
}

const getMyCardBySlug = async (slug: string) => {
  const profile = await getProfileBySlugOrThrow(slug)
  return getMyCardFromProfile(profile)
}

const getMyCardFromProfile = async (profile: Awaited<ReturnType<typeof getProfileBySlugOrThrow>>) => {
  // viewCount is incremented only when a unique guest is tracked via trackEvent(profile_view).
  const card = await buildMyCard(profile)
  const [team_notices, gallery] = await Promise.all([
    profileService.listPublicTeamNoticesForProfile(
      profile.id,
      [profile.userId, profile.companyUserId].filter((id): id is string => Boolean(id))
    ),
    listGalleriesForProfile(profile.id, 200).then((rows) => rows.filter((row) => String(row.status) === '1')),
  ])
  const legacyPortfolio = await prisma.portfolio
    .findMany({
      where: { profileId: profile.id, status: 1 },
      orderBy: { sortOrder: 'asc' },
    })
    .catch(() => [])
  const hydratedGallery = fillMissingGalleryMedia(gallery, legacyPortfolio)
  const source = galleryHasMedia(hydratedGallery)
    ? hydratedGallery
    : legacyPortfolio.length
      ? legacyPortfolio
      : hydratedGallery
  const portfolio = source.map((item) => ({
    title: item.title,
    description: item.description,
    url: item.url,
    status: Number(item.status),
    imageUrl: 'featuredImage' in item ? item.featuredImage : item.imageUrl,
    attachmentUrl: item.attachmentUrl,
    attachmentName: item.attachmentName,
  }))
  return { ...card, portfolio, team_notices }
}

const getPostTypesForProfile = async (profileId: string, profileAlreadyValidated = false) => {
  const profile = await prisma.profile.findFirst({
    where: profileAlreadyValidated ? { id: profileId } : { id: profileId, ...publicReadableWhere() },
    select: { id: true, slug: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const settings = await prisma.setting.findMany({ where: { profileId } })
  const map = settingsToMap(settings)
  const enabledTabKeys = collectEnabledTabKeys(map)
  const enabledNavIds = [
    ...Array.from(enabledTabKeys, (key) => TAB_KEY_TO_NAV_ID[key] || key),
    'home',
    'about',
    'public-cards',
    'my-info',
  ]
  const editorNavIds = collectEditorNavIds(map, enabledNavIds, { slug: profile.slug })

  const StaticLink = editorNavIds.length
    ? []
    : [
        {
          id: 'home',
          title: 'Home',
          name: 'Home',
          post_type: 'static',
          active: true,
        },
        {
          id: 'about',
          title: 'About Me',
          name: 'About Me',
          post_type: 'static',
          active: map.aboutMeNav_checkbox === '1' || map.about_checkbox === '1' || enabledTabKeys.has('about_me'),
        },
        {
          id: 'public-cards',
          title: 'Public Cards',
          name: 'Public Cards',
          post_type: 'static',
          active: map.pCardsNav_checkbox === '1' || enabledTabKeys.has('public-cards'),
        },
      ].filter((i) => i.active)

  type PublicPostType = {
    id: string
    key: string
    name: string
    title: string
    status: string
    type_id: number | null
    slug: string | null
    type: 'standard' | 'custom'
  }

  const customTabs = await prisma.customTab
    .findMany({
      where: { profileId, isEnabled: true, isPublic: true, status: '1' },
      orderBy: { sortOrder: 'asc' },
    })
    .catch((error) => {
      if (!isPrismaSchemaDrift(error)) throw error
      return []
    })

  const navIds = mergeEnabledNavOrder(
    editorNavIds,
    customTabs.map((tab) => tab.id),
    { preserveCustom: shouldPreserveCustomNavOrder(profile.slug, parseDisplayNavState(map).customized) }
  )

  const rowFromNavId = (navId: string): PublicPostType | null => {
    const tabKey = NAV_ID_TO_TAB_KEY[navId]
    const tab = (tabKey && TAB_REGISTRY[tabKey]) || TAB_REGISTRY[navId]
    if (tab) {
      return {
        id: navId,
        key: navId,
        name: tab.publicSectionName,
        title: tab.label,
        status: 'active',
        type_id: tab.legacyPostTypeId,
        slug: tab.route,
        type: 'standard',
      }
    }
    const extra = EXTRA_NAV_POST_TYPES[navId]
    if (extra) {
      return {
        id: navId,
        key: navId,
        name: extra.name,
        title: extra.title,
        status: 'active',
        type_id: null,
        slug: navId,
        type: 'standard',
      }
    }
    const custom = customTabs.find((tab) => tab.id === navId || tab.key === navId || tab.slug === navId)
    if (custom) {
      return {
        id: custom.id,
        key: custom.id,
        name: custom.id,
        title: custom.label,
        status: 'active',
        type_id: null,
        slug: custom.id,
        type: 'custom',
      }
    }
    if (navId.startsWith('custom-tab-')) {
      return {
        id: navId,
        key: navId,
        name: navId,
        title: 'Custom tab',
        status: 'active',
        type_id: null,
        slug: navId,
        type: 'custom',
      }
    }
    return null
  }

  if (navIds.length) {
    const seen = new Set<string>()
    const post_types: PublicPostType[] = []
    for (const navId of navIds) {
      const row = rowFromNavId(navId)
      if (!row || seen.has(row.key)) continue
      seen.add(row.key)
      post_types.push(row)
    }
    return { StaticLink: [], post_types }
  }

  const post_types: PublicPostType[] = []
  const seenKeys = new Set<string>()
  for (const tab of Object.values(TAB_REGISTRY)) {
    if (!enabledTabKeys.has(tab.key) || seenKeys.has(tab.key)) continue
    seenKeys.add(tab.key)
    post_types.push({
      id: tab.key,
      key: tab.key,
      name: tab.publicSectionName,
      title: tab.label,
      status: 'active',
      type_id: tab.legacyPostTypeId,
      slug: tab.route,
      type: 'standard',
    })
  }

  for (const tab of customTabs) {
    if (seenKeys.has(tab.key) || seenKeys.has(tab.id) || seenKeys.has(tab.slug)) continue
    if (!enabledTabKeys.has(tab.key) && !enabledTabKeys.has(tab.id) && !enabledTabKeys.has(tab.slug)) {
      continue
    }
    seenKeys.add(tab.key)
    post_types.push({
      id: tab.id,
      key: tab.id,
      name: tab.id,
      title: tab.label,
      status: 'active',
      type_id: null,
      slug: tab.id,
      type: 'custom',
    })
  }

  for (const navId of Object.keys(EXTRA_NAV_POST_TYPES)) {
    if (post_types.some((tab) => tab.key === navId || tab.slug === navId)) continue
    if (!enabledTabKeys.has(navId) && !enabledTabKeys.has(NAV_ID_TO_TAB_KEY[navId] || '')) continue
    const row = rowFromNavId(navId)
    if (row) post_types.push(row)
  }

  const navIdForRow = (row: PublicPostType) => TAB_KEY_TO_NAV_ID[row.key] || TAB_KEY_TO_NAV_ID[row.id] || row.id
  const orderedIds = applyCanonicalPublicNavOrder(post_types.map(navIdForRow))
  const byNavId = new Map(post_types.map((row) => [navIdForRow(row), row]))
  const seen = new Set<string>()
  const ordered: PublicPostType[] = []
  for (const id of orderedIds) {
    const row = byNavId.get(id)
    if (!row || seen.has(row.key)) continue
    seen.add(row.key)
    ordered.push(row)
  }
  for (const row of post_types) {
    if (seen.has(row.key)) continue
    seen.add(row.key)
    ordered.push(row)
  }

  return { StaticLink, post_types: ordered }
}

const getProfileSettings = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...publicReadableWhere() },
    include: { profileSettings: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  const ps = profile.profileSettings
  const storedTheme = (ps?.themeConfig || profile.themeConfig) as
    { appearance?: { fontFamily?: unknown; buttonShadow?: unknown } } | null | undefined
  const storedAppearance = storedTheme?.appearance
  return {
    appearance: {
      profileTemplate: ps?.profileTemplate || profile.template || 'v3',
      layoutStyle: ps?.layoutStyle || 'classic',
      buttonStyle: ps?.buttonStyle || 'solid',
      cornerStyle: ps?.cornerStyle || 'round',
      ...(typeof storedAppearance?.fontFamily === 'string' ? { fontFamily: storedAppearance.fontFamily } : {}),
      ...(typeof storedAppearance?.buttonShadow === 'string' ? { buttonShadow: storedAppearance.buttonShadow } : {}),
    },
    theme_config: ps?.themeConfig || profile.themeConfig || null,
  }
}

const getProfileAiData = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...publicReadableWhere() },
    include: {
      profession: true,
      education: { orderBy: { sortOrder: 'asc' } },
      experiences: { orderBy: { sortOrder: 'asc' } },
      services: { where: { status: 1 }, orderBy: { sortOrder: 'asc' } },
      portfolios: { where: { status: 1 }, orderBy: { sortOrder: 'asc' } },
      skillTags: { orderBy: { sortOrder: 'asc' } },
      socialLinks: { orderBy: { sortOrder: 'asc' } },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const [galleryRows, assistant] = await Promise.all([
    listGalleriesForProfile(profileId, 200),
    getPublicAssistantSupplement(profileId),
  ])
  const galleries = galleryRows.filter((row) => String(row.status) === '1')

  const formatDate = (d: Date | null | undefined) => {
    if (!d) return null
    return d.toISOString().slice(0, 10)
  }

  return {
    slug: profile.slug,
    ownerName: profile.name,
    title: profile.prof || profile.designation,
    profession: profile.profession?.name || profile.prof,
    company: profile.companyName,
    email: profile.email,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    website: profile.website,
    // Laravel-compatible `location`; keep `address` alias for Node callers
    location: [profile.address, profile.zipCode].filter((part) => Boolean(part?.trim())).join(', ') || profile.address,
    address: profile.address,
    zipCode: profile.zipCode,
    zip_code: profile.zipCode,
    about: profile.about,
    socials: {
      facebook: profile.facebook,
      instagram: profile.instagram,
      twitter: profile.twitter,
      linkedin: profile.linkedin,
      youtube: profile.youtube,
      tiktok: profile.tiktok,
      rumble: null,
      truth: null,
      custom: profile.socialLinks,
    },
    skills: profile.skillTags.map((s) => ({
      name: s.name,
      level: s.level,
    })),
    services: profile.services.map((s) => ({ title: s.title, description: s.description })),
    experience: profile.experiences.map((e) => ({
      company: e.company,
      title: e.jobTitle,
      job_title: e.jobTitle,
      description: e.description,
      from_date: formatDate(e.fromDate) || '',
      to_date: formatDate(e.toDate),
      current_status: e.tillNow ? 1 : 0,
      // camelCase aliases
      jobTitle: e.jobTitle,
      fromDate: formatDate(e.fromDate),
      toDate: formatDate(e.toDate),
      tillNow: e.tillNow,
    })),
    education: profile.education.map((e) => ({
      institute: e.institute,
      title: e.degree,
      degree: e.degree,
      from_date: formatDate(e.fromDate) || '',
      to_date: formatDate(e.toDate),
      current_status: e.tillNow ? 1 : 0,
      // camelCase aliases
      fromDate: formatDate(e.fromDate),
      toDate: formatDate(e.toDate),
      tillNow: e.tillNow,
    })),
    portfolio: (galleries.length ? galleries : profile.portfolios).map((p) => ({
      title: p.title,
      description: p.description,
      url: p.url,
      status: Number(p.status),
      imageUrl: 'featuredImage' in p ? p.featuredImage : p.imageUrl,
      attachmentUrl: p.attachmentUrl,
      attachmentName: p.attachmentName,
      attachments: p.attachmentUrl ? { url: p.attachmentUrl, name: p.attachmentName || '' } : null,
    })),
    customSections: [],
    ...(assistant.enabled
      ? {
          assistantContext: {
            businessBrief: assistant.businessBrief,
            knowledgeText: assistant.knowledgeText,
          },
        }
      : {}),
  }
}

const getDynamicSection = async (
  sectionName: string,
  profileId: string,
  validatedProfile?: { id: string; legacyId: number | null; isPublic: boolean },
  takeOverride?: number
) => {
  const profile =
    validatedProfile ??
    (await prisma.profile.findFirst({
      where: { id: profileId, ...publicReadableWhere() },
      select: { id: true, legacyId: true, isPublic: true },
    }))
  if (!profile) throw new AppError(404, 'Profile not found')
  const legacyId = profile.legacyId

  const abs = (raw?: string | null, docName?: string | null, typeLegacyId?: number | null, typeName?: string | null) =>
    ensureAbsoluteMediaUrl(raw, {
      docName,
      attachmentTypeLegacyId: typeLegacyId,
      attachmentTypeName: typeName,
      profileLegacyId: legacyId,
    })

  const mediaAsset = (id: string, title: string | null | undefined, url: string | null) =>
    url ? { id, doc_name: title || 'media', url } : null

  const name = decodeURIComponent(sectionName)
  const registryTab = getTabByPublicSectionName(name)

  if (registryTab?.storage === 'service') {
    const items = await prisma.service.findMany({
      where: { profileId, status: 1 },
      orderBy: { sortOrder: 'asc' },
      take: takeOverride ?? 200,
    })
    if (items.length) {
      return {
        type: 'services',
        postType: { name: 'services', title: 'Services' },
        profile: { id: profileId },
        items: items.map((s) => {
          const imageUrl = abs(s.imageUrl, null, 6, 'Service Image')
          return {
            id: s.id,
            title: s.title,
            description: s.description,
            status: s.status,
            featured_image: imageUrl || null,
            review_link: { url: s.reviewUrl || '', has_link: Boolean(s.reviewUrl) },
          }
        }),
      }
    }
  }

  if (registryTab?.storage === 'blog') {
    const blogs = await prisma.blog.findMany({
      where: { profileId, deletedAt: null, status: '1' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: takeOverride ?? 100,
    })
    if (blogs.length) {
      const missingCopy = blogs.filter((row) => !String(row.description || '').trim())
      let byTitle = new Map<string, string>()
      if (missingCopy.length) {
        const legacyPosts = await prisma.post.findMany({
          where: {
            profileId,
            deletedAt: null,
            OR: [
              { postType: { name: { equals: 'blog', mode: 'insensitive' } } },
              { postType: { title: { equals: 'blog', mode: 'insensitive' } } },
            ],
          },
          select: { title: true, description: true },
        })
        byTitle = new Map(
          legacyPosts
            .filter((row) => String(row.description || '').trim())
            .map((row) => [
              String(row.title || '')
                .trim()
                .toLowerCase(),
              row.description || '',
            ])
        )
      }
      return {
        type: 'blog',
        postType: { name: 'blog', title: 'blog' },
        profile: { id: profileId },
        items: blogs.map((p) => {
          const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
          const metas: Record<string, string> = {}
          const description =
            String(p.description || '').trim() ||
            byTitle.get(
              String(p.title || '')
                .trim()
                .toLowerCase()
            ) ||
            p.description
          return {
            id: p.id,
            title: p.title,
            description,
            status: p.status,
            issuer: '',
            year: '',
            featured_image: featuredFromField ? [{ id: p.id, doc_name: p.title, url: featuredFromField }] : [],
            general_info_url: p.url,
            attachments: featuredFromField ? [{ id: p.id, doc_name: p.title || 'image', url: featuredFromField }] : [],
            metas,
            created_at: p.createdAt,
          }
        }),
      }
    }
  }

  if (registryTab?.storage === 'video_explainer') {
    try {
      type ExplainerRow = {
        id: string
        title: string | null
        description: string | null
        url: string | null
        featuredImage: string | null
        status: string
        createdAt: Date
      }
      let rows: ExplainerRow[] = await prisma.videoExplainer.findMany({
        where: { profileId, deletedAt: null, status: '1' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        take: takeOverride ?? 20,
      })
      if (!rows.length) {
        rows = await prisma.tabItem.findMany({
          where: { profileId, tabKey: 'video_explainers', deletedAt: null, status: '1' },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
          take: takeOverride ?? 20,
        })
      }
      if (!rows.length) {
        const settingRows = await prisma.setting.findMany({
          where: { profileId, key: { in: ['intro_video_url', 'intro_youtube_url'] } },
          select: { key: true, value: true },
        })
        const settings: Record<string, string> = {}
        for (const row of settingRows) {
          if (row.value?.trim()) settings[row.key] = row.value.trim()
        }
        const introFile = settings.intro_video_url || ''
        const introYoutube = settings.intro_youtube_url || ''
        const { videoUrl, external } = splitExplainerMedia(
          introFile && !isYoutubeUrl(introFile) ? introFile : '',
          introYoutube || (isYoutubeUrl(introFile) ? introFile : '')
        )
        const resolvedVideo = videoUrl ? abs(videoUrl, null, 7, 'Featured Image') || videoUrl : ''
        if (resolvedVideo || external) {
          const asset = mediaAsset('profile-media', '2D Video Explainer', resolvedVideo || null)
          return {
            type: '2D Video Explainer',
            postType: { name: '2D Video Explainer', title: '2D Video Explainer' },
            profile: { id: profileId },
            video: resolvedVideo ? { doc_name: 'Explainer', url: resolvedVideo } : { doc_name: '', url: '' },
            external_url: { url: external, has_external_url: Boolean(external) },
            items: [
              {
                id: 'profile-media',
                title: '2D Video Explainer',
                description: null,
                status: 1,
                featured_image: asset,
                general_info_url: external || resolvedVideo || '',
                attachments: asset ? [asset] : [],
                created_at: new Date(),
                video_url: resolvedVideo,
              },
            ],
          }
        }
      }
      if (rows.length) {
        const items = rows.map((p) => {
          const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
          const urlFromField = abs(p.url, null, 7, 'Featured Image')
          const { videoUrl, external } = splitExplainerMedia(featuredFromField, urlFromField || p.url)
          const asset = mediaAsset(p.id, p.title, videoUrl || null)
          return {
            id: p.id,
            title: p.title,
            description: p.description,
            status: p.status === '0' ? 0 : 1,
            featured_image: asset,
            general_info_url: external || p.url,
            attachments: asset ? [asset] : [],
            created_at: p.createdAt,
            video_url: videoUrl,
            external_url: external,
          }
        })
        const first = items[0]
        const videoUrl = first.video_url || ''
        const external = first.external_url || null
        return {
          type: '2D Video Explainer',
          postType: { name: '2D Video Explainer', title: '2D Video Explainer' },
          profile: { id: profileId },
          video: videoUrl ? { doc_name: first.title || 'Explainer', url: videoUrl } : { doc_name: '', url: '' },
          external_url: { url: external, has_external_url: Boolean(external) },
          items,
        }
      }
    } catch (error) {
      if (!isPrismaSchemaDrift(error)) throw error
    }
  }

  {
    const tab = registryTab
    if (tab && isGenericDirectStorage(tab.storage)) {
      try {
        const liveList = tab.storage === 'faq' || tab.storage === 'mission_statement'
        let rows = await DIRECT_SECTION_LOADERS[tab.storage](profileId, takeOverride ?? 100)
        if (rows.length && rows.some((row) => !row.featuredImage || !row.url)) {
          const extras = await prisma.tabItem
            .findMany({
              where: { profileId, tabKey: tab.key, deletedAt: null, status: '1' },
              select: { id: true, title: true, featuredImage: true, url: true },
            })
            .catch(() => [])
          if (extras.length) {
            const byId = new Map(extras.map((row) => [row.id, row] as const))
            const byTitle = new Map(
              extras.map(
                (row) =>
                  [
                    String(row.title || '')
                      .trim()
                      .toLowerCase(),
                    row,
                  ] as const
              )
            )
            rows = rows.map((row) => {
              const extra =
                byId.get(row.id) ||
                byTitle.get(
                  String(row.title || '')
                    .trim()
                    .toLowerCase()
                )
              if (!extra) return row
              return {
                ...row,
                featuredImage: row.featuredImage || extra.featuredImage,
                url: row.url || extra.url,
              }
            })
          }
        }
        if (tab.storage === 'client' && rows.some((row) => !row.featuredImage)) {
          const legacyPostIds = rows.map((row) => row.legacyPostId).filter((id): id is number => typeof id === 'number')
          const directRowIds = rows.map((row) => row.id)
          const legacyPosts = await prisma.post.findMany({
            where: {
              profileId,
              deletedAt: null,
              OR: [
                ...(legacyPostIds.length ? [{ legacyId: { in: legacyPostIds } }] : []),
                { id: { in: directRowIds } },
              ],
            },
            select: {
              id: true,
              legacyId: true,
              featuredImage: true,
              attachments: { include: { attachmentType: true }, orderBy: { createdAt: 'asc' } },
            },
          })
          const postsById = new Map(legacyPosts.map((post) => [post.id, post] as const))
          const postsByLegacyId = new Map(
            legacyPosts.filter((post) => post.legacyId != null).map((post) => [post.legacyId as number, post] as const)
          )

          rows = rows.map((row) => {
            if (row.featuredImage) return row
            const legacyPost =
              postsById.get(row.id) ||
              (typeof row.legacyPostId === 'number' ? postsByLegacyId.get(row.legacyPostId) : undefined)
            if (!legacyPost) return row

            const attachment = legacyPost.attachments.find((item) => item.url || item.docName)
            const recoveredImage =
              abs(legacyPost.featuredImage, null, 7, 'Featured Image') || resolveAttachmentUrl(attachment, legacyId)
            return recoveredImage ? { ...row, featuredImage: recoveredImage } : row
          })
        }
        if (rows.length) {
          logPublicSectionMedia(
            tab.publicSectionName,
            profileId,
            { items: rows },
            {
              storage: tab.storage,
              source: 'direct-table',
              db: rows.map((row) => ({
                id: row.id,
                title: row.title,
                featuredImage: row.featuredImage,
                url: row.url,
                status: row.status,
              })),
            }
          )
          return {
            type: tab.publicSectionName,
            postType: {
              name: tab.publicSectionName,
              title: tab.label,
              type_id: tab.legacyPostTypeId,
            },
            profile: { id: profileId },
            items: rows.map((p) => {
              const href = p.url?.trim() || ''
              const featuredRaw = p.featuredImage?.trim() || ''
              const featuredIsMedia = Boolean(featuredRaw) && !looksLikeExternalPageUrl(featuredRaw)
              const urlIsMedia = Boolean(href) && looksLikeMediaAssetUrl(href) && !looksLikeExternalPageUrl(href)
              const featuredFromField = featuredIsMedia ? abs(featuredRaw, null, 7, 'Featured Image') : null
              const urlFromField = !liveList && urlIsMedia ? abs(href, null, 7, 'Featured Image') : null
              const asset = mediaAsset(p.id, p.title, featuredFromField)
              const urlAsset =
                urlFromField && urlFromField !== featuredFromField
                  ? mediaAsset(`${p.id}-url`, p.title, urlFromField)
                  : null
              const metas =
                p.metas && typeof p.metas === 'object' && !Array.isArray(p.metas)
                  ? (p.metas as Record<string, string>)
                  : {}
              const issuer = typeof metas.issuer === 'string' ? metas.issuer.trim() : ''
              const year = typeof metas.year === 'string' ? metas.year.trim() : ''
              const attachments = [asset, urlAsset].filter(Boolean)
              const featuredImage = liveList ? (asset ? [asset] : []) : asset
              const isVideoTab = tab.storage === 'video_link' || tab.storage === 'video'
              return {
                id: p.id,
                title: p.title,
                description: p.description,
                status: p.status === '0' ? 0 : 1,
                issuer,
                year,
                featured_image: featuredImage,
                general_info_url: href,
                url: href,
                video_url: isVideoTab ? href : undefined,
                review_link: { url: href, has_link: Boolean(href) },
                attachments,
                metas,
                created_at: p.createdAt,
              }
            }),
            section_id: tab.key,
            post_type: { name: tab.publicSectionName, title: tab.label, type_id: tab.legacyPostTypeId },
          }
        }
      } catch (error) {
        if (!isPrismaSchemaDrift(error)) throw error
      }
    }
  }

  if (registryTab?.storage === 'gallery' || /^portfolio$/i.test(name) || /^galler(y|ies)$/i.test(name)) {
    try {
      type PublicGalleryRow = {
        id: string
        title: string | null
        description: string | null
        url: string | null
        featuredImage: string | null
        attachmentUrl: string | null
        attachmentName: string | null
        status: string
        createdAt: Date
      }
      const [galleryRows, legacy] = await Promise.all([
        listGalleriesForProfile(profileId, takeOverride ?? 100).then((rows) =>
          rows.filter((row) => String(row.status) === '1')
        ),
        prisma.portfolio.findMany({
          where: { profileId, status: 1 },
          orderBy: { sortOrder: 'asc' },
          take: takeOverride ?? 100,
        }),
      ])
      const mappedLegacy: PublicGalleryRow[] = legacy.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        url: p.url,
        featuredImage: p.imageUrl,
        attachmentUrl: p.attachmentUrl,
        attachmentName: p.attachmentName,
        status: String(p.status),
        createdAt: p.createdAt,
      }))
      const hydrated = fillMissingGalleryMedia(galleryRows, legacy)
      const items: PublicGalleryRow[] = galleryHasMedia(hydrated)
        ? hydrated
        : mappedLegacy.length
          ? mappedLegacy
          : hydrated
      logPublicSectionMedia(
        name,
        profileId,
        { items },
        {
          source: galleryHasMedia(hydrated) ? 'gallery' : mappedLegacy.length ? 'portfolio' : 'gallery-empty',
          galleryDb: galleryRows.map((row) => ({
            id: row.id,
            title: row.title,
            featuredImage: row.featuredImage,
            attachmentUrl: row.attachmentUrl,
            url: row.url,
            status: row.status,
          })),
          portfolioDb: legacy.map((row) => ({
            id: row.id,
            title: row.title,
            imageUrl: row.imageUrl,
            attachmentUrl: row.attachmentUrl,
            url: row.url,
            status: row.status,
          })),
        }
      )
      if (items.length) {
        return {
          type: 'gallery',
          postType: { name: 'gallery', title: 'Gallery' },
          profile: { id: profileId },
          items: items.map((p) => {
            const imageUrl = abs(p.featuredImage, null, 5, 'Portfolio Gallery')
            const attachmentUrl = abs(p.attachmentUrl, p.attachmentName, 5, 'Portfolio Attachment')
            const featured = mediaAsset(p.id, p.title, imageUrl || attachmentUrl)
            const attachment = attachmentUrl
              ? { id: `${p.id}-attachment`, doc_name: p.attachmentName || p.title || 'attachment', url: attachmentUrl }
              : null
            const gallery = [featured, attachment].filter(Boolean)
            return {
              id: p.id,
              title: p.title,
              description: p.description,
              status: p.status === '0' ? 0 : 1,
              featured_image: featured,
              gallery,
              attachments: attachment ? [attachment] : featured ? [featured] : [],
              general_info_url: p.url,
              created_at: p.createdAt,
            }
          }),
        }
      }
    } catch (error) {
      if (!isPrismaSchemaDrift(error)) throw error
    }
  }

  if (registryTab?.storage === 'review' || /^testimonials?$/i.test(name)) {
    const items = await prisma.review.findMany({
      where: { profileId, status: 1 },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: takeOverride ?? 200,
    })
    if (items.length) {
      logPublicSectionMedia(
        name,
        profileId,
        { items },
        {
          source: 'review-table',
          db: items.map((row) => ({
            id: row.id,
            author: row.author,
            imageUrl: row.imageUrl,
            reviewUrl: row.reviewUrl,
            status: row.status,
          })),
        }
      )
      return {
        type: 'reviews',
        postType: { name: 'reviews', title: 'Reviews' },
        profile: { id: profileId },
        items: items.map((r) => {
          // Review media/link fields are authoritative. Do not substitute profile or attachment media.
          const imageUrl = r.imageUrl
          const reviewUrl = r.reviewUrl?.trim() || ''
          const asset = mediaAsset(r.id, r.author, imageUrl)
          return {
            id: r.id,
            author: r.author,
            text: r.text,
            imageUrl: r.imageUrl,
            reviewUrl: r.reviewUrl,
            sortOrder: r.sortOrder,
            title: r.author,
            description: r.text,
            status: r.status,
            rating: r.rating,
            featured_image: asset,
            review_link: { url: reviewUrl, has_link: Boolean(reviewUrl) },
            general_info_url: reviewUrl,
          }
        }),
      }
    }
    // Reviews are authoritative in their dedicated table. Falling through to
    // profile Posts/TabItems can assign unrelated media to a reviewer.
    return {
      type: 'reviews',
      postType: { name: 'reviews', title: 'Reviews' },
      profile: { id: profileId },
      items: [],
    }
  }

  if (registryTab?.storage === 'about_me') {
    try {
      const about = await prisma.aboutMe.findUnique({ where: { profileId } })
      if (!about || about.status === '0') {
        const fallback = await prisma.profile.findUnique({
          where: { id: profileId },
          select: { about: true, id: true },
        })
        const text = fallback?.about?.trim() || ''
        return {
          type: 'About Me',
          postType: { name: 'About Me', title: 'About Me' },
          profile: { id: profileId },
          items: text
            ? [{ id: profileId, title: 'About Me', description: text, status: '1', featured_image: null }]
            : [],
        }
      }
      return {
        type: 'About Me',
        postType: { name: 'About Me', title: 'About Me' },
        profile: { id: profileId },
        items: [
          {
            id: about.id,
            title: about.title?.trim() || '',
            description: about.description || '',
            status: about.status || '1',
            featured_image: about.featuredMediaUrl ? abs(about.featuredMediaUrl) : null,
          },
        ],
      }
    } catch (error) {
      if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
      const fallback = await prisma.profile.findUnique({
        where: { id: profileId },
        select: { about: true },
      })
      const text = fallback?.about?.trim() || ''
      return {
        type: 'About Me',
        postType: { name: 'About Me', title: 'About Me' },
        profile: { id: profileId },
        items: text ? [{ id: profileId, title: 'About Me', description: text, status: '1', featured_image: null }] : [],
      }
    }
  }

  if (/^skills?$/i.test(name)) {
    const skillTags = await prisma.skillTag.findMany({
      where: { profileId },
      orderBy: { sortOrder: 'asc' },
    })
    return {
      type: 'skills',
      postType: { name: 'skills', title: 'Skills' },
      profile: { id: profileId },
      items: skillTags.map((s) => ({
        id: s.id,
        title: s.name,
        description: s.level || '',
        status: '1',
      })),
    }
  }

  if (/^work experience$/i.test(name) || /^resume$/i.test(name)) {
    const [education, experiences] = await Promise.all([
      prisma.education.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }),
      prisma.experience.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' } }),
    ])
    const items = /^resume$/i.test(name)
      ? [
          ...education.map((e) => ({
            id: e.id,
            title: e.degree || e.institute,
            description: [e.institute, e.degree].filter(Boolean).join(' â€” '),
            status: '1',
          })),
          ...experiences.map((e) => ({
            id: e.id,
            title: e.jobTitle || e.company,
            description: e.description,
            status: '1',
          })),
        ]
      : experiences.map((e) => ({
          id: e.id,
          title: e.jobTitle || e.company,
          description: e.description,
          status: '1',
        }))
    return {
      type: name,
      postType: { name, title: name },
      profile: { id: profileId },
      items,
    }
  }

  const customTab = await prisma.customTab
    .findFirst({
      where: {
        profileId,
        isEnabled: true,
        isPublic: true,
        status: '1',
        OR: [
          { id: name },
          { key: { equals: name, mode: 'insensitive' } },
          { slug: { equals: name, mode: 'insensitive' } },
        ],
      },
    })
    .catch((error) => {
      if (!isPrismaSchemaDrift(error)) throw error
      return null
    })
  if (customTab) {
    const rows = await prisma.customTabItem.findMany({
      where: { customTabId: customTab.id, profileId, status: '1' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: takeOverride ?? 200,
    })
    return {
      type: customTab.id,
      postType: { name: customTab.id, title: customTab.label },
      profile: { id: profileId },
      items: rows.map((item) => {
        const featuredImage = abs(item.featuredImage, null, 7, 'Featured Image')
        const metas =
          item.data && typeof item.data === 'object' && !Array.isArray(item.data)
            ? (item.data as Record<string, string>)
            : {}
        return {
          id: item.id,
          title: item.title,
          description: item.description,
          status: item.status,
          issuer: typeof metas.issuer === 'string' ? metas.issuer.trim() : '',
          year: typeof metas.year === 'string' ? metas.year.trim() : '',
          featured_image: featuredImage ? [{ id: item.id, doc_name: item.title, url: featuredImage }] : [],
          general_info_url: item.url || '',
          video_url: featuredImage,
          attachments: featuredImage ? [{ id: item.id, doc_name: item.title, url: featuredImage }] : [],
          metas,
        }
      }),
      section_id: customTab.id,
      post_type: { name: customTab.id, title: customTab.label, type_id: null },
    }
  }

  if (registryTab) {
    try {
      const tabRows = await prisma.tabItem.findMany({
        where: { profileId, tabKey: registryTab.key, deletedAt: null, status: '1' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        take: takeOverride ?? 100,
      })
      if (tabRows.length) {
        return {
          type: registryTab.publicSectionName,
          postType: {
            name: registryTab.publicSectionName,
            title: registryTab.label,
            type_id: registryTab.legacyPostTypeId,
          },
          profile: { id: profileId },
          items: tabRows.map((p) => {
            const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
            const asset = mediaAsset(p.id, p.title, featuredFromField)
            const metas =
              p.metas && typeof p.metas === 'object' && !Array.isArray(p.metas)
                ? (p.metas as Record<string, string>)
                : {}
            return {
              id: p.id,
              title: p.title,
              description: p.description,
              status: p.status === '0' ? 0 : 1,
              issuer: typeof metas.issuer === 'string' ? metas.issuer.trim() : '',
              year: typeof metas.year === 'string' ? metas.year.trim() : '',
              featured_image: asset,
              general_info_url: p.url,
              review_link: { url: p.url || '', has_link: Boolean(p.url) },
              attachments: asset ? [asset] : [],
              metas,
              created_at: p.createdAt,
            }
          }),
          section_id: registryTab.key,
          post_type: {
            name: registryTab.publicSectionName,
            title: registryTab.label,
            type_id: registryTab.legacyPostTypeId,
          },
        }
      }
    } catch (error) {
      if (!isPrismaSchemaDrift(error)) throw error
    }
  }

  const posts = await prisma.post.findMany({
    where: {
      profileId,
      deletedAt: null,
      status: '1',
      OR: [
        { postType: { name: { equals: name, mode: 'insensitive' } } },
        { postType: { title: { equals: name, mode: 'insensitive' } } },
        { title: { equals: name, mode: 'insensitive' } },
      ],
    },
    include: {
      postType: true,
      metas: true,
      attachments: { include: { attachmentType: true } },
    },
    orderBy: { sortOrder: 'asc' },
    take: takeOverride ?? 100,
  })

  const postType = posts[0]?.postType

  return {
    type: name,
    postType: {
      id: postType?.id,
      name: postType?.name || name,
      title: postType?.title || name,
      type_id: postType?.typeId,
    },
    profile: { id: profileId },
    items: posts.map((p) => {
      const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
      const attachmentImages = p.attachments
        .map((a) => {
          const url = resolveAttachmentUrl(a, legacyId)
          return url ? { id: a.id, doc_name: a.docName, url, extension: a.extension } : null
        })
        .filter(Boolean) as { id: string; doc_name: string | null; url: string; extension: string | null }[]
      const metas = Object.fromEntries(p.metas.map((m) => [m.metaKey, m.metaValue ?? '']))
      const issuer = typeof metas.issuer === 'string' ? metas.issuer.trim() : ''
      const year = typeof metas.year === 'string' ? metas.year.trim() : ''

      return {
        id: p.id,
        title: p.title,
        description: p.description,
        status: p.status,
        issuer,
        year,
        featured_image: featuredFromField
          ? [{ id: p.id, doc_name: p.title, url: featuredFromField }]
          : attachmentImages.map(({ id, doc_name, url }) => ({ id, doc_name, url })),
        general_info_url: p.url,
        attachments: attachmentImages,
        metas,
      }
    }),
    section_id: postType?.id,
    post_type: postType
      ? { name: postType.name, title: postType.title || postType.name, type_id: postType.typeId }
      : undefined,
  }
}

type BootstrapPayload = {
  myCard: Awaited<ReturnType<typeof getMyCardFromProfile>>
  postTypes: Awaited<ReturnType<typeof getPostTypesForProfile>>
  settings: Awaited<ReturnType<typeof getProfileSettings>>
  sections: Record<string, Awaited<ReturnType<typeof getDynamicSection>>>
}

const BOOTSTRAP_TTL_MS = 15_000
const bootstrapCache = new Map<string, { expiresAt: number; value: BootstrapPayload }>()

const getPublicBootstrap = async (slug: string): Promise<BootstrapPayload> => {
  const profile = await getProfileBySlugOrThrow(slug)
  const cacheKey = `${profile.id}:${profile.updatedAt.getTime()}`
  const cached = bootstrapCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const validatedProfile = { id: profile.id, legacyId: profile.legacyId, isPublic: profile.isPublic }
  const settings = {
    appearance: {
      profileTemplate: profile.profileSettings?.profileTemplate || profile.template || 'v3',
      layoutStyle: profile.profileSettings?.layoutStyle || 'classic',
      buttonStyle: profile.profileSettings?.buttonStyle || 'solid',
      cornerStyle: profile.profileSettings?.cornerStyle || 'round',
    },
    theme_config: profile.profileSettings?.themeConfig || profile.themeConfig || null,
  }
  const lightTabs = Object.values(TAB_REGISTRY).filter((tab) =>
    ['about_me', 'mission_statement', 'why_choose_us', 'service', 'review'].includes(tab.storage)
  )

  const [myCard, postTypes, sectionEntries] = await Promise.all([
    getMyCardFromProfile(profile),
    getPostTypesForProfile(profile.id, true),
    Promise.all(
      lightTabs.map(async (tab) => {
        try {
          return [
            tab.publicSectionName,
            await getDynamicSection(tab.publicSectionName, profile.id, validatedProfile, 12),
          ] as const
        } catch {
          return [
            tab.publicSectionName,
            {
              type: tab.publicSectionName,
              postType: { name: tab.publicSectionName, title: tab.label },
              profile: { id: profile.id },
              items: [],
            },
          ] as const
        }
      })
    ),
  ])
  const value: BootstrapPayload = {
    myCard,
    postTypes,
    settings,
    sections: Object.fromEntries(sectionEntries),
  }
  bootstrapCache.clear()
  bootstrapCache.set(cacheKey, { expiresAt: Date.now() + BOOTSTRAP_TTL_MS, value })
  return value
}

const PUBLIC_CARDS_LIST_TTL_MS = 45_000
const publicCardsListCache = new Map<string, { expiresAt: number; value: unknown }>()

function isPublicCardVideoUrl(url: string, docName?: string | null): boolean {
  const name = `${url} ${docName || ''}`.toLowerCase()
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || name.includes('.mp4') || name.includes('video')
}

function resolvePublicDirectoryMedia(profile: {
  avatar: string | null
  legacyId: number | null
  attachments: AttachmentWithType[]
}): { image: string; image_type: string | null; is_video: boolean } {
  const introAtt = pickAttachment(profile.attachments, 'intro')
  const introUrl = resolveAttachmentUrl(introAtt, profile.legacyId)
  if (introUrl && isPublicCardVideoUrl(introUrl, introAtt?.docName)) {
    return { image: introUrl, image_type: 'video', is_video: true }
  }

  const profileAtt = pickAttachment(profile.attachments, 'profile')
  const avatar =
    ensureAbsoluteMediaUrl(profile.avatar, {
      docName: profile.avatar,
      attachmentTypeLegacyId: 13,
      attachmentTypeName: 'Profile Picture',
      profileLegacyId: profile.legacyId,
    }) || resolveAttachmentUrl(profileAtt, profile.legacyId)

  if (avatar && isPublicCardVideoUrl(avatar, profileAtt?.docName)) {
    return { image: avatar, image_type: 'video', is_video: true }
  }

  return { image: avatar || '', image_type: avatar ? 'image' : null, is_video: false }
}

const getPublicCards = async (query: {
  page?: number
  per_page?: number
  state_id?: string
  city_id?: string
  profession_id?: string
  service?: string
  search?: string
  dropdowns?: string
}) => {
  const page = Math.max(1, Number(query.page) || 1)
  const perPage = Math.min(100, Math.max(1, Number(query.per_page) || 12))
  const searchTerm = String(query.search || query.service || '').trim()
  const includeDropdowns = query.dropdowns !== '0' && page === 1 && !searchTerm && !query.profession_id
  const cacheKey = JSON.stringify({
    page,
    perPage,
    profession_id: query.profession_id || '',
    searchTerm,
    dropdowns: includeDropdowns,
  })
  const cached = publicCardsListCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const where = {
    ...publicVisibleWhere(),
    slug: { not: null },
    ...(query.profession_id ? { professionId: query.profession_id } : {}),
    ...(searchTerm
      ? {
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' as const } },
            { companyName: { contains: searchTerm, mode: 'insensitive' as const } },
            { prof: { contains: searchTerm, mode: 'insensitive' as const } },
            { slug: { contains: searchTerm, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [total, rows, professionRows] = await Promise.all([
    prisma.profile.count({ where }),
    prisma.profile.findMany({
      where,
      include: {
        profession: true,
        attachments: { include: { attachmentType: true }, take: 8 },
      },
      skip: (page - 1) * perPage,
      take: perPage,
      orderBy: { updatedAt: 'desc' },
    }),
    includeDropdowns
      ? prisma.profile.findMany({
          where: { ...publicVisibleWhere(), slug: { not: null }, professionId: { not: null } },
          distinct: ['professionId'],
          select: { professionId: true, profession: { select: { id: true, name: true } } },
          take: 200,
        })
      : Promise.resolve([]),
  ])

  const lastPage = Math.max(1, Math.ceil(total / perPage))
  const from = total === 0 ? null : (page - 1) * perPage + 1
  const to = total === 0 ? null : Math.min(page * perPage, total)
  const path = '/public-cards'
  const data = rows.map((p) => {
    const media = resolvePublicDirectoryMedia(p)
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      profession: p.profession?.name || p.prof,
      profession_id: p.professionId,
      image: media.image,
      image_type: media.image_type,
      is_video: media.is_video,
      profile_url: p.slug ? `/v/${p.slug}` : null,
    }
  })

  const links = [
    { url: page > 1 ? `${path}?page=${page - 1}` : null, label: '&laquo; Previous', active: false },
    { url: `${path}?page=${page}`, label: String(page), active: true },
    { url: page < lastPage ? `${path}?page=${page + 1}` : null, label: 'Next &raquo;', active: false },
  ]

  const professions = professionRows
    .map((row) => row.profession)
    .filter((item): item is { id: string; name: string } => Boolean(item?.id && item?.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  const payload = {
    success: true,
    data: {
      current_page: page,
      data,
      first_page_url: `${path}?page=1`,
      from,
      last_page: lastPage,
      last_page_url: `${path}?page=${lastPage}`,
      links,
      next_page_url: page < lastPage ? `${path}?page=${page + 1}` : null,
      path,
      per_page: perPage,
      prev_page_url: page > 1 ? `${path}?page=${page - 1}` : null,
      to,
      total,
    },
    dropdowns: includeDropdowns
      ? {
          states: [] as { id: string; name: string }[],
          cities: [] as { id: string; name: string }[],
          professions,
        }
      : undefined,
    filters_applied: {
      state_id: query.state_id || null,
      city_id: query.city_id || null,
      profession_id: query.profession_id || null,
      service: query.service || null,
    },
    pagination: {
      current_page: page,
      last_page: lastPage,
      per_page: perPage,
      total,
      next_page_url: page < lastPage ? `${path}?page=${page + 1}` : null,
      prev_page_url: page > 1 ? `${path}?page=${page - 1}` : null,
    },
  }

  publicCardsListCache.set(cacheKey, { expiresAt: Date.now() + PUBLIC_CARDS_LIST_TTL_MS, value: payload })
  if (publicCardsListCache.size > 40) {
    const now = Date.now()
    for (const [key, entry] of publicCardsListCache) {
      if (entry.expiresAt <= now) publicCardsListCache.delete(key)
    }
  }

  return payload
}

const saveGuestUser = async (
  input: {
    full_name?: string
    name?: string
    phone?: string
    email?: string
    profile_id?: string
    meta?: unknown
  },
  requestMeta?: { ip?: string; userAgent?: string }
) => {
  const fullName = String(input.full_name || input.name || '').trim()
  const phone = String(input.phone || '').trim()
  const email = String(input.email || '').trim()
  const profileId = String(input.profile_id || '').trim()

  if (!fullName || !phone || !email || !profileId) {
    throw new AppError(400, 'full_name, phone, email, and profile_id are required')
  }

  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')

  let clientMeta: Record<string, unknown> = {}
  if (typeof input.meta === 'string' && input.meta.trim()) {
    try {
      const parsed = JSON.parse(input.meta) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        clientMeta = parsed as Record<string, unknown>
      }
    } catch {
      /* ignore invalid client meta JSON */
    }
  } else if (input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta)) {
    clientMeta = input.meta as Record<string, unknown>
  }

  const submittedAt = new Date().toISOString()
  const guestId = typeof clientMeta.guestId === 'string' ? clientMeta.guestId.trim().slice(0, 128) : ''
  const meta = {
    ...clientMeta,
    ...(guestId ? { guestId } : {}),
    profileId: profile.id,
    profileSlug: profile.slug || null,
    ownerName: profile.name || null,
    ip: requestMeta?.ip || null,
    userAgent: requestMeta?.userAgent || (typeof clientMeta.userAgent === 'string' ? clientMeta.userAgent : null),
    submittedAt,
  }

  const row = await prisma.guestUserData.create({
    data: {
      profileId: profile.id,
      fullName,
      phone,
      email,
      meta,
      firstName: null,
      lastName: null,
    },
  })

  await logEvent(
    profile.id,
    'save_guest_user',
    {
      guestUserId: row.id,
      fullName,
      phone,
      email,
      ...(guestId ? { guestId } : {}),
      profileSlug: profile.slug,
      ownerName: profile.name,
    },
    { ip: requestMeta?.ip, userAgent: requestMeta?.userAgent }
  )

  liveDashboardHub.emitKpi('save', [profile.userId, profile.companyUserId])

  return {
    id: row.id,
    full_name: row.fullName,
    phone: row.phone,
    email: row.email,
    profile_id: row.profileId,
    profile_slug: profile.slug || null,
    owner_name: profile.name || null,
    meta: row.meta,
    created_at: row.createdAt.toISOString(),
  }
}

type PublicNoteOptions = {
  authorName?: string
  visitorId?: string
}

type PublicNoteMeta = {
  fullName?: string
  visitorId?: string
  source?: string
}

type PublicNoteReplyMeta = {
  lastReply?: string
  lastReplyAt?: string
}

function publicNoteMeta(value: unknown): PublicNoteMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const root = value as Record<string, unknown>
  return {
    fullName: typeof root.fullName === 'string' ? root.fullName : undefined,
    visitorId: typeof root.visitorId === 'string' ? root.visitorId : undefined,
    source: typeof root.source === 'string' ? root.source : undefined,
  }
}

function publicNoteReplyMeta(value: unknown): PublicNoteReplyMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const admin = (value as Record<string, unknown>).admin
  if (!admin || typeof admin !== 'object' || Array.isArray(admin)) return {}
  const reply = admin as Record<string, unknown>
  return {
    lastReply: typeof reply.lastReply === 'string' ? reply.lastReply : undefined,
    lastReplyAt: typeof reply.lastReplyAt === 'string' ? reply.lastReplyAt : undefined,
  }
}

const mapPublicNote = (note: {
  id: string
  profileId: string
  content: string
  meta: unknown
  createdAt: Date
  updatedAt: Date
}) => {
  const meta = publicNoteMeta(note.meta)
  const reply = publicNoteReplyMeta(note.meta)
  return {
    id: note.id,
    profile_id: note.profileId,
    content: note.content,
    author_name: meta.fullName || 'Guest',
    created_at: note.createdAt.toISOString(),
    updated_at: note.updatedAt.toISOString(),
    reply: reply.lastReply || null,
    reply_at: reply.lastReplyAt || null,
  }
}

const saveNote = async (profileId: string, content: string, options: PublicNoteOptions = {}) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')

  const authorName = options.authorName?.trim().slice(0, 200)
  const visitorId = options.visitorId?.trim().slice(0, 128)
  const meta = {
    ...(authorName ? { fullName: authorName } : {}),
    ...(visitorId ? { visitorId } : {}),
    source: 'public_notepad',
  } satisfies Prisma.InputJsonValue

  const note = await prisma.userNote.create({
    data: { profileId, content, meta },
  })
  return mapPublicNote(note)
}

const listNotes = async (profileId: string, visitorId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')

  const notes = await prisma.userNote.findMany({
    where: { profileId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return notes.filter((note) => publicNoteMeta(note.meta).visitorId === visitorId).map(mapPublicNote)
}

const saveContactCard = async (
  profileId: string,
  requestMeta?: { ip?: string; userAgent?: string },
  guestId?: string
) => {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...publicReadableWhere() },
    include: {
      gender: true,
      profession: true,
      settings: { select: { key: true, value: true } },
      attachments: {
        select: {
          url: true,
          docName: true,
          resourceType: true,
          mimeType: true,
          attachmentType: { select: { name: true, legacyId: true } },
        },
      },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  await logEvent(
    profile.id,
    'save_contact_download',
    {
      profileId: profile.id,
      profileSlug: profile.slug,
      ownerName: profile.name,
      ...(guestId ? { guestId: guestId.slice(0, 128) } : {}),
    },
    { ip: requestMeta?.ip, userAgent: requestMeta?.userAgent }
  )

  liveDashboardHub.emitKpi('save', [profile.userId, profile.companyUserId])

  const frontendBase = (config.FRONTEND_URL || '').replace(/\/$/, '')
  const slug = profile.slug || ''
  const profileUrl = slug && frontendBase ? `${frontendBase}/v/${encodeURIComponent(slug)}` : slug ? `/v/${slug}` : ''
  const imageUrl = mediaFromProfile(profile).icon || ''

  return {
    action_buttons: {
      save_contact: {
        data: {
          name: profile.name,
          email: profile.email,
          phone: profile.phone || '',
          company: profile.companyName || '',
          profession: profile.profession?.name || profile.prof || profile.designation || '',
          gender: profile.gender?.name || '',
          website: profile.website || '',
          slug,
          profileUrl,
          imageUrl,
          note: profile.about || '',
          address: [profile.address, profile.zipCode].filter((part) => Boolean(part?.trim())).join(', ') || '',
        },
      },
    },
  }
}

const logEvent = async (
  profileId: string | undefined,
  eventType: string,
  payload?: unknown,
  meta?: { ip?: string; userAgent?: string }
) => {
  await prisma.eventLog.create({
    data: {
      profileId,
      eventType,
      payload: payload as object | undefined,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    },
  })
}

type ReturningGuestProfile = {
  id: string
  slug: string | null
  name: string
  userId: string | null
  companyUserId: string | null
  user: { email: string } | null
  companyUser: { email: string } | null
}

/**
 * Notify the card owner's back-office when a known contact returns after a quiet period.
 * The same event marker is also the cooldown, so ordinary refreshes never create inbox noise.
 */
const notifyReturningSavedGuest = async (profile: ReturningGuestProfile, guestId: string, firstViewAt: Date) => {
  const cutoff = new Date(Date.now() - RETURNING_SAVED_GUEST_DELAY_MS)
  if (firstViewAt > cutoff) return

  const [savedGuest, savedContact, recentNotice] = await Promise.all([
    prisma.guestUserData.findFirst({
      where: {
        profileId: profile.id,
        createdAt: { lte: cutoff },
        meta: { path: ['guestId'], equals: guestId },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, fullName: true, email: true, phone: true },
    }),
    prisma.eventLog.findFirst({
      where: {
        profileId: profile.id,
        eventType: 'save_contact_download',
        createdAt: { lte: cutoff },
        payload: { path: ['guestId'], equals: guestId },
      },
      select: { id: true },
    }),
    prisma.eventLog.findFirst({
      where: {
        profileId: profile.id,
        eventType: RETURNING_SAVED_GUEST_EVENT,
        createdAt: { gt: cutoff },
        payload: { path: ['guestId'], equals: guestId },
      },
      select: { id: true },
    }),
  ])
  if (!savedGuest || !savedContact || recentNotice) return

  const ownerEmails = [...new Set([profile.user?.email, profile.companyUser?.email])]
    .map((email) => (email || '').trim().toLowerCase())
    .filter(Boolean)
  if (!ownerEmails.length) return

  const guestName = savedGuest.fullName?.trim() || 'A saved contact'
  const cardName = profile.name?.trim() || profile.slug || 'your vCard'
  const body = `Hey! ${guestName} is reviewing your card again. Have a question for them? Open your saved contacts and start a conversation.`

  await prisma.$transaction([
    prisma.eventLog.create({
      data: {
        profileId: profile.id,
        eventType: RETURNING_SAVED_GUEST_EVENT,
        payload: {
          guestId,
          guestUserId: savedGuest.id,
          guestName,
          guestEmail: savedGuest.email,
          guestPhone: savedGuest.phone,
          profileSlug: profile.slug,
        },
      },
    }),
    prisma.announcement.create({
      data: {
        kind: 'announcement',
        type: 'info',
        title: `Returning contact · ${cardName}`,
        body,
        status: 'active',
        targetType: 'specific',
        targetEmails: ownerEmails,
        meta: {
          channel: 'inbox',
          source: RETURNING_SAVED_GUEST_EVENT,
          profileId: profile.id,
          guestId,
          guestUserId: savedGuest.id,
          ...(profile.slug ? { slug: profile.slug } : {}),
        },
        createdById: null,
      },
    }),
  ])
}

const trackEvent = async (
  input: {
    eventType: 'social_click' | 'profile_view'
    guestId: string
    channel?: string
    profileId?: string
    profile_id?: string
    slug?: string
    profile_slug?: string
  },
  requestMeta?: { ip?: string; userAgent?: string }
) => {
  const guestId = input.guestId.trim()
  if (!guestId) throw new AppError(400, 'guestId is required')

  const profileId = input.profileId || input.profile_id
  const slug = input.slug || input.profile_slug
  const profile = await prisma.profile.findFirst({
    where: profileId
      ? { id: profileId, ...publicReadableWhere() }
      : { slug: slugEquals(String(slug || '')), ...publicReadableWhere() },
    select: {
      id: true,
      slug: true,
      name: true,
      userId: true,
      companyUserId: true,
      user: { select: { email: true } },
      companyUser: { select: { email: true } },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const eventType = input.eventType
  const channel = eventType === 'social_click' ? input.channel : undefined

  const payloadFilters: Array<{ payload: { path: string[]; equals: string } }> = [
    { payload: { path: ['guestId'], equals: guestId } },
  ]
  if (eventType === 'social_click' && channel) {
    payloadFilters.push({ payload: { path: ['channel'], equals: channel } })
  }

  const existing = await prisma.eventLog.findFirst({
    where: {
      profileId: profile.id,
      eventType,
      AND: payloadFilters,
    },
    select: { id: true, createdAt: true },
  })

  if (existing) {
    if (eventType === 'profile_view') {
      void notifyReturningSavedGuest(profile, guestId, existing.createdAt).catch((error) => {
        logger.error('Returning saved guest notification failed', { profileId: profile.id, guestId, error })
      })
    }
    return {
      tracked: false as const,
      reason: 'already_counted' as const,
      eventType,
      ...(channel ? { channel } : {}),
      profileId: profile.id,
      guestId,
    }
  }

  const platform = (() => {
    const ua = requestMeta?.userAgent || ''
    if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(ua)) return 'Tablet'
    if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry/i.test(ua)) return 'Mobile'
    return 'Desktop'
  })()

  const payload =
    eventType === 'social_click'
      ? {
          channel,
          guestId,
          profileId: profile.id,
          profileSlug: profile.slug,
        }
      : {
          guestId,
          slug: profile.slug,
          profileId: profile.id,
          profileSlug: profile.slug,
          platform,
        }

  await logEvent(profile.id, eventType, payload, {
    ip: requestMeta?.ip,
    userAgent: requestMeta?.userAgent,
  })

  if (eventType === 'profile_view') {
    await prisma.profile.update({
      where: { id: profile.id },
      data: { viewCount: { increment: 1 } },
    })
    liveDashboardHub.emitKpi('view', [profile.userId, profile.companyUserId])
  }

  if (eventType === 'social_click') {
    void import('../services/profile.service')
      .then((mod) => mod.default.notifyLiveSocialClicks(profile.id))
      .catch(() => undefined)
  }

  return {
    tracked: true as const,
    eventType,
    ...(channel ? { channel } : {}),
    profileId: profile.id,
    guestId,
  }
}

const publicCardService = {
  getMyCardBySlug,
  getPostTypesForProfile,
  getProfileSettings,
  getProfileAiData,
  getDynamicSection,
  getPublicBootstrap,
  getPublicCards,
  saveGuestUser,
  saveNote,
  listNotes,
  saveContactCard,
  logEvent,
  trackEvent,
}

export default publicCardService
