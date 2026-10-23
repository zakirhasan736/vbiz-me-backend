import { getCanvaConfig } from './canva.config'

export type CanvaExportFormat = 'png' | 'jpg' | 'mp4' | 'pdf'

export type CanvaDesignSummary = {
  id: string
  title?: string
  updated_at?: number
  page_count?: number
  thumbnail?: { url?: string }
  urls?: { edit_url?: string; view_url?: string }
  owner?: { user_id?: string; team_id?: string }
}

export type CanvaExportJob = {
  id: string
  status: 'in_progress' | 'success' | 'failed'
  urls?: string[]
  error?: { code?: string; message?: string }
}

type CanvaErrorBody = { code?: string; message?: string }

export class CanvaApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'CanvaApiError'
    this.status = status
    this.code = code
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function canvaFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const { apiBaseUrl } = getCanvaConfig()
  const maxAttempts = 4

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    })

    const data = (await response.json().catch(() => ({}))) as T & CanvaErrorBody

    if (response.status === 429 && attempt < maxAttempts - 1) {
      const retryAfter = Number(response.headers.get('retry-after') || 0)
      await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt))
      continue
    }

    if (!response.ok) {
      throw new CanvaApiError(
        response.status,
        data.message || data.code || `Canva API error (${response.status})`,
        data.code
      )
    }
    return data
  }

  throw new CanvaApiError(429, 'Canva API rate limited')
}

export async function createCanvaDesign(accessToken: string, input: { title: string; width: number; height: number }) {
  const data = await canvaFetch<{ design: CanvaDesignSummary }>(accessToken, '/designs', {
    method: 'POST',
    body: JSON.stringify({
      design_type: {
        type: 'custom',
        width: input.width,
        height: input.height,
      },
      title: input.title.slice(0, 255),
    }),
  })
  return data.design
}

export async function getCanvaDesign(accessToken: string, designId: string) {
  const data = await canvaFetch<{ design: CanvaDesignSummary }>(accessToken, `/designs/${encodeURIComponent(designId)}`)
  return data.design
}

export async function listCanvaDesigns(
  accessToken: string,
  options?: { query?: string; continuation?: string; limit?: number }
) {
  const params = new URLSearchParams({
    ownership: 'owned',
    sort_by: 'modified_descending',
    limit: String(options?.limit ?? 40),
  })
  if (options?.query?.trim()) params.set('query', options.query.trim())
  if (options?.continuation) params.set('continuation', options.continuation)

  const data = await canvaFetch<{ items?: CanvaDesignSummary[]; continuation?: string }>(
    accessToken,
    `/designs?${params.toString()}`
  )
  return { items: data.items ?? [], continuation: data.continuation }
}

function buildExportFormatBody(format: CanvaExportFormat) {
  if (format === 'mp4') {
    return { type: 'mp4' as const, quality: 'horizontal_1080p' as const, export_quality: 'regular' as const }
  }
  if (format === 'pdf') return { type: 'pdf' as const, export_quality: 'regular' as const }
  if (format === 'jpg') return { type: 'jpg' as const, export_quality: 'regular' as const }
  return { type: 'png' as const, export_quality: 'regular' as const }
}

export async function createCanvaExportJob(accessToken: string, designId: string, format: CanvaExportFormat) {
  const data = await canvaFetch<{ job: CanvaExportJob }>(accessToken, '/exports', {
    method: 'POST',
    body: JSON.stringify({ design_id: designId, format: buildExportFormatBody(format) }),
  })
  return data.job
}

export async function getCanvaExportJob(accessToken: string, exportId: string) {
  const data = await canvaFetch<{ job: CanvaExportJob }>(accessToken, `/exports/${exportId}`)
  return data.job
}

export async function waitForCanvaExport(accessToken: string, exportId: string) {
  const timeoutMs = 120_000
  let delayMs = 1_200
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const job = await getCanvaExportJob(accessToken, exportId)
    if (job.status === 'success') return job
    if (job.status === 'failed') {
      const code = job.error?.code || ''
      const message = job.error?.message || 'Canva export failed'
      if (/premium|license|payment/i.test(`${code} ${message}`)) {
        throw new Error(
          'Export failed because this design uses premium Canva elements that cannot be exported with the current account. Remove premium elements or upgrade in Canva, then retry.'
        )
      }
      throw new Error(message)
    }
    await sleep(delayMs)
    delayMs = Math.min(8_000, Math.round(delayMs * 1.35))
  }

  throw new Error('Canva export timed out — try again in a moment')
}

export async function downloadCanvaUrl(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download Canva export (${response.status})`)
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
