import config from '../configs/config'

/** Laravel attachment_type_id → public/storage/ecard/{folder} */
const FOLDER_BY_TYPE_ID: Record<number, string> = {
  1: 'profileimages',
  2: 'videos',
  3: 'music',
  5: 'portFolios',
  6: 'services',
  7: 'featuredImages',
  8: 'posts',
  9: 'backgroundVideos',
  13: 'profileimages',
  14: 'videoExplainers',
}

const ALL_FOLDERS = [
  'profileimages',
  'featuredImages',
  'posts',
  'portFolios',
  'services',
  'videos',
  'music',
  'backgroundVideos',
  'videoExplainers',
  'attachments',
] as const

/** Types whose doc_name is already an external URL (YouTube, etc.) */
export const EXTERNAL_LINK_TYPE_IDS = new Set([10, 11])

const FOLDER_BY_TYPE_NAME: Array<{ match: RegExp; folder: string }> = [
  { match: /profile\s*(picture|pic|image)?/i, folder: 'profileimages' },
  { match: /background\s*video/i, folder: 'backgroundVideos' },
  { match: /background\s*music|music|audio/i, folder: 'music' },
  { match: /portfolio|gallery/i, folder: 'portFolios' },
  { match: /service/i, folder: 'services' },
  { match: /featured/i, folder: 'featuredImages' },
  { match: /\bpost\b/i, folder: 'posts' },
  { match: /explainer|2d/i, folder: 'videoExplainers' },
  { match: /\bvideo\b/i, folder: 'videos' },
]

export type LegacyMediaInput = {
  url?: string | null
  docName?: string | null
  attachmentTypeLegacyId?: number | null
  attachmentTypeName?: string | null
  profileLegacyId?: number | null
  /** Optional: also try profile slug folders (some admin JS used slug). */
  profileSlug?: string | null
}

const mediaBase = () => (config.MEDIA_BASE_URL || 'https://app.vbizme.com').replace(/\/$/, '')

export const isAbsoluteMediaUrl = (value?: string | null): boolean => {
  if (!value) return false
  return /^https?:\/\//i.test(value) || value.startsWith('//')
}

const MEDIA_FILE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|pdf)(?:$|[?#])/i
const EXTERNAL_PAGE_HOST =
  /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|facebook\.com|fb\.watch|tiktok\.com|instagram\.com|linkedin\.com|google\.com|g\.page|maps\.app|rumble\.com)$/i

/** Uploaded files and S3 keys — safe to treat as featured images/videos. */
export const looksLikeMediaAssetUrl = (value?: string | null): boolean => {
  if (!value) return false
  const raw = value.trim()
  if (!raw) return false
  if (/\/storage\/ecard\//i.test(raw) || /amazonaws\.com|\.s3[.-]|cloudfront\.net/i.test(raw)) return true
  return MEDIA_FILE_EXT.test(raw.split('?')[0] || raw)
}

/** Watch/page links (YouTube, Google review, etc.) must not be sent as featured images. */
export const looksLikeExternalPageUrl = (value?: string | null): boolean => {
  if (!value || looksLikeMediaAssetUrl(value)) return false
  try {
    const host = new URL(value.startsWith('//') ? `https:${value}` : value).hostname.toLowerCase()
    return EXTERNAL_PAGE_HOST.test(host)
  } catch {
    return false
  }
}

export const isAlreadyOnS3 = (url?: string | null): boolean => {
  if (!url) return false
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  if (base && url.startsWith(base)) return true
  return /amazonaws\.com|\.s3[.-]|cloudfront\.net/i.test(url)
}

export const isExternalLinkType = (typeLegacyId?: number | null): boolean =>
  typeLegacyId != null && EXTERNAL_LINK_TYPE_IDS.has(typeLegacyId)

export const folderForAttachmentType = (typeLegacyId?: number | null, typeName?: string | null): string | null => {
  if (typeLegacyId != null && FOLDER_BY_TYPE_ID[typeLegacyId]) {
    return FOLDER_BY_TYPE_ID[typeLegacyId]
  }
  if (typeName) {
    for (const entry of FOLDER_BY_TYPE_NAME) {
      if (entry.match.test(typeName)) return entry.folder
    }
  }
  return null
}

/** Encode each path segment so spaces / unicode filenames fetch correctly. */
export const encodeUrlPath = (url: string): string => {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url)
    u.pathname = u.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg
        try {
          return encodeURIComponent(decodeURIComponent(seg))
        } catch {
          return encodeURIComponent(seg)
        }
      })
      .join('/')
    return u.toString()
  } catch {
    return url
  }
}

/** Filename to use when rebuilding a legacy path (prefer docName, else basename of relative url). */
export const mediaFilename = (url?: string | null, docName?: string | null): string | null => {
  const fromDoc = docName?.trim()
  if (fromDoc && !isAbsoluteMediaUrl(fromDoc)) {
    return fromDoc.replace(/^\/+/, '').split('/').pop() || fromDoc
  }
  if (url && isAbsoluteMediaUrl(url)) {
    try {
      const pathname = new URL(url.startsWith('//') ? `https:${url}` : url).pathname
      const base = pathname.split('/').pop() || ''
      return base ? decodeURIComponent(base) : null
    } catch {
      return null
    }
  }
  const raw = (url || '').trim()
  if (!raw) return null
  return raw.replace(/^\/+/, '').split('/').pop() || raw
}

export const buildLegacySourceUrl = (opts: {
  filename: string
  folder: string
  profileKey: string | number
  subpath?: string
}): string => {
  const file = encodeURIComponent(opts.filename.replace(/^\/+/, ''))
  const sub = opts.subpath ? `${opts.subpath.replace(/^\/+|\/+$/g, '')}/` : ''
  return `${mediaBase()}/storage/ecard/${opts.folder}/${opts.profileKey}/${sub}${file}`
}

const pushUnique = (list: string[], value: string) => {
  const encoded = encodeUrlPath(value)
  if (!list.includes(encoded)) list.push(encoded)
  if (!list.includes(value) && value !== encoded) list.push(value)
}

export type LegacyCandidateOptions = {
  /**
   * `fast` (default for migration): primary folder + a couple of known alternates only.
   * `exhaustive`: try every known ecard folder (slow; only for debugging missing files).
   */
  mode?: 'fast' | 'exhaustive'
}

/**
 * Candidate source URLs to try when downloading legacy media (primary + known alternates).
 * Always returns URL-encoded variants first so filenames with spaces work.
 */
export const legacySourceUrlCandidates = (input: LegacyMediaInput, options: LegacyCandidateOptions = {}): string[] => {
  const mode = options.mode || 'fast'
  const { url, docName, attachmentTypeLegacyId, attachmentTypeName, profileLegacyId, profileSlug } = input
  const candidates: string[] = []

  if (isExternalLinkType(attachmentTypeLegacyId)) {
    const external = (url && isAbsoluteMediaUrl(url) ? url : docName) || url
    if (external && isAbsoluteMediaUrl(external)) {
      pushUnique(candidates, external.startsWith('//') ? `https:${external}` : external)
    }
    return candidates
  }

  // Always include encoded form of whatever absolute URL we already have
  if (url && isAbsoluteMediaUrl(url)) {
    pushUnique(candidates, url.startsWith('//') ? `https:${url}` : url)
  }

  const filename = mediaFilename(url, docName)
  // Prefer numeric legacy id; only try slug in exhaustive mode (admin JS sometimes used slug)
  const profileKeys = (mode === 'exhaustive' ? [profileLegacyId, profileSlug] : [profileLegacyId]).filter(
    (k) => k != null && k !== ''
  ) as Array<string | number>

  if (!filename || profileKeys.length === 0) {
    return candidates
  }

  const primaryFolder = folderForAttachmentType(attachmentTypeLegacyId, attachmentTypeName)
  const folders: string[] = []
  if (primaryFolder) folders.push(primaryFolder)
  if (attachmentTypeLegacyId === 2 || primaryFolder === 'videos') {
    folders.push('backgroundVideos', 'videos')
  }
  if (attachmentTypeLegacyId === 9 || primaryFolder === 'backgroundVideos') {
    folders.push('backgroundVideos', 'videos')
  }
  if (primaryFolder === 'videoExplainers') {
    folders.push('videoExplainers', 'attachments')
  }
  if (mode === 'exhaustive') {
    for (const f of ALL_FOLDERS) {
      if (!folders.includes(f)) folders.push(f)
    }
  }

  for (const profileKey of profileKeys) {
    for (const folder of [...new Set(folders)]) {
      pushUnique(candidates, buildLegacySourceUrl({ filename, folder, profileKey }))
      if (folder === 'profileimages') {
        pushUnique(candidates, buildLegacySourceUrl({ filename, folder, profileKey, subpath: 'thumbnails' }))
      }
    }
  }

  return candidates
}

/**
 * Resolve a media value for API responses / DB storage.
 * Absolute URLs (S3, YouTube, full legacy) pass through; bare filenames become full legacy URLs.
 */
export const resolveMediaUrl = (input: LegacyMediaInput): string | null => {
  const { url, docName, attachmentTypeLegacyId } = input

  if (isExternalLinkType(attachmentTypeLegacyId)) {
    const external =
      (docName && isAbsoluteMediaUrl(docName) ? docName : null) ||
      (url && isAbsoluteMediaUrl(url) ? url : docName || url)
    if (!external) return null
    return external.startsWith('//') ? `https:${external}` : external
  }

  if (url && isAbsoluteMediaUrl(url)) {
    // Keep readable (possibly unencoded) URL in DB for display; fetchers should encode
    return url.startsWith('//') ? `https:${url}` : url
  }

  const candidates = legacySourceUrlCandidates(input)
  // Prefer a decoded-looking display URL for DB: rebuild without double-encoding in path display
  const filename = mediaFilename(url, docName)
  const folder = folderForAttachmentType(input.attachmentTypeLegacyId, input.attachmentTypeName)
  if (filename && input.profileLegacyId != null && folder) {
    return `${mediaBase()}/storage/ecard/${folder}/${input.profileLegacyId}/${filename}`
  }
  return candidates[0] || null
}

/**
 * Thin outbound guard: never return a bare filename to the frontend.
 * If absolute, return as-is; otherwise rebuild legacy URL when possible.
 */
export const ensureAbsoluteMediaUrl = (
  raw?: string | null,
  ctx?: Omit<LegacyMediaInput, 'url'> & { url?: string | null }
): string | null => {
  if (!raw && !ctx?.docName) return null
  if (raw && isAbsoluteMediaUrl(raw)) {
    // Encode for consumers that need a fetchable URL (next/image is fine with encoded or spaces)
    return encodeUrlPath(raw.startsWith('//') ? `https:${raw}` : raw)
  }
  const resolved = resolveMediaUrl({
    url: raw ?? ctx?.url,
    docName: ctx?.docName,
    attachmentTypeLegacyId: ctx?.attachmentTypeLegacyId,
    attachmentTypeName: ctx?.attachmentTypeName,
    profileLegacyId: ctx?.profileLegacyId,
    profileSlug: ctx?.profileSlug,
  })
  return resolved ? encodeUrlPath(resolved) : null
}
