import { Prisma } from '../../generated/prisma/client'

export type StoredMediaFrame = {
  focusX: number
  focusY: number
  zoom: number
  height: number
}

const ZOOM_MIN = 1
const ZOOM_MAX = 2.5
const HEIGHT_MIN = 0.7
const HEIGHT_MAX = 1.6

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readNumber(value: unknown, fallback: number, min: number, max: number, decimals = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const factor = 10 ** decimals
  return clamp(Math.round(n * factor) / factor, min, max)
}

/** Saved crop for a featured image or video. Null when the visitor should see the original fit. */
export function parseStoredMediaFrame(value: unknown): StoredMediaFrame | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return parseStoredMediaFrame(JSON.parse(trimmed))
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.focusX == null && raw.focusY == null && raw.zoom == null && raw.height == null) return null
  return {
    focusX: readNumber(raw.focusX, 50, 0, 100),
    focusY: readNumber(raw.focusY, 50, 0, 100),
    zoom: readNumber(raw.zoom, 1, ZOOM_MIN, ZOOM_MAX, 2),
    height: readNumber(raw.height, 1, HEIGHT_MIN, HEIGHT_MAX, 2),
  }
}

export function readRowMediaFrame(
  row: { mediaFrame?: unknown; metas?: unknown } | null | undefined
): StoredMediaFrame | null {
  if (!row) return null
  const fromColumn = parseStoredMediaFrame(row.mediaFrame)
  if (fromColumn) return fromColumn
  if (row.metas && typeof row.metas === 'object' && !Array.isArray(row.metas)) {
    return parseStoredMediaFrame((row.metas as Record<string, unknown>).mediaFrame)
  }
  return null
}

export function metasWithoutMediaFrame(metas: Record<string, unknown>): Record<string, unknown> {
  if (!('mediaFrame' in metas)) return metas
  const next = { ...metas }
  delete next.mediaFrame
  return next
}

/** Merge a crop into a metas JSON bag. `undefined` leaves metas unchanged. */
export function metasWithMediaFrame(metas: unknown, mediaFrame: unknown): Prisma.InputJsonValue | undefined {
  if (mediaFrame === undefined && (metas == null || metas === undefined)) return undefined
  const base =
    metas && typeof metas === 'object' && !Array.isArray(metas) ? { ...(metas as Record<string, unknown>) } : {}
  if (mediaFrame !== undefined) {
    const parsed = parseStoredMediaFrame(mediaFrame)
    if (parsed) base.mediaFrame = parsed
    else delete base.mediaFrame
  }
  return base as Prisma.InputJsonValue
}

/** Prisma JSON columns reject plain `null`; `DbNull` writes SQL NULL and clears a saved crop. */
export function mediaFrameColumnValue(mediaFrame: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return parseStoredMediaFrame(mediaFrame) ?? Prisma.DbNull
}
