import { prisma } from './prisma'

export type CardHealthCounts = {
  tabs: number
  services: number
  faqs: number
  gallery: number
  portfolio: number
  blogs: number
  reviews: number
  education: number
  experience: number
  aboutMe: number
  avatar: number
}

const EMPTY_HEALTH: CardHealthCounts = {
  tabs: 0,
  services: 0,
  faqs: 0,
  gallery: 0,
  portfolio: 0,
  blogs: 0,
  reviews: 0,
  education: 0,
  experience: 0,
  aboutMe: 0,
  avatar: 0,
}

async function safeCount(run: () => Promise<number>): Promise<number> {
  try {
    return await run()
  } catch {
    return 0
  }
}

export async function collectCardHealth(profileId: string): Promise<CardHealthCounts> {
  const id = profileId.trim()
  if (!id) return { ...EMPTY_HEALTH }

  const [
    services,
    faqs,
    gallery,
    portfolio,
    blogs,
    reviews,
    education,
    experience,
    aboutMe,
    customTabs,
    profile,
    mediaSetting,
    displaySetting,
  ] = await Promise.all([
    safeCount(() => prisma.service.count({ where: { profileId: id, status: 1 } })),
    safeCount(() => prisma.faq.count({ where: { profileId: id, deletedAt: null } })),
    safeCount(() => prisma.gallery.count({ where: { profileId: id, deletedAt: null } })),
    safeCount(() => prisma.portfolio.count({ where: { profileId: id } })),
    safeCount(() => prisma.blog.count({ where: { profileId: id, deletedAt: null } })),
    safeCount(() => prisma.review.count({ where: { profileId: id, status: 1 } })),
    safeCount(() => prisma.education.count({ where: { profileId: id } })),
    safeCount(() => prisma.experience.count({ where: { profileId: id } })),
    safeCount(() => prisma.aboutMe.count({ where: { profileId: id } })),
    safeCount(() => prisma.customTab.count({ where: { profileId: id, isEnabled: true } })),
    prisma.profile.findUnique({ where: { id }, select: { avatar: true } }).catch(() => null),
    prisma.setting
      .findFirst({ where: { profileId: id, key: 'profile_media_url' }, select: { value: true } })
      .catch(() => null),
    prisma.setting
      .findFirst({ where: { profileId: id, key: 'display_settings_json' }, select: { value: true } })
      .catch(() => null),
  ])

  let tabs = customTabs
  const rawDisplay = displaySetting?.value?.trim()
  if (rawDisplay) {
    try {
      const parsed = JSON.parse(rawDisplay) as { editorNavOrder?: unknown }
      if (Array.isArray(parsed.editorNavOrder) && parsed.editorNavOrder.length) {
        tabs = parsed.editorNavOrder.filter((value) => String(value || '').trim()).length
      }
    } catch {
      /* keep custom-tab count */
    }
  }

  const avatar = profile?.avatar?.trim() || mediaSetting?.value?.trim() ? 1 : 0

  return {
    tabs,
    services,
    faqs,
    gallery,
    portfolio,
    blogs,
    reviews,
    education,
    experience,
    aboutMe,
    avatar,
  }
}

export function formatCardHealth(health?: CardHealthCounts | null): string {
  if (!health) return ''
  const parts = [
    health.tabs ? `${health.tabs} tabs` : null,
    `${health.services} services`,
    `${health.faqs} FAQs`,
    `${health.gallery} gallery`,
    `${health.portfolio} portfolio`,
    `${health.blogs} blogs`,
    `${health.reviews} reviews`,
    health.avatar ? 'avatar on' : 'avatar off',
  ]
  return parts.filter(Boolean).join(' · ')
}
