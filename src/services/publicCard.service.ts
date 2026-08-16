import type { Attachment, Setting } from '../../generated/prisma/client'
import { getTabByKey, TAB_REGISTRY } from '../constants/tabRegistry'
import AppError from '../error/AppError'
import { publicReadableWhere, publicVisibleWhere, slugEquals } from '../utils/cardStatus'
import { liveDashboardHub } from '../utils/liveDashboardHub'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'
import profileService from './profile.service'

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

function matchAttachmentType(name: string | null | undefined, aliases: string[]): boolean {
  if (!name) return false
  return scoreAttachmentAlias(name.toLowerCase(), aliases) >= 0
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

  // Prefer settings URLs from the editor; fall back to attachments for legacy cards.
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

  const template = profile.profileSettings?.profileTemplate || profile.template || 'default'

  const address = profile.addresses.find((a) => a.isPrimary) || profile.addresses[0]

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      slug: profile.slug,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
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
    profile_media,
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
        email: { enabled: true, value: profile.email, mailto_url: `mailto:${profile.email}` },
        phone: {
          enabled: Boolean(profile.phone),
          value: profile.phone || '',
          tel_url: profile.phone ? `tel:${profile.phone}` : undefined,
        },
        whatsapp: { enabled: Boolean(profile.whatsapp), value: profile.whatsapp || '' },
        website: { enabled: Boolean(profile.website), value: profile.website || '', url: profile.website || undefined },
        address: { enabled: Boolean(profile.address), value: profile.address || '' },
      },
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
  // viewCount is incremented only when a unique guest is tracked via trackEvent(profile_view).
  const card = await buildMyCard(profile)
  const team_notices = await profileService.listPublicTeamNoticesForProfile(profile.id)
  return { ...card, team_notices }
}

const getPostTypesForProfile = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')

  const settings = await prisma.setting.findMany({ where: { profileId } })
  const map = settingsToMap(settings)

  const StaticLink = [
    { id: 'home', title: 'Home', name: 'Home', post_type: 'static', active: map.navHome_checkbox !== '0' },
    {
      id: 'about',
      title: 'About Me',
      name: 'About Me',
      post_type: 'static',
      active: map.aboutMeNav_checkbox === '1' || map.about_checkbox === '1',
    },
    {
      id: 'public-cards',
      title: 'Public Cards',
      name: 'Public Cards',
      post_type: 'static',
      active: map.pCardsNav_checkbox === '1',
    },
  ].filter((i) => i.active)

  const posts = await prisma.post.findMany({
    where: { profileId, deletedAt: null, status: '1' },
    include: { postType: true },
    distinct: ['postTypeId'],
  })

  const seen = new Set<string>()
  const post_types = []
  for (const p of posts) {
    if (!p.postType || seen.has(p.postType.id)) continue
    seen.add(p.postType.id)
    post_types.push({
      id: p.postType.id,
      name: p.postType.name,
      title: p.postType.title || p.postType.name,
      status: p.postType.status || 'active',
      type_id: p.postType.typeId,
      slug: p.postType.slug,
    })
  }

  // Also include dedicated first-class tables as section names when present
  const [
    serviceCount,
    portfolioCount,
    reviewCount,
    educationCount,
    experienceCount,
    skillCount,
    blogCount,
    aboutMeCount,
    tabItemGroups,
  ] = await Promise.all([
    prisma.service.count({ where: { profileId, status: 1 } }),
    prisma.portfolio.count({ where: { profileId, status: 1 } }),
    prisma.review.count({ where: { profileId, status: 1 } }),
    prisma.education.count({ where: { profileId } }),
    prisma.experience.count({ where: { profileId } }),
    prisma.skillTag.count({ where: { profileId } }),
    prisma.blog.count({ where: { profileId, deletedAt: null, status: '1' } }),
    prisma.aboutMe.count({ where: { profileId, status: '1' } }),
    prisma.tabItem.groupBy({
      by: ['tabKey'],
      where: { profileId, deletedAt: null, status: '1' },
      _count: { _all: true },
    }),
  ])
  if (serviceCount > 0 && !post_types.some((t) => t.name.toLowerCase() === 'services')) {
    post_types.push({
      id: 'services',
      name: 'services',
      title: 'Services',
      status: 'active',
      type_id: null,
      slug: 'services',
    })
  }
  if (blogCount > 0 && !post_types.some((t) => /^blog$/i.test(t.name))) {
    post_types.push({
      id: 'blog',
      name: 'blog',
      title: 'blog',
      status: 'active',
      type_id: 6,
      slug: 'blog',
    })
  }
  if (aboutMeCount > 0 && !post_types.some((t) => /^about me$/i.test(t.name))) {
    post_types.push({
      id: 'about-me',
      name: 'About Me',
      title: 'About Me',
      status: 'active',
      type_id: 16,
      slug: 'about-me',
    })
  }
  for (const group of tabItemGroups) {
    if (!group._count._all) continue
    const tab = getTabByKey(group.tabKey)
    if (!tab) continue
    if (post_types.some((t) => t.name.toLowerCase() === tab.publicSectionName.toLowerCase())) continue
    post_types.push({
      id: tab.key,
      name: tab.publicSectionName,
      title: tab.label,
      status: 'active',
      type_id: tab.legacyPostTypeId,
      slug: tab.route,
    })
  }
  if (portfolioCount > 0 && !post_types.some((t) => /gallery|portfolio/i.test(t.name))) {
    post_types.push({
      id: 'gallery',
      name: 'gallery',
      title: 'Gallery',
      status: 'active',
      type_id: null,
      slug: 'gallery',
    })
  }
  if (reviewCount > 0 && !post_types.some((t) => /^reviews?$/i.test(t.name) || /^testimonials?$/i.test(t.name))) {
    post_types.push({
      id: 'reviews',
      name: 'reviews',
      title: 'Reviews',
      status: 'active',
      type_id: null,
      slug: 'reviews',
    })
  }
  if (
    educationCount > 0 &&
    !post_types.some((t) => /^(resume|education)$/i.test(t.name) || /^(resume|education)$/i.test(t.title || ''))
  ) {
    post_types.push({
      id: 'resume',
      name: 'Resume',
      title: 'Resume',
      status: 'active',
      type_id: null,
      slug: 'resume',
    })
  }
  if (
    experienceCount > 0 &&
    !post_types.some(
      (t) =>
        /^(work experience|work|experience)$/i.test(t.name) ||
        /^(work experience|work|experience)$/i.test(t.title || '')
    )
  ) {
    post_types.push({
      id: 'work-experience',
      name: 'Work Experience',
      title: 'Work Experience',
      status: 'active',
      type_id: null,
      slug: 'work-experience',
    })
  }
  if (skillCount > 0 && !post_types.some((t) => /^skills?$/i.test(t.name) || /^skills?$/i.test(t.title || ''))) {
    post_types.push({
      id: 'skills',
      name: 'skills',
      title: 'Skills',
      status: 'active',
      type_id: null,
      slug: 'skills',
    })
  }

  return { StaticLink, post_types }
}

const getProfileSettings = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, ...publicReadableWhere() },
    include: { profileSettings: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  const ps = profile.profileSettings
  return {
    appearance: {
      profileTemplate: ps?.profileTemplate || profile.template || 'v3',
      layoutStyle: ps?.layoutStyle || 'classic',
      buttonStyle: ps?.buttonStyle || 'solid',
      cornerStyle: ps?.cornerStyle || 'round',
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
    location: profile.address,
    address: profile.address,
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
    portfolio: profile.portfolios.map((p) => ({
      title: p.title,
      description: p.description,
      url: p.url,
      status: p.status,
      imageUrl: p.imageUrl,
      attachmentUrl: p.attachmentUrl,
      attachmentName: p.attachmentName,
      attachments: p.attachmentUrl ? { url: p.attachmentUrl, name: p.attachmentName || '' } : null,
    })),
    customSections: [],
  }
}

const getDynamicSection = async (sectionName: string, profileId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')
  const legacyId = profile.legacyId

  const abs = (raw?: string | null, docName?: string | null, typeLegacyId?: number | null, typeName?: string | null) =>
    ensureAbsoluteMediaUrl(raw, {
      docName,
      attachmentTypeLegacyId: typeLegacyId,
      attachmentTypeName: typeName,
      profileLegacyId: legacyId,
    })

  const name = decodeURIComponent(sectionName)

  if (/^services$/i.test(name)) {
    const items = await prisma.service.findMany({
      where: { profileId, status: 1 },
      orderBy: { sortOrder: 'asc' },
    })
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

  if (/^blog$/i.test(name)) {
    const blogs = await prisma.blog.findMany({
      where: { profileId, deletedAt: null, status: '1' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    })
    return {
      type: 'blog',
      postType: { name: 'blog', title: 'blog' },
      profile: { id: profileId },
      items: blogs.map((p) => {
        const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
        const metas: Record<string, string> = {}
        if (p.category) metas.category = p.category
        if (p.date) metas.date = p.date
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          status: p.status,
          issuer: '',
          year: '',
          featured_image: featuredFromField ? [{ id: p.id, doc_name: p.title, url: featuredFromField }] : [],
          general_info_url: p.url,
          attachments: [],
          metas,
          created_at: p.createdAt,
        }
      }),
    }
  }

  {
    const needle = name.trim().toLowerCase()
    const matched = Object.values(TAB_REGISTRY).find(
      (tab) =>
        tab.architecture === 'direct' && tab.storage === 'tab_item' && tab.publicSectionName.toLowerCase() === needle
    )
    if (matched) {
      const tabKey = matched.key
      const rows = await prisma.tabItem.findMany({
        where: { profileId, tabKey, deletedAt: null, status: '1' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      })
      const tab = getTabByKey(tabKey)
      return {
        type: tab?.publicSectionName || name,
        postType: {
          name: tab?.publicSectionName || name,
          title: tab?.label || name,
          type_id: tab?.legacyPostTypeId,
        },
        profile: { id: profileId },
        items: rows.map((p) => {
          const featuredFromField = abs(p.featuredImage, null, 7, 'Featured Image')
          const metas =
            p.metas && typeof p.metas === 'object' && !Array.isArray(p.metas) ? (p.metas as Record<string, string>) : {}
          const issuer = typeof metas.issuer === 'string' ? metas.issuer.trim() : ''
          const year = typeof metas.year === 'string' ? metas.year.trim() : ''
          return {
            id: p.id,
            title: p.title,
            description: p.description,
            status: p.status,
            issuer,
            year,
            featured_image: featuredFromField ? [{ id: p.id, doc_name: p.title, url: featuredFromField }] : [],
            general_info_url: p.url,
            attachments: [],
            metas,
          }
        }),
        section_id: tabKey,
        post_type: tab ? { name: tab.publicSectionName, title: tab.label, type_id: tab.legacyPostTypeId } : undefined,
      }
    }
  }

  if (/^gallery$/i.test(name) || /^portfolio$/i.test(name)) {
    const items = await prisma.portfolio.findMany({
      where: { profileId, status: 1 },
      orderBy: { sortOrder: 'asc' },
    })
    return {
      type: 'gallery',
      postType: { name: 'gallery', title: 'Gallery' },
      profile: { id: profileId },
      items: items.map((p) => {
        const imageUrl = abs(p.imageUrl, null, 5, 'Portfolio Gallery')
        const attachmentUrl = abs(p.attachmentUrl, p.attachmentName, 5, 'Portfolio Attachment')
        const gallery = [
          ...(imageUrl ? [{ id: p.id, doc_name: p.title, url: imageUrl }] : []),
          ...(attachmentUrl
            ? [{ id: `${p.id}-attachment`, doc_name: p.attachmentName || p.title, url: attachmentUrl }]
            : []),
        ]
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          status: p.status,
          featured_image: imageUrl ? [{ id: p.id, doc_name: p.title, url: imageUrl }] : [],
          gallery,
          attachments: attachmentUrl ? { url: attachmentUrl, name: p.attachmentName || '' } : null,
          general_info_url: p.url,
        }
      }),
    }
  }

  if (/^reviews?$/i.test(name) || /^testimonials?$/i.test(name)) {
    const items = await prisma.review.findMany({
      where: { profileId, status: 1 },
      orderBy: { sortOrder: 'asc' },
    })
    return {
      type: 'reviews',
      postType: { name: 'reviews', title: 'Reviews' },
      profile: { id: profileId },
      items: items.map((r) => ({
        id: r.id,
        title: r.author,
        description: r.text,
        status: r.status,
        rating: r.rating,
        featured_image: null,
        review_link: { url: '', has_link: false },
      })),
    }
  }

  if (/^about me$/i.test(name)) {
    const about = await prisma.aboutMe.findUnique({ where: { profileId } })
    if (!about || about.status === '0') {
      return {
        type: 'About Me',
        postType: { name: 'About Me', title: 'About Me' },
        profile: { id: profileId },
        items: [],
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
            description: [e.institute, e.degree].filter(Boolean).join(' — '),
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

const getPublicCards = async (query: {
  page?: number
  per_page?: number
  state_id?: string
  city_id?: string
  profession_id?: string
  service?: string
  search?: string
}) => {
  const page = Math.max(1, Number(query.page) || 1)
  const perPage = Math.min(50, Math.max(1, Number(query.per_page) || 12))
  const where = {
    ...publicVisibleWhere(),
    slug: { not: null },
    ...(query.profession_id ? { professionId: query.profession_id } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { companyName: { contains: query.search, mode: 'insensitive' as const } },
            { prof: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [total, rows, professions, states, cities] = await Promise.all([
    prisma.profile.count({ where }),
    prisma.profile.findMany({
      where,
      include: {
        profession: true,
        attachments: { include: { attachmentType: true }, take: 5 },
      },
      skip: (page - 1) * perPage,
      take: perPage,
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.profession.findMany({ orderBy: { name: 'asc' } }),
    prisma.state.findMany({ orderBy: { name: 'asc' }, take: 500 }),
    prisma.city.findMany({ orderBy: { name: 'asc' }, take: 500 }),
  ])

  const lastPage = Math.max(1, Math.ceil(total / perPage))
  const data = rows.map((p) => {
    const profileAtt = p.attachments.find((a) =>
      matchAttachmentType(a.attachmentType?.name, ATTACHMENT_TYPE_ALIASES.profile)
    )
    const avatar =
      ensureAbsoluteMediaUrl(p.avatar, {
        docName: p.avatar,
        attachmentTypeLegacyId: 13,
        attachmentTypeName: 'Profile Picture',
        profileLegacyId: p.legacyId,
      }) || resolveAttachmentUrl(profileAtt, p.legacyId)
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      profession: p.profession?.name || p.prof,
      profession_id: p.professionId,
      image: avatar,
      image_type: avatar ? 'image' : null,
      is_video: false,
      profile_url: p.slug ? `/v/${p.slug}` : null,
    }
  })

  return {
    success: true,
    data: {
      current_page: page,
      data,
      last_page: lastPage,
      per_page: perPage,
      total,
    },
    dropdowns: {
      states: states.map((s) => ({ id: s.id, name: s.name })),
      cities: cities.map((c) => ({ id: c.id, name: c.name })),
      professions: professions.map((p) => ({ id: p.id, name: p.name })),
    },
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
      next_page_url: page < lastPage ? `?page=${page + 1}` : null,
      prev_page_url: page > 1 ? `?page=${page - 1}` : null,
    },
  }
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
  const meta = {
    ...clientMeta,
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
      profileSlug: profile.slug,
      ownerName: profile.name,
    },
    { ip: requestMeta?.ip, userAgent: requestMeta?.userAgent }
  )

  liveDashboardHub.emitKpi('save')

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

const saveNote = async (profileId: string, content: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')
  const note = await prisma.userNote.create({
    data: { profileId, content },
  })
  return { id: note.id, content: note.content, profile_id: profileId }
}

const saveContactCard = async (profileId: string, requestMeta?: { ip?: string; userAgent?: string }) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, ...publicReadableWhere() } })
  if (!profile) throw new AppError(404, 'Profile not found')

  await logEvent(
    profile.id,
    'save_contact_download',
    { profileId: profile.id, profileSlug: profile.slug, ownerName: profile.name },
    { ip: requestMeta?.ip, userAgent: requestMeta?.userAgent }
  )

  liveDashboardHub.emitKpi('save')

  return {
    action_buttons: {
      save_contact: {
        data: {
          name: profile.name,
          email: profile.email,
          phone: profile.phone,
          company: profile.companyName || '',
          website: profile.website || '',
          note: profile.about || '',
          address: profile.address || '',
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
    select: { id: true, slug: true },
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
    select: { id: true },
  })

  if (existing) {
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
    liveDashboardHub.emitKpi('view')
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
  getPublicCards,
  saveGuestUser,
  saveNote,
  saveContactCard,
  logEvent,
  trackEvent,
}

export default publicCardService
