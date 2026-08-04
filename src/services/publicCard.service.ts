import crypto from 'crypto'
import type { Attachment, Setting } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'

const ATTACHMENT_TYPE_ALIASES: Record<string, string[]> = {
  profile: ['profile', 'profile pic', 'profile_pic', 'avatar', 'profile picture'],
  background: ['background', 'bg video', 'background video', 'bg_video', 'background_media'],
  intro: ['intro', 'intro video', 'profile video', '2d explainer', '2d video'],
  audio: ['audio', 'background audio', 'bg music', 'music'],
}

type AttachmentWithType = Attachment & {
  attachmentType?: { name: string | null; legacyId?: number | null } | null
}

function settingsToMap(settings: Setting[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const s of settings) {
    map[s.key] = s.value ?? ''
  }
  return map
}

function matchAttachmentType(name: string | null | undefined, aliases: string[]): boolean {
  if (!name) return false
  const n = name.toLowerCase()
  return aliases.some((a) => n.includes(a))
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

function toMediaBlock(att: AttachmentWithType | undefined, enabled = true, profileLegacyId?: number | null) {
  const url = resolveAttachmentUrl(att, profileLegacyId)
  if (!url) {
    return { enabled: false, url: null, video_url: null, is_video: false }
  }
  const isVideo =
    att?.resourceType === 'video' ||
    (att?.extension && ['mp4', 'webm', 'mov'].includes(att.extension.toLowerCase())) ||
    Boolean(url.includes('youtube') || url.includes('youtu.be'))
  return {
    enabled,
    url,
    video_url: isVideo ? url : null,
    fallback_url: url,
    type: isVideo ? 'video' : 'image',
    is_video: isVideo,
    doc_name: att?.docName || undefined,
    extension: att?.extension || undefined,
  }
}

async function getProfileBySlugOrThrow(slug: string) {
  const profile = await prisma.profile.findFirst({
    where: { slug, isPublic: true },
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
  return attachments.find(
    (a) => matchAttachmentType(a.attachmentType?.name, aliases) || matchAttachmentType(a.docName, aliases)
  )
}

function buildMyCard(profile: Awaited<ReturnType<typeof getProfileBySlugOrThrow>>) {
  const settings = settingsToMap(profile.settings)
  const features: Record<string, boolean | string | number> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (k.endsWith('_checkbox')) {
      features[k.replace('_checkbox', '')] = v === '1' || v === 'true'
    }
  }

  const primary = pickAttachment(profile.attachments, 'profile')
  const background = pickAttachment(profile.attachments, 'background')
  const intro = pickAttachment(profile.attachments, 'intro')
  const audio = pickAttachment(profile.attachments, 'audio')
  const legacyId = profile.legacyId

  const template = profile.profileSettings?.profileTemplate || profile.template || 'default'

  const address = profile.addresses.find((a) => a.isPrimary) || profile.addresses[0]

  const audioUrl = resolveAttachmentUrl(audio, legacyId)

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      slug: profile.slug,
      email: profile.email,
      phone: profile.phone,
      address: profile.address,
      city: address?.city ?? null,
      state: address?.state ?? null,
      country: address?.country ?? null,
      zipcode: profile.zipCode,
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
    background_media: toMediaBlock(background, settings.bg_video_checkbox !== '0', legacyId),
    intro_video: toMediaBlock(intro, settings.profile_video_checkbox !== '0', legacyId),
    profile_media: toMediaBlock(primary ?? undefined, true, legacyId),
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
    background_audio: audioUrl
      ? {
          enabled: true,
          url: audioUrl,
          doc_name: audio?.docName || undefined,
        }
      : undefined,
    theme_config: profile.themeConfig || profile.profileSettings?.themeConfig || undefined,
  }
}

const getMyCardBySlug = async (slug: string) => {
  const profile = await getProfileBySlugOrThrow(slug)
  await prisma.profile.update({
    where: { id: profile.id },
    data: { viewCount: { increment: 1 } },
  })
  return buildMyCard(profile)
}

const getPostTypesForProfile = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, isPublic: true } })
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

  // Also include dedicated services/portfolios as section names when present
  const [serviceCount, portfolioCount] = await Promise.all([
    prisma.service.count({ where: { profileId, status: 1 } }),
    prisma.portfolio.count({ where: { profileId, status: 1 } }),
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

  return { StaticLink, post_types }
}

const getProfileSettings = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, isPublic: true },
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
    where: { id: profileId, isPublic: true },
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

  return {
    slug: profile.slug,
    ownerName: profile.name,
    title: profile.designation,
    profession: profile.profession?.name || profile.prof,
    company: profile.companyName,
    email: profile.email,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    website: profile.website,
    address: profile.address,
    about: profile.about,
    socials: {
      facebook: profile.facebook,
      instagram: profile.instagram,
      twitter: profile.twitter,
      linkedin: profile.linkedin,
      youtube: profile.youtube,
      tiktok: profile.tiktok,
      custom: profile.socialLinks,
    },
    skills: profile.skillTags.map((s) => ({ name: s.name, level: s.level })),
    services: profile.services.map((s) => ({ title: s.title, description: s.description })),
    experience: profile.experiences.map((e) => ({
      company: e.company,
      jobTitle: e.jobTitle,
      description: e.description,
      fromDate: e.fromDate,
      toDate: e.toDate,
      tillNow: e.tillNow,
    })),
    education: profile.education.map((e) => ({
      institute: e.institute,
      degree: e.degree,
      fromDate: e.fromDate,
      toDate: e.toDate,
      tillNow: e.tillNow,
    })),
    portfolio: profile.portfolios.map((p) => ({ title: p.title, description: p.description, url: p.url })),
    customSections: [],
  }
}

const getDynamicSection = async (sectionName: string, profileId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, isPublic: true } })
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

  if (/^services$/i.test(name) || /^additional services$/i.test(name)) {
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
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          status: p.status,
          featured_image: imageUrl ? [{ id: p.id, doc_name: p.title, url: imageUrl }] : [],
          gallery: imageUrl ? [{ id: p.id, doc_name: p.title, url: imageUrl }] : [],
          general_info_url: p.url,
        }
      }),
    }
  }

  if (/^about me$/i.test(name)) {
    return {
      type: 'About Me',
      postType: { name: 'About Me', title: 'About Me' },
      profile: { id: profileId },
      items: [
        {
          id: profile.id,
          title: 'About Me',
          description: profile.about || '',
          status: '1',
        },
      ],
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

      return {
        id: p.id,
        title: p.title,
        description: p.description,
        status: p.status,
        featured_image: featuredFromField
          ? [{ id: p.id, doc_name: p.title, url: featuredFromField }]
          : attachmentImages.map(({ id, doc_name, url }) => ({ id, doc_name, url })),
        general_info_url: p.url,
        attachments: attachmentImages,
        metas: Object.fromEntries(p.metas.map((m) => [m.metaKey, m.metaValue])),
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
    isPublic: true,
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

const saveGuestUser = async (input: {
  first_name?: string
  last_name?: string
  email?: string
  profile_id: string
}) => {
  const profile = await prisma.profile.findFirst({ where: { id: input.profile_id, isPublic: true } })
  if (!profile) throw new AppError(404, 'Profile not found')
  const row = await prisma.guestUserData.create({
    data: {
      profileId: input.profile_id,
      firstName: input.first_name,
      lastName: input.last_name,
      email: input.email,
    },
  })
  return {
    id: row.id,
    first_name: row.firstName,
    last_name: row.lastName,
    email: row.email,
    profile_id: row.profileId,
  }
}

const saveNote = async (profileId: string, content: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, isPublic: true } })
  if (!profile) throw new AppError(404, 'Profile not found')
  const note = await prisma.userNote.create({
    data: { profileId, content },
  })
  return { id: note.id, content: note.content, profile_id: profileId }
}

const saveContactCard = async (profileId: string) => {
  const profile = await prisma.profile.findFirst({ where: { id: profileId, isPublic: true } })
  if (!profile) throw new AppError(404, 'Profile not found')
  return {
    action_buttons: {
      save_contact: {
        data: {
          name: profile.name,
          email: profile.email,
          phone: profile.phone || '',
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

const pushSubscribe = async (input: {
  profile_slug?: string
  profile_id?: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  browser?: string
  platform?: string
}) => {
  const profile = await prisma.profile.findFirst({
    where: input.profile_id ? { id: input.profile_id, isPublic: true } : { slug: input.profile_slug, isPublic: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const endpointHash = crypto.createHash('sha256').update(input.endpoint).digest('hex')
  const existing = await prisma.pushSubscription.findFirst({ where: { endpointHash } })

  const sub = existing
    ? await prisma.pushSubscription.update({
        where: { id: existing.id },
        data: {
          profileId: profile.id,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          isActive: true,
          lastUsedAt: new Date(),
        },
        include: { preferences: true },
      })
    : await prisma.pushSubscription.create({
        data: {
          profileId: profile.id,
          endpoint: input.endpoint,
          endpointHash,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          browser: input.browser,
          platform: input.platform,
          preferences: { create: {} },
        },
        include: { preferences: true },
      })

  return { id: sub.id, subscribed: true, preferences: sub.preferences }
}

const pushSubscriptionStatus = async (slug: string, endpoint?: string) => {
  const profile = await prisma.profile.findFirst({ where: { slug, isPublic: true } })
  if (!profile) throw new AppError(404, 'Profile not found')
  if (!endpoint) return { subscribed: false }
  const endpointHash = crypto.createHash('sha256').update(endpoint).digest('hex')
  const sub = await prisma.pushSubscription.findFirst({
    where: { profileId: profile.id, endpointHash, isActive: true },
    include: { preferences: true },
  })
  return { subscribed: Boolean(sub), preferences: sub?.preferences || null }
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
  pushSubscribe,
  pushSubscriptionStatus,
}

export default publicCardService
