import { getCanvaConfig } from './canva.config'

export type CanvaExportFormat = 'png' | 'jpg' | 'mp4' | 'pdf'

export type CanvaDesignSummary = {
  id: string
  title?: string
  updated_at?: number
  page_count?: number
  thumbnail?: { url?: string }
}

export type CanvaExportJob = {
  id: string
  status: 'in_progress' | 'success' | 'failed'
  urls?: string[]
  error?: { code?: string; message?: string }
}

type CanvaErrorBody = { code?: string; message?: string }

async function canvaFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const { apiBaseUrl } = getCanvaConfig()
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })

  const data = (await response.json().catch(() => ({}))) as T & CanvaErrorBody
  if (!response.ok) {
    throw new Error(data.message || data.code || `Canva API error (${response.status})`)
  }
  return data
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
  const timeoutMs = 90_000
  const intervalMs = 1_500
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const job = await getCanvaExportJob(accessToken, exportId)
    if (job.status === 'success') return job
    if (job.status === 'failed') throw new Error(job.error?.message || 'Canva export failed')
    await new Promise((r) => setTimeout(r, intervalMs))
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
