import { buildFrontendPublicCardPath } from '../constants/frontendPublicCardPath'
import { getTabByPublicSectionName, TAB_KEY_TO_NAV_ID } from '../constants/tabRegistry'

/** Append `#tab-id` for public-card deep links (share + push open). */
export function encodePublicCardTabHash(tabId: string): string {
  const id = tabId.trim().toLowerCase().replace(/^#+/, '')
  if (!id) return ''
  const safe = id.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe ? `#${safe}` : ''
}

export function buildPublicCardPathWithTab(slug: string | null | undefined, tabId?: string | null): string | undefined {
  const trimmed = slug?.trim()
  if (!trimmed) return undefined
  const path = buildFrontendPublicCardPath(trimmed)
  const hash = tabId ? encodePublicCardTabHash(tabId) : ''
  return hash ? `${path}${hash}` : path
}

export type PushAreaMeta = {
  /** Stable public nav id used in the URL hash. */
  tabId: string
  /** Human label for notification copy ("Services", "Photos"). */
  areaLabel: string
  title: string
  /** Body template uses {{name}} for the card/business name. */
  bodyTemplate: string
}

export function pushAreaForCollection(
  kind: 'services' | 'portfolios' | 'socialLinks' | 'experiences' | 'education' | 'skillTags' | 'reviews' | 'addresses'
): PushAreaMeta | null {
  switch (kind) {
    case 'services':
      return {
        tabId: 'services',
        areaLabel: 'Services',
        title: 'Services updated',
        bodyTemplate: '{{name}} updated or added services on their vBiz Me card.',
      }
    case 'portfolios':
      return {
        tabId: 'gallery',
        areaLabel: 'Photos',
        title: 'Photos updated',
        bodyTemplate: '{{name}} updated photos in their Gallery tab.',
      }
    case 'socialLinks':
      return {
        tabId: 'profile',
        areaLabel: 'Contact links',
        title: 'Contact links updated',
        bodyTemplate: '{{name}} updated contact links on their card.',
      }
    case 'experiences':
      return {
        tabId: 'work',
        areaLabel: 'Work experience',
        title: 'Work experience updated',
        bodyTemplate: '{{name}} updated their Work Experience tab.',
      }
    case 'education':
      return {
        tabId: 'education',
        areaLabel: 'Education',
        title: 'Education updated',
        bodyTemplate: '{{name}} updated their Education tab.',
      }
    case 'skillTags':
      return {
        tabId: 'skills',
        areaLabel: 'Skills',
        title: 'Skills updated',
        bodyTemplate: '{{name}} updated their Skills tab.',
      }
    case 'reviews':
      return {
        tabId: 'reviews',
        areaLabel: 'Reviews',
        title: 'Reviews updated',
        bodyTemplate: '{{name}} updated their Reviews tab.',
      }
    default:
      return null
  }
}

export function pushAreaForProfileFields(input: {
  themeTouched: boolean
  contactTouched: boolean
  avatarTouched: boolean
  nameTouched?: boolean
}): PushAreaMeta {
  if (input.themeTouched) {
    return {
      tabId: 'home',
      areaLabel: 'Theme & design',
      title: 'Theme & design updated',
      bodyTemplate: '{{name}} updated the theme and design on their card.',
    }
  }
  if (input.avatarTouched) {
    return {
      tabId: 'home',
      areaLabel: 'Profile picture',
      title: 'Profile picture updated',
      bodyTemplate: '{{name}} updated their profile picture.',
    }
  }
  if (input.contactTouched) {
    return {
      tabId: 'profile',
      areaLabel: 'Contact info',
      title: 'Contact info updated',
      bodyTemplate: '{{name}} updated contact information on their card.',
    }
  }
  if (input.nameTouched) {
    return {
      tabId: 'home',
      areaLabel: 'Profile',
      title: 'Profile updated',
      bodyTemplate: '{{name}} updated their profile details.',
    }
  }
  return {
    tabId: 'home',
    areaLabel: 'Profile',
    title: 'Profile updated',
    bodyTemplate: '{{name}} updated their profile.',
  }
}

export function pushAreaForPostType(postTypeName?: string | null): PushAreaMeta | null {
  const name = (postTypeName || '').trim()
  if (!name) return null
  const lower = name.toLowerCase()
  if (lower.includes('event')) return null

  const tab = getTabByPublicSectionName(name)
  const navId = tab ? TAB_KEY_TO_NAV_ID[tab.key] || tab.route || tab.key : ''
  const areaLabel = tab?.label || name

  if (lower.includes('announce')) {
    return {
      tabId: navId || 'announcement',
      areaLabel: areaLabel || 'Announcements',
      title: 'New announcement',
      bodyTemplate: `{{name}} posted a new update in ${areaLabel || 'Announcements'}.`,
    }
  }
  if (lower.includes('offer') || lower.includes('promo')) {
    return {
      tabId: navId || 'services',
      areaLabel: areaLabel || 'Offers',
      title: 'New offer',
      bodyTemplate: `{{name}} added an offer in ${areaLabel || 'Offers'}.`,
    }
  }
  if (lower.includes('video')) {
    return {
      tabId: navId || 'videos',
      areaLabel: areaLabel || 'Videos',
      title: 'Videos updated',
      bodyTemplate: `{{name}} updated their ${areaLabel || 'Videos'} tab.`,
    }
  }
  if (lower.includes('blog') || lower.includes('news')) {
    return {
      tabId: navId || 'blog',
      areaLabel: areaLabel || 'Blog',
      title: 'New blog post',
      bodyTemplate: `{{name}} published a new post in ${areaLabel || 'Blog'}.`,
    }
  }
  if (lower.includes('service')) {
    return {
      tabId: navId || 'services',
      areaLabel: areaLabel || 'Services',
      title: 'Services updated',
      bodyTemplate: `{{name}} updated or added items in ${areaLabel || 'Services'}.`,
    }
  }
  if (lower.includes('gallery') || lower.includes('photo') || lower.includes('portfolio')) {
    return {
      tabId: navId || 'gallery',
      areaLabel: areaLabel || 'Photos',
      title: 'Photos updated',
      bodyTemplate: `{{name}} updated photos in ${areaLabel || 'Gallery'}.`,
    }
  }

  return {
    tabId: navId || 'home',
    areaLabel,
    title: `${areaLabel} updated`,
    bodyTemplate: `{{name}} updated their ${areaLabel} tab.`,
  }
}

export function renderPushAreaBody(template: string, businessName: string): string {
  return template.replace(/\{\{name\}\}/g, businessName.trim() || 'A vBiz Me card')
}
