/**
 * Canonical direct-tab registry.
 * Internal keys are snake_case. HTTP routes and public PostType display names are separate.
 */
export type TabMode = 'singleton' | 'list'
export type TabArchitecture = 'direct' | 'posts'

export type TabRegistryEntry = {
  key: string
  label: string
  mode: TabMode
  route: string
  /** Exact public dynamic-section / PostType name when applicable */
  publicSectionName: string
  legacyPostTypeId: number
  architecture: TabArchitecture
  /** Storage backend for direct tabs */
  storage: 'about_me' | 'service' | 'portfolio' | 'review' | 'blog' | 'tab_item' | 'posts'
}

const list = (
  key: string,
  label: string,
  route: string,
  publicSectionName: string,
  legacyPostTypeId: number,
  storage: TabRegistryEntry['storage'] = 'tab_item'
): TabRegistryEntry => ({
  key,
  label,
  mode: 'list',
  route,
  publicSectionName,
  legacyPostTypeId,
  architecture: storage === 'posts' ? 'posts' : 'direct',
  storage,
})

const singleton = (
  key: string,
  label: string,
  route: string,
  publicSectionName: string,
  legacyPostTypeId: number,
  storage: TabRegistryEntry['storage'] = 'tab_item'
): TabRegistryEntry => ({
  key,
  label,
  mode: 'singleton',
  route,
  publicSectionName,
  legacyPostTypeId,
  architecture: storage === 'posts' ? 'posts' : 'direct',
  storage,
})

export const TAB_REGISTRY: Record<string, TabRegistryEntry> = {
  services: list('services', 'Services', 'services', 'services', 1, 'service'),
  clients: list('clients', 'Clients', 'clients', 'clients', 2),
  reviews: list('reviews', 'Reviews', 'reviews', 'reviews', 3, 'review'),
  gallery: list('gallery', 'Gallery', 'portfolios', 'gallery', 4, 'portfolio'),
  videos: list('videos', 'Video', 'videos', 'video', 5),
  blogs: list('blogs', 'Blog', 'blogs', 'blog', 6, 'blog'),
  general_posts: list('general_posts', 'Post', 'general-posts', 'Post', 7),
  bbb_accreditations: list(
    'bbb_accreditations',
    'BBB Accreditation',
    'bbb-accreditations',
    'Better Business Bureau (BBB) Accreditation',
    8
  ),
  licensing: list('licensing', 'Licensing', 'licensing', 'Licensing', 9),
  dcp: list('dcp', 'DCP', 'dcp', 'Department of Consumer Protection (DCP)', 10),
  certificates: list('certificates', 'Certificates/Licenses', 'certificates', 'Certificates Licenses', 11),
  insurance_licenses: list('insurance_licenses', 'Insurance License', 'insurance-licenses', 'Insurance License', 12),
  faqs: list('faqs', 'FAQ', 'faqs', 'Faq', 13),
  calendar: list('calendar', 'Calendar', 'calendar', 'calender', 14),
  property_listings: list('property_listings', 'Property Listing', 'property-listings', 'Property Listing', 15),
  about_me: singleton('about_me', 'About Me', 'about-me', 'About Me', 16, 'about_me'),
  events: list('events', 'Events', 'events', 'Events', 17),
  media_press: list('media_press', 'Media/Press', 'media-press', 'Media Press', 18),
  mission_statement: singleton('mission_statement', 'Mission Statement', 'mission-statement', 'Mission Statement', 19),
  video_explainers: list('video_explainers', '2D Video Explainer', 'video-explainers', '2D Video Explainer', 20),
  menu: list('menu', 'Menu', 'menu', 'Menu', 21),
  why_choose_us: singleton('why_choose_us', 'Why Choose Us', 'why-choose-us', 'Why Choose Us', 22),
  announcements: list('announcements', 'Announcement', 'announcements', 'Announcement', 23),
  join_my_team: list('join_my_team', 'Join My Team', 'join-my-team', 'Join My Team', 24),
  bookings: list('bookings', 'Booking', 'bookings', 'Booking', 25),
  additional_services: list(
    'additional_services',
    'Additional Services',
    'additional-services',
    'Additional Services',
    26
  ),
  video_links: list('video_links', 'Video Links', 'video-links', 'Video Links', 27),
  inventory: list('inventory', 'Inventory', 'inventory', 'Inventory', 28),
  home_solar: list('home_solar', 'Home Solar', 'home-solar', 'Home Solar', 29),
  resiliency_products: list(
    'resiliency_products',
    'Resiliency Products',
    'resiliency-products',
    'Resiliency Products',
    30
  ),
  breakfast: list('breakfast', 'Breakfast', 'breakfast', 'Breakfast', 31),
  lunch: list('lunch', 'Lunch', 'lunch', 'Lunch', 32),
  dinner: list('dinner', 'Dinner', 'dinner', 'Dinner', 33),
  products: list('products', 'See Products', 'products', 'See Products', 34),
  sales_people: list('sales_people', 'Sales Person', 'sales-people', 'Sales Person', 35),
  meet_our_team: list('meet_our_team', 'Meet Our Team', 'meet-our-team', 'Meet Our Team', 36),
}

export const LEGACY_POST_TYPE_TO_TAB: Record<number, string> = Object.fromEntries(
  Object.values(TAB_REGISTRY).map((t) => [t.legacyPostTypeId, t.key])
)

export function getTabByKey(key: string): TabRegistryEntry | undefined {
  return TAB_REGISTRY[key]
}

export function getDirectTabs(): TabRegistryEntry[] {
  return Object.values(TAB_REGISTRY).filter((t) => t.architecture === 'direct')
}

export function getPostsTabs(): TabRegistryEntry[] {
  return Object.values(TAB_REGISTRY).filter((t) => t.architecture === 'posts')
}

export function getTabByPublicSectionName(name: string): TabRegistryEntry | undefined {
  const needle = name.trim().toLowerCase()
  return Object.values(TAB_REGISTRY).find((t) => t.publicSectionName.toLowerCase() === needle)
}
