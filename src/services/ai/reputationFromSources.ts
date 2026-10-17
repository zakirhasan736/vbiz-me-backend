/**
 * Mine social / review URLs already present in crawled or document text/HTML.
 * Does not call third-party search APIs or invent profiles.
 * External Google/LinkedIn/Yelp APIs require separate credentials (not wired here).
 */

export type ReputationLink = {
  platform: string
  url: string
  kind: 'social' | 'review'
  verification: 'verified_from_source' | 'needs_confirmation'
}

const PATTERNS: Array<{ platform: string; kind: 'social' | 'review'; re: RegExp }> = [
  { platform: 'linkedin', kind: 'social', re: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[^\s"'<>]+/gi },
  { platform: 'facebook', kind: 'social', re: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi },
  { platform: 'instagram', kind: 'social', re: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi },
  {
    platform: 'youtube',
    kind: 'social',
    re: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:@|channel\/|c\/|user\/)?|youtu\.be\/)[^\s"'<>]+/gi,
  },
  { platform: 'tiktok', kind: 'social', re: /https?:\/\/(?:www\.)?tiktok\.com\/@[^\s"'<>]+/gi },
  { platform: 'x', kind: 'social', re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/gi },
  {
    platform: 'google_business',
    kind: 'review',
    re: /https?:\/\/(?:www\.)?(?:g\.page|maps\.app\.goo\.gl|google\.com\/maps)\/[^\s"'<>]+/gi,
  },
  { platform: 'yelp', kind: 'review', re: /https?:\/\/(?:www\.)?yelp\.com\/biz\/[^\s"'<>]+/gi },
  { platform: 'bbb', kind: 'review', re: /https?:\/\/(?:www\.)?bbb\.org\/[^\s"'<>]+/gi },
  { platform: 'trustpilot', kind: 'review', re: /https?:\/\/(?:www\.)?trustpilot\.com\/review\/[^\s"'<>]+/gi },
  { platform: 'angi', kind: 'review', re: /https?:\/\/(?:www\.)?(?:angi|angieslist)\.com\/[^\s"'<>]+/gi },
  { platform: 'houzz', kind: 'review', re: /https?:\/\/(?:www\.)?houzz\.com\/[^\s"'<>]+/gi },
  {
    platform: 'zillow',
    kind: 'review',
    re: /https?:\/\/(?:www\.)?zillow\.com\/(profile|lender-profile)\/[^\s"'<>]+/gi,
  },
  { platform: 'realtor', kind: 'review', re: /https?:\/\/(?:www\.)?realtor\.com\/realestateagents\/[^\s"'<>]+/gi },
  { platform: 'dealerrater', kind: 'review', re: /https?:\/\/(?:www\.)?dealerrater\.com\/[^\s"'<>]+/gi },
  { platform: 'cars', kind: 'review', re: /https?:\/\/(?:www\.)?cars\.com\/dealers\/[^\s"'<>]+/gi },
  { platform: 'threads', kind: 'social', re: /https?:\/\/(?:www\.)?threads\.net\/@[^\s"'<>]+/gi },
  { platform: 'pinterest', kind: 'social', re: /https?:\/\/(?:www\.)?pinterest\.com\/[^\s"'<>]+/gi },
]

function cleanUrl(raw: string): string {
  return raw.replace(/[),.]+$/g, '').trim()
}

export function extractReputationLinksFromText(text: string): ReputationLink[] {
  if (!text.trim()) return []
  const seen = new Set<string>()
  const out: ReputationLink[] = []
  for (const pattern of PATTERNS) {
    const matches = text.match(pattern.re) || []
    for (const match of matches) {
      const url = cleanUrl(match)
      const key = url.toLowerCase()
      if (!url || seen.has(key)) continue
      seen.add(key)
      out.push({
        platform: pattern.platform,
        url,
        kind: pattern.kind,
        verification: 'verified_from_source',
      })
    }
  }
  return out.slice(0, 40)
}

/** Pull reputation/social hrefs from raw HTML (often stripped by html→text). */
export function extractReputationLinksFromHtml(html: string): ReputationLink[] {
  if (!html.trim()) return []
  const hrefs = Array.from(html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)).map((m) => m[1])
  return extractReputationLinksFromText(hrefs.join('\n'))
}

/**
 * Soft identity filter: keep links that mention the business domain/name tokens,
 * or keep all when identity signals are too thin (mark uncertain LinkedIn for confirmation).
 */
export function filterReputationLinksForIdentity(
  links: ReputationLink[],
  identity: { businessName?: string | null; ownerName?: string | null; website?: string | null }
): ReputationLink[] {
  let domain = ''
  try {
    if (identity.website)
      domain = new URL(
        identity.website.startsWith('http') ? identity.website : `https://${identity.website}`
      ).hostname.replace(/^www\./, '')
  } catch {
    domain = ''
  }
  const tokens = [identity.businessName, identity.ownerName]
    .flatMap((value) =>
      String(value || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
    )
    .filter((t) => t.length >= 3)
  if (!domain && tokens.length < 2) return links

  return links.map((link) => {
    const hay = link.url.toLowerCase()
    const domainHit = domain ? hay.includes(domain.split('.')[0] || domain) : false
    const tokenHit = tokens.some((t) => hay.includes(t))
    if (link.platform === 'linkedin' && !domainHit && !tokenHit) {
      return { ...link, verification: 'needs_confirmation' as const }
    }
    return link
  })
}

/** HEX colors mentioned in CSS/HTML/text (verified from source markup). */
export function extractHexColorsFromText(text: string, limit = 12): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string) => {
    const hex =
      raw.length === 4 ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase() : raw.toLowerCase()
    if (seen.has(hex)) return
    if (/^#(fff|000|ffffff|000000)$/i.test(hex)) return
    seen.add(hex)
    out.push(hex)
  }

  // Prefer deterministic BRAND COLOR RESEARCH recommendations first.
  for (const match of text.matchAll(
    /Recommended (?:light|dark) Primary\/Secondary\/Accent:\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})/gi
  )) {
    push(match[1])
    push(match[2])
    push(match[3])
    if (out.length >= limit) return out.slice(0, limit)
  }

  const matches = text.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || []
  for (const match of matches) {
    push(match)
    if (out.length >= limit) break
  }
  return out
}

export function formatReputationBlock(links: ReputationLink[], hexColors: string[]): string {
  const lines: string[] = [
    'BUSINESS INTELLIGENCE SIGNALS (from crawl/documents/HTML links — do not invent more URLs):',
    'Identity: match name + company + website domain before treating a profile as verified.',
  ]
  if (links.length) {
    for (const link of links) {
      lines.push(`- ${link.kind.toUpperCase()} ${link.platform}: ${link.url} [${link.verification}]`)
    }
  } else {
    lines.push('- No social/review URLs found in sources.')
  }
  if (hexColors.length) {
    lines.push(`- Brand HEX candidates from website/documents: ${hexColors.join(', ')}`)
    lines.push(
      '- If PDF/text names Light/Dark Primary·Secondary·Accent, put those exact HEX into themeRecommendation (source "document").'
    )
    lines.push(
      '- Else prefer the deterministic BRAND COLOR RESEARCH light/dark Primary·Secondary·Accent (source "website"). Do not invent different brand hues when research already resolved them.'
    )
    lines.push(
      '- Role mapping: Primary=main CTA/nav/Home description; Secondary=section banners/Home name/text·icons on Primary&Accent buttons; Accent=My vCard + social circle fills. Keep contrast readable on light (#fff) and dark (#020914) surfaces.'
    )
  } else {
    lines.push(
      '- No brand HEX colors found in sources. Prefer themeRecommendation null/empty so Card Settings keep system default Global Color. If you include design notes, use source "suggestion" only — the app will not overwrite defaults with suggestions.'
    )
  }
  return lines.join('\n')
}
