import type { CanvaExportFormat } from './canva.api'

export type CanvaMediaKind = 'image' | 'video'

export type CanvaFieldPreset = {
  width: number
  height: number
  mediaKind: CanvaMediaKind
  exportFormat: CanvaExportFormat
  titlePrefix: string
}

const PRESETS: Record<string, CanvaFieldPreset> = {
  'profile image/video': { width: 1080, height: 1080, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Profile' },
  'profile image': { width: 1080, height: 1080, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Profile' },
  'business logo': { width: 1024, height: 1024, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Logo' },
  logo: { width: 1024, height: 1024, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Logo' },
  'background video/image': {
    width: 1920,
    height: 1080,
    mediaKind: 'image',
    exportFormat: 'png',
    titlePrefix: 'Background',
  },
  'background image': { width: 1920, height: 1080, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Background' },
  banner: { width: 1920, height: 640, mediaKind: 'image', exportFormat: 'jpg', titlePrefix: 'Banner' },
  'intro vcard video': {
    width: 1920,
    height: 1080,
    mediaKind: 'video',
    exportFormat: 'mp4',
    titlePrefix: 'Intro video',
  },
  'explainer video': { width: 1920, height: 1080, mediaKind: 'video', exportFormat: 'mp4', titlePrefix: 'Explainer' },
  'service featured': { width: 1280, height: 960, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Service' },
  'portfolio gallery': { width: 1600, height: 1200, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'Gallery' },
  'blog featured': { width: 1600, height: 900, mediaKind: 'image', exportFormat: 'jpg', titlePrefix: 'Blog' },
  'about me media': { width: 1600, height: 900, mediaKind: 'image', exportFormat: 'png', titlePrefix: 'About' },
}

const DEFAULT_IMAGE: CanvaFieldPreset = {
  width: 1080,
  height: 1080,
  mediaKind: 'image',
  exportFormat: 'png',
  titlePrefix: 'vBiz design',
}

const DEFAULT_VIDEO: CanvaFieldPreset = {
  width: 1920,
  height: 1080,
  mediaKind: 'video',
  exportFormat: 'mp4',
  titlePrefix: 'vBiz video',
}

export function resolveCanvaFieldPreset(input: {
  fieldKey?: string | null
  attachmentType?: string | null
  mediaKind?: CanvaMediaKind | null
  width?: number | null
  height?: number | null
  exportFormat?: CanvaExportFormat | null
}): CanvaFieldPreset {
  const key = (input.attachmentType || input.fieldKey || '').trim().toLowerCase()
  const matched = key ? PRESETS[key] : undefined
  const base = matched || (input.mediaKind === 'video' || key.includes('video') ? DEFAULT_VIDEO : DEFAULT_IMAGE)

  const width = clampDim(input.width ?? base.width)
  const height = clampDim(input.height ?? base.height)
  const area = width * height
  const safe = area > 25_000_000 ? scaleToMaxArea(width, height, 25_000_000) : { width, height }

  const exportFormat: CanvaExportFormat =
    input.exportFormat === 'mp4' ||
    input.exportFormat === 'jpg' ||
    input.exportFormat === 'pdf' ||
    input.exportFormat === 'png'
      ? input.exportFormat
      : base.exportFormat

  const mediaKind: CanvaMediaKind =
    exportFormat === 'mp4' || input.mediaKind === 'video' || base.mediaKind === 'video' ? 'video' : 'image'

  return {
    ...base,
    ...safe,
    mediaKind,
    exportFormat: mediaKind === 'video' ? 'mp4' : exportFormat === 'mp4' ? 'png' : exportFormat,
  }
}

function clampDim(n: number) {
  return Math.min(8000, Math.max(40, Math.round(n)))
}

function scaleToMaxArea(width: number, height: number, maxArea: number) {
  const scale = Math.sqrt(maxArea / (width * height))
  return {
    width: clampDim(Math.floor(width * scale)),
    height: clampDim(Math.floor(height * scale)),
  }
}
