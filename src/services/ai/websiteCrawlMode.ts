export type WebsiteCrawlMode = 'full' | 'storefront'

const EXPLICIT_STOREFRONT = /^(storefront|vendor|seller|seller_page|myshop|single_page|partial)$/i
const EXPLICIT_FULL = /^(full|site|website|company)$/i

/**
 * Personalized seller / vendor / affiliate storefront URLs where a whole-site
 * crawl drowns the person and catalog in marketplace chrome.
 */
export function looksLikeStorefrontUrl(rawUrl: string): boolean {
  const value = String(rawUrl || '').trim()
  if (!value) return false
  let host = ''
  let path: string
  let href: string
  try {
    const parsed = new URL(value.startsWith('http') ? value : `https://${value}`)
    host = parsed.hostname.toLowerCase()
    path = `${parsed.pathname}${parsed.search}`.toLowerCase()
    href = parsed.href.toLowerCase()
  } catch {
    href = value.toLowerCase()
    path = href
  }

  if (
    /amway\.|amwayglobal\.|Quixtar\.|myshop\.amway|amway\.com\/.*myshop|amway\.com\/.*shop/i.test(href) ||
    /myshop|my-shop|mystore|my-store|storefront|seller|vendor|affiliate|ibo\b|independent.?seller/i.test(
      `${host} ${path}`
    )
  ) {
    return true
  }

  if (
    /shopify\.com|myshopify\.com|etsy\.com\/shop|amazon\.[a-z.]+\/shop|ebay\.[a-z.]+\/usr|walmart\.[a-z.]+\/seller/i.test(
      href
    )
  ) {
    return true
  }

  if (/\/(shop|store|seller|vendor|affiliate|rep|consultant|distributor)(\/|$)/i.test(path)) {
    return true
  }

  return false
}

export function detectWebsiteCrawlMode(url: string, explicit?: string | null): WebsiteCrawlMode {
  const hint = String(explicit || '').trim()
  if (hint && EXPLICIT_STOREFRONT.test(hint)) return 'storefront'
  if (hint && EXPLICIT_FULL.test(hint)) return 'full'
  return looksLikeStorefrontUrl(url) ? 'storefront' : 'full'
}

export const STOREFRONT_SOURCE_PREAMBLE = `SELLER / VENDOR / STOREFRONT MODE (partial seller):
- The provided URL is this person's personalized seller, vendor, affiliate, or MyShop page — not the full corporate marketplace.
- Read ONLY the seller/storefront information available from the crawled page(s) for this URL.
- Prefer the seller/owner name, title, contact, and their offered products/services over the parent brand (e.g. Amway corporate).
- Put catalog lines into services[] (title + short description + product URL when present).
- Also list product/brand names in products[].
- Put authentic product packaging photos into portfolio[] with title, description, url, and imageUrl when image URLs appear in IMAGES: lines.
- Do NOT invent products or images. Do NOT treat the marketplace homepage as the business identity.
- If the storefront is thin, keep unknown fields null and use owner-typed notes when provided.`
