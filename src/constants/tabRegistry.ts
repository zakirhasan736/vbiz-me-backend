/**
 * Canonical direct-tab registry.
 * Internal keys are snake_case. HTTP routes and public PostType display names are separate.
 */
export type TabMode = 'singleton' | 'list'
export type TabArchitecture = 'direct' | 'posts'
export type DirectSectionStorage =
  | 'about_me'
  | 'service'
  | 'client'
  | 'review'
  | 'gallery'
  | 'video'
  | 'blog'
  | 'general_post'
  | 'bbb_accreditation'
  | 'licensing'
  | 'dcp'
  | 'certificate_license'
  | 'insurance_license'
  | 'faq'
  | 'calendar_section'
  | 'property_listing'
  | 'profile_event'
  | 'media_press'
  | 'mission_statement'
  | 'video_explainer'
  | 'menu_section'
  | 'why_choose_us'
  | 'announcement_direct'
  | 'join_my_team'
  | 'booking'
  | 'additional_service'
  | 'video_link'
  | 'inventory'
  | 'home_solar'
  | 'resiliency_product'
  | 'breakfast'
  | 'lunch'
  | 'dinner'
  | 'product'
  | 'sales_person'
  | 'team_member'

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
  storage: DirectSectionStorage
}

const list = (
  key: string,
  label: string,
  route: string,
  publicSectionName: string,
  legacyPostTypeId: number,
  storage: DirectSectionStorage
): TabRegistryEntry => ({
  key,
  label,
  mode: 'list',
  route,
  publicSectionName,
  legacyPostTypeId,
  architecture: 'direct',
  storage,
})

const singleton = (
  key: string,
  label: string,
  route: string,
  publicSectionName: string,
  legacyPostTypeId: number,
  storage: DirectSectionStorage
): TabRegistryEntry => ({
  key,
  label,
  mode: 'singleton',
  route,
  publicSectionName,
  legacyPostTypeId,
  architecture: 'direct',
  storage,
})

export const TAB_REGISTRY: Record<string, TabRegistryEntry> = {
  services: list('services', 'Services', 'services', 'services', 1, 'service'),
  clients: list('clients', 'Clients', 'clients', 'clients', 2, 'client'),
  reviews: list('reviews', 'Reviews', 'reviews', 'reviews', 3, 'review'),
  gallery: list('gallery', 'Gallery', 'portfolios', 'gallery', 4, 'gallery'),
  videos: list('videos', 'Video', 'videos', 'video', 5, 'video'),
  blogs: list('blogs', 'Blogs and Media', 'blogs', 'blog', 6, 'blog'),
  general_posts: list('general_posts', 'Post', 'general-posts', 'Post', 7, 'general_post'),
  bbb_accreditations: list(
    'bbb_accreditations',
    'BBB Accreditation',
    'bbb-accreditations',
    'Better Business Bureau (BBB) Accreditation',
    8,
    'bbb_accreditation'
  ),
  licensing: list('licensing', 'Licensing', 'licensing', 'Licensing', 9, 'licensing'),
  dcp: list('dcp', 'DCP', 'dcp', 'Department of Consumer Protection (DCP)', 10, 'dcp'),
  certificates: list(
    'certificates',
    'Certificates/Licenses',
    'certificates',
    'Certificates Licenses',
    11,
    'certificate_license'
  ),
  insurance_licenses: list(
    'insurance_licenses',
    'Insurance License',
    'insurance-licenses',
    'Insurance License',
    12,
    'insurance_license'
  ),
  faqs: list('faqs', 'FAQs', 'faqs', 'Faq', 13, 'faq'),
  calendar: list('calendar', 'Calendar', 'calendar', 'calender', 14, 'calendar_section'),
  property_listings: list(
    'property_listings',
    'Property Listing',
    'property-listings',
    'Property Listing',
    15,
    'property_listing'
  ),
  about_me: singleton('about_me', 'About Me', 'about-me', 'About Me', 16, 'about_me'),
  events: list('events', 'Events', 'events', 'Events', 17, 'profile_event'),
  media_press: list('media_press', 'Media/Press', 'media-press', 'Media Press', 18, 'media_press'),
  mission_statement: list(
    'mission_statement',
    'Mission Statement',
    'mission-statement',
    'Mission Statement',
    19,
    'mission_statement'
  ),
  video_explainers: list(
    'video_explainers',
    '2D Video Explainer',
    'video-explainers',
    '2D Video Explainer',
    20,
    'video_explainer'
  ),
  menu: list('menu', 'Menu', 'menu', 'Menu', 21, 'menu_section'),
  why_choose_us: singleton('why_choose_us', 'Why Choose Us', 'why-choose-us', 'Why Choose Us', 22, 'why_choose_us'),
  announcements: list('announcements', 'Announcement', 'announcements', 'Announcement', 23, 'announcement_direct'),
  join_my_team: list('join_my_team', 'Join My Team', 'join-my-team', 'Join My Team', 24, 'join_my_team'),
  bookings: list('bookings', 'Booking', 'bookings', 'Booking', 25, 'booking'),
  additional_services: list(
    'additional_services',
    'Additional Services',
    'additional-services',
    'Additional Services',
    26,
    'additional_service'
  ),
  video_links: list('video_links', 'Video Links', 'video-links', 'Video Links', 27, 'video_link'),
  inventory: list('inventory', 'Inventory', 'inventory', 'Inventory', 28, 'inventory'),
  home_solar: list('home_solar', 'Home Solar', 'home-solar', 'Home Solar', 29, 'home_solar'),
  resiliency_products: list(
    'resiliency_products',
    'Resiliency Products',
    'resiliency-products',
    'Resiliency Products',
    30,
    'resiliency_product'
  ),
  breakfast: list('breakfast', 'Breakfast', 'breakfast', 'Breakfast', 31, 'breakfast'),
  lunch: list('lunch', 'Lunch', 'lunch', 'Lunch', 32, 'lunch'),
  dinner: list('dinner', 'Dinner', 'dinner', 'Dinner', 33, 'dinner'),
  products: list('products', 'See Products', 'products', 'See Products', 34, 'product'),
  sales_people: list('sales_people', 'Sales Person', 'sales-people', 'Sales Person', 35, 'sales_person'),
  meet_our_team: list('meet_our_team', 'Meet Our Team', 'meet-our-team', 'Meet Our Team', 36, 'team_member'),
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

const PUBLIC_SECTION_ALIASES: Record<string, string> = {
  faq: 'faqs',
  faqs: 'faqs',
  mission: 'mission_statement',
  'mission statement': 'mission_statement',
  'company mission statement': 'mission_statement',
  'mission-statement': 'mission_statement',
}

export function getTabByPublicSectionName(name: string): TabRegistryEntry | undefined {
  const needle = name.trim().toLowerCase()
  const aliasedKey = PUBLIC_SECTION_ALIASES[needle]
  if (aliasedKey) return TAB_REGISTRY[aliasedKey]
  return Object.values(TAB_REGISTRY).find(
    (t) =>
      t.publicSectionName.toLowerCase() === needle ||
      t.key.toLowerCase() === needle ||
      t.route.toLowerCase() === needle ||
      t.label.toLowerCase() === needle
  )
}

/** Public/editor nav item ids → TAB_REGISTRY keys (activated tabs on the public card). */
export const NAV_ID_TO_TAB_KEY: Record<string, string> = {
  about: 'about_me',
  mission: 'mission_statement',
  services: 'services',
  gallery: 'gallery',
  videos: 'videos',
  blog: 'blogs',
  post: 'general_posts',
  additional: 'additional_services',
  explainer: 'video_explainers',
  reviews: 'reviews',
  certificates: 'certificates',
  'insurance-license': 'insurance_licenses',
  licensing: 'licensing',
  clients: 'clients',
  'meet-team': 'meet_our_team',
  calendar: 'calendar',
  faq: 'faqs',
  'video-links': 'video_links',
  announcement: 'announcements',
  bbb: 'bbb_accreditations',
  booking: 'bookings',
  breakfast: 'breakfast',
  dcp: 'dcp',
  dinner: 'dinner',
  events: 'events',
  'home-solar': 'home_solar',
  inventory: 'inventory',
  'join-team': 'join_my_team',
  lunch: 'lunch',
  menu: 'menu',
  press: 'media_press',
  'property-listing': 'property_listings',
  resiliency: 'resiliency_products',
  'see-product': 'products',
  'sales-24h': 'sales_people',
  'who-we-are': 'why_choose_us',
}

export const TAB_KEY_TO_NAV_ID: Record<string, string> = Object.fromEntries(
  Object.entries(NAV_ID_TO_TAB_KEY).map(([navId, tabKey]) => [tabKey, navId])
)

export const NAV_CHECKBOX_TO_TAB_KEY: Record<string, string> = {
  faqNav_checkbox: 'faqs',
  '2dNav_checkbox': 'video_explainers',
  businessNav_checkbox: 'mission_statement',
  blogNav_checkbox: 'blogs',
  serviceNav_checkbox: 'services',
  galleryNav_checkbox: 'gallery',
  portfolioNav_checkbox: 'gallery',
  testimonialNav_checkbox: 'reviews',
  partnershipNav_checkbox: 'clients',
  videoLinksNav_checkbox: 'video_links',
  meetOurTeamNav_checkbox: 'meet_our_team',
  bbbNav_checkbox: 'bbb_accreditations',
  dcpNav_checkbox: 'dcp',
  restaurantMenuNav_checkbox: 'menu',
  solarNav_checkbox: 'home_solar',
  salesPersonNav_checkbox: 'sales_people',
  seeproduct_checkbox: 'products',
  certificationNav_checkbox: 'certificates',
  licensingNav_checkbox: 'licensing',
  meetingNav_checkbox: 'calendar',
  aboutMeNav_checkbox: 'about_me',
}
