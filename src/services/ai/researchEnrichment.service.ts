/**
 * Modular external research for AI Card Builder (Phase 3–4).
 * Website crawl remains primary. Optional SerpAPI / Brave Search when credentials exist.
 * Never invents profiles; never claims research completed when skipped/failed.
 */

import logger from '../../utils/logger'
import {
  extractReputationLinksFromText,
  filterReputationLinksForIdentity,
  type ReputationLink,
} from './reputationFromSources'
import { isBlockedFetchHostname, normalizeWebsiteUrl } from './sourceUrl'

export type ResearchVerification = 'VERIFIED' | 'NEEDS_CONFIRMATION' | 'CONFLICTING' | 'UNAVAILABLE'

export type ResearchFinding = {
  field: string
  value: string
  sourceUrl: string
  sourceType: 'website' | 'search' | 'social' | 'review' | 'document' | 'owner'
  verification: ResearchVerification
  confidence: number
  dateRetrieved: string
}

export type ResearchStatus = 'complete' | 'partial' | 'skipped' | 'failed'

export type ResearchBundle = {
  status: ResearchStatus
  provider: 'none' | 'serpapi' | 'brave' | 'crawl_only'
  findings: ResearchFinding[]
  links: ReputationLink[]
  queriesRun: string[]
  errors: string[]
  /** Prompt block for the architect — truthful about what ran. */
  promptBlock: string
}

function researchBudget(): number {
  const n = Number.parseInt(process.env.AI_CARD_RESEARCH_MAX_QUERIES || '6', 10)
  return Math.max(0, Math.min(12, Number.isFinite(n) ? n : 6))
}

function serpApiKey(): string {
  return process.env.SERPAPI_API_KEY?.trim() || process.env.SERP_API_KEY?.trim() || ''
}

function braveApiKey(): string {
  return process.env.BRAVE_SEARCH_API_KEY?.trim() || ''
}

function buildQueries(input: {
  businessName?: string
  ownerName?: string
  title?: string
  location?: string
  website?: string
}): string[] {
  const business = (input.businessName || '').trim()
  const owner = (input.ownerName || '').trim()
  const title = (input.title || '').trim()
  const location = (input.location || '').trim()
  let domain = ''
  try {
    if (input.website) {
      domain = new URL(input.website.startsWith('http') ? input.website : `https://${input.website}`).hostname.replace(
        /^www\./,
        ''
      )
    }
  } catch {
    domain = ''
  }

  const queries: string[] = []
  if (business && location) queries.push(`"${business}" ${location}`)
  if (business) queries.push(`"${business}" official website`)
  if (owner && business) queries.push(`"${owner}" "${business}"`)
  if (owner && title) queries.push(`"${owner}" ${title}`)
  if (owner || business) {
    queries.push(`${owner || business} site:linkedin.com`)
    queries.push(`"${business || owner}" yelp OR "google maps" OR trustpilot`)
  }
  if (domain) queries.push(`"${domain}" reviews`)
  return [...new Set(queries.filter(Boolean))].slice(0, researchBudget())
}

type SearchHit = { title: string; url: string; snippet: string }

async function searchSerpApi(query: string): Promise<SearchHit[]> {
  const key = serpApiKey()
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google')
  url.searchParams.set('q', query)
  url.searchParams.set('api_key', key)
  url.searchParams.set('num', '5')
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`)
  const data = (await res.json()) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>
  }
  return (data.organic_results || [])
    .filter((row) => row.link)
    .map((row) => ({
      title: String(row.title || ''),
      url: String(row.link),
      snippet: String(row.snippet || ''),
    }))
}

async function searchBrave(query: string): Promise<SearchHit[]> {
  const key = braveApiKey()
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', '5')
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Brave Search ${res.status}`)
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  return (data.web?.results || [])
    .filter((row) => row.url)
    .map((row) => ({
      title: String(row.title || ''),
      url: String(row.url),
      snippet: String(row.description || ''),
    }))
}

function hitsToFindings(hits: SearchHit[], query: string): ResearchFinding[] {
  const now = new Date().toISOString()
  const out: ResearchFinding[] = []
  for (const hit of hits) {
    try {
      const host = new URL(hit.url).hostname
      if (isBlockedFetchHostname(host)) continue
    } catch {
      continue
    }
    out.push({
      field: 'search_result',
      value: `${hit.title}: ${hit.snippet}`.slice(0, 400),
      sourceUrl: hit.url,
      sourceType: 'search',
      verification: 'NEEDS_CONFIRMATION',
      confidence: 0.45,
      dateRetrieved: now,
    })
    // Tag query for diagnostics (not customer-facing).
    void query
  }
  return out
}

function formatPromptBlock(bundle: Omit<ResearchBundle, 'promptBlock'>): string {
  const lines = [
    'EXTERNAL RESEARCH STATUS (truthful — do not invent coverage):',
    `- status: ${bundle.status}`,
    `- provider: ${bundle.provider}`,
    `- queries_run: ${bundle.queriesRun.length}`,
  ]
  if (bundle.errors.length) {
    lines.push(`- errors: ${bundle.errors.slice(0, 3).join(' | ')}`)
  }
  if (bundle.status === 'skipped') {
    lines.push(
      '- No search API credentials configured (SERPAPI_API_KEY or BRAVE_SEARCH_API_KEY). Research beyond the website crawl was skipped. Use crawl/document EXTERNAL_LINKS and BI signals only.'
    )
  }
  if (bundle.links.length) {
    lines.push('Discovered candidate profile/review URLs (confirm identity before treating as verified):')
    for (const link of bundle.links.slice(0, 20)) {
      lines.push(`- ${link.kind} ${link.platform}: ${link.url} [${link.verification}]`)
    }
  }
  if (bundle.findings.length) {
    lines.push('Search snippets (NEEDS_CONFIRMATION — not proven facts):')
    for (const finding of bundle.findings.slice(0, 12)) {
      lines.push(`- ${finding.sourceUrl} — ${finding.value.slice(0, 160)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Run optional web search enrichment. Safe when keys missing: status=skipped.
 */
export async function runExternalResearch(input: {
  businessName?: string
  ownerName?: string
  title?: string
  location?: string
  website?: string
  /** Existing crawl/document corpus for identity filtering. */
  crawlText?: string
}): Promise<ResearchBundle> {
  const website = input.website ? normalizeWebsiteUrl(input.website) : ''
  const queries = buildQueries({ ...input, website })
  const crawlLinks = filterReputationLinksForIdentity(extractReputationLinksFromText(input.crawlText || ''), {
    businessName: input.businessName,
    ownerName: input.ownerName,
    website,
  })

  if (!queries.length || researchBudget() === 0) {
    const base = {
      status: 'skipped' as const,
      provider: 'crawl_only' as const,
      findings: [] as ResearchFinding[],
      links: crawlLinks,
      queriesRun: [] as string[],
      errors: [] as string[],
    }
    return { ...base, promptBlock: formatPromptBlock(base) }
  }

  const hasSerp = Boolean(serpApiKey())
  const hasBrave = Boolean(braveApiKey())
  if (!hasSerp && !hasBrave) {
    const base = {
      status: 'skipped' as const,
      provider: 'none' as const,
      findings: [] as ResearchFinding[],
      links: crawlLinks,
      queriesRun: [] as string[],
      errors: ['No SERPAPI_API_KEY or BRAVE_SEARCH_API_KEY — external search skipped.'],
    }
    logger.info('card_agent_research_skipped', { reason: 'no_credentials', crawlLinks: crawlLinks.length })
    return { ...base, promptBlock: formatPromptBlock(base) }
  }

  const provider = hasSerp ? ('serpapi' as const) : ('brave' as const)
  const search = hasSerp ? searchSerpApi : searchBrave
  const findings: ResearchFinding[] = []
  const errors: string[] = []
  const queriesRun: string[] = []

  for (const query of queries) {
    try {
      queriesRun.push(query)
      const hits = await search(query)
      findings.push(...hitsToFindings(hits, query))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'search failed')
    }
  }

  const searchText = findings.map((f) => f.sourceUrl).join('\n')
  const searchLinks = filterReputationLinksForIdentity(extractReputationLinksFromText(searchText), {
    businessName: input.businessName,
    ownerName: input.ownerName,
    website,
  })
  const seen = new Set(crawlLinks.map((l) => l.url.toLowerCase()))
  const mergedLinks = [...crawlLinks]
  for (const link of searchLinks) {
    const key = link.url.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    mergedLinks.push(link)
  }

  const status: ResearchStatus =
    findings.length > 0 && errors.length === 0
      ? 'complete'
      : findings.length > 0
        ? 'partial'
        : errors.length
          ? 'failed'
          : 'partial'

  const base = {
    status,
    provider,
    findings: findings.slice(0, 40),
    links: mergedLinks.slice(0, 40),
    queriesRun,
    errors,
  }
  logger.info('card_agent_research_finished', {
    status,
    provider,
    queries: queriesRun.length,
    findings: findings.length,
    links: mergedLinks.length,
  })
  return { ...base, promptBlock: formatPromptBlock(base) }
}

/** Merge research links into a prompt corpus without claiming unverified facts. */
export function appendResearchToExtractedText(extractedText: string, bundle: ResearchBundle): string {
  if (!bundle.promptBlock.trim()) return extractedText
  return `${bundle.promptBlock}\n\n---\n\n${extractedText}`
}
