import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import path from 'path'
import config from '../configs/config'
import AppError from '../error/AppError'
import { registerPending, s3MetadataFor, setMediaStatus, type MediaIdentity } from './mediaAsset'

let client: S3Client | null = null

const ensureConfigured = () => {
  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET, PUBLIC_BASE_URL } = config.S3
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET || !PUBLIC_BASE_URL) {
    throw new AppError(503, 'S3 is not configured')
  }
  if (!client) {
    client = new S3Client({
      region: REGION,
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    })
  }
  return client
}

export type S3UploadResult = {
  url: string
  publicId: string
  resourceType: string
  format?: string
  bytes?: number
}

const guessResourceType = (contentType?: string, format?: string): string => {
  if (contentType?.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(format || '')) return 'video'
  if (contentType?.startsWith('audio/') || ['mp3', 'wav', 'ogg'].includes(format || '')) return 'audio'
  if (contentType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(format || '')) {
    return 'image'
  }
  return 'raw'
}

const buildKey = (folder: string, filename?: string, format?: string) => {
  const prefix = folder.replace(/^\/+|\/+$/g, '')
  const ext = format ? `.${format.replace(/^\./, '')}` : path.extname(filename || '') || ''
  const base = filename
    ? path
        .basename(filename, path.extname(filename))
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .slice(0, 80)
    : randomUUID()
  return `${prefix}/${Date.now()}-${base}${ext || ''}`
}

const publicUrlForKey = (key: string) => {
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  return `${base}/${key}`
}

export type ObjectCheck = 'exists' | 'missing' | 'error'

/**
 * HEAD with a clear answer. 404 / NoSuchKey (and 403, which S3 returns for a missing
 * key when the caller has no ListBucket) mean missing. Throttling, 5xx and network
 * failures are 'error' — callers must NOT treat those as a missing file.
 */
const checkObject = async (key: string): Promise<ObjectCheck> => {
  const s3 = ensureConfigured()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: config.S3.BUCKET, Key: key }))
      return 'exists'
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }
      const code = e?.$metadata?.httpStatusCode
      if (code === 404 || code === 403 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return 'missing'
      // transient: retry once, then report as unknown
    }
  }
  return 'error'
}

const headObject = async (key: string): Promise<boolean> => (await checkObject(key)) === 'exists'

const uploadBuffer = async (
  buffer: Buffer,
  options?: {
    folder?: string
    /** Exact object key. When set, folder/filename timestamp naming is skipped. */
    key?: string
    contentType?: string
    filename?: string
    resourceType?: 'image' | 'video' | 'raw' | 'auto'
    /** Card / tab identity recorded in MediaAsset and S3 metadata. */
    identity?: MediaIdentity
  }
): Promise<S3UploadResult> => {
  const s3 = ensureConfigured()
  const folder = options?.folder || config.S3.KEY_PREFIX
  const format = options?.filename ? path.extname(options.filename).replace(/^\./, '') || undefined : undefined
  const key = options?.key?.replace(/^\/+/, '') || buildKey(folder, options?.filename, format)
  const contentType = options?.contentType || 'application/octet-stream'
  const identity: MediaIdentity = { source: 'upload', ...(options?.identity || {}) }

  await registerPending(key, identity, {
    originalName: options?.filename,
    contentType,
    bytes: buffer.length,
  })

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.S3.BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        Metadata: s3MetadataFor(identity),
        // BucketOwnerEnforced: no object ACL. Public GETs need the bucket policy
        // from scripts/make-s3-public.ts (s3:GetObject on `{prefix}/*`).
        CacheControl: 'public, max-age=31536000, immutable',
      })
    )
  } catch (error) {
    await setMediaStatus(key, 'missing', { reason: 'upload failed' })
    throw error
  }

  // Fail closed — never return a URL the bucket does not actually hold.
  // Browsers see AccessDenied XML for missing keys (no anonymous ListBucket).
  // A transient HEAD error is not proof of a failed upload — PutObject already succeeded.
  const exists = (await checkObject(key)) !== 'missing'
  if (!exists) {
    await setMediaStatus(key, 'missing', { reason: 'upload did not persist' })
    throw new AppError(502, `S3 upload did not persist (${key})`)
  }
  await setMediaStatus(key, 'ok')

  const resourceType =
    options?.resourceType && options.resourceType !== 'auto'
      ? options.resourceType
      : guessResourceType(contentType, format)

  return {
    url: publicUrlForKey(key),
    publicId: key,
    resourceType,
    format,
    bytes: buffer.length,
  }
}

const uploadFromUrl = async (
  remoteUrl: string,
  options?: { folder?: string; resourceType?: 'image' | 'video' | 'raw' | 'auto'; identity?: MediaIdentity }
): Promise<S3UploadResult> => {
  ensureConfigured()
  let fetchUrl: string
  try {
    const u = new URL(remoteUrl.startsWith('//') ? `https:${remoteUrl}` : remoteUrl)
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
    fetchUrl = u.toString()
  } catch {
    fetchUrl = remoteUrl
  }
  const response = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'vbizme-media-migrator/1.0',
      Accept: '*/*',
    },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new AppError(502, `Failed to download remote media (${response.status})`)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  if (contentType.includes('text/html')) {
    throw new AppError(502, `Failed to download remote media (got HTML instead of file)`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  let filename: string | undefined
  try {
    filename = decodeURIComponent(path.basename(new URL(fetchUrl).pathname)) || undefined
  } catch {
    filename = undefined
  }
  return uploadBuffer(buffer, {
    folder: options?.folder,
    contentType,
    filename,
    resourceType: options?.resourceType,
    identity: { source: 'url-import', ...(options?.identity || {}) },
  })
}

/** Server-side copy within the bucket — used when duplicating linked cards so each owns its file. */
const copyObject = async (
  sourceKey: string,
  options?: {
    folder?: string
    filename?: string
    contentType?: string
    resourceType?: 'image' | 'video' | 'raw' | 'auto'
    identity?: MediaIdentity
  }
): Promise<S3UploadResult> => {
  const s3 = ensureConfigured()
  const src = sourceKey.replace(/^\/+/, '').trim()
  if (!src) throw new AppError(400, 'S3 source key is required')

  const folder = options?.folder || config.S3.KEY_PREFIX
  const format = options?.filename ? path.extname(options.filename).replace(/^\./, '') || undefined : undefined
  const destKey = buildKey(folder, options?.filename, format)
  const copySource = `${config.S3.BUCKET}/${src
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`

  const identity: MediaIdentity = { source: 'duplicate', ...(options?.identity || {}) }
  let sourceContentType = options?.contentType
  if (!sourceContentType) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: config.S3.BUCKET, Key: src }))
      sourceContentType = head.ContentType
    } catch {
      /* copy below will fail with a clear error if the source is gone */
    }
  }
  await registerPending(destKey, identity, { originalName: options?.filename, contentType: sourceContentType })

  await s3.send(
    new CopyObjectCommand({
      Bucket: config.S3.BUCKET,
      CopySource: copySource,
      Key: destKey,
      // REPLACE so the copy carries the NEW card's identity metadata.
      MetadataDirective: 'REPLACE',
      ContentType: sourceContentType || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: s3MetadataFor(identity),
    })
  )
  if (!(await headObject(destKey))) {
    await setMediaStatus(destKey, 'missing', { reason: 'copy did not persist' })
    throw new AppError(502, `S3 copy did not persist (${destKey})`)
  }
  await setMediaStatus(destKey, 'ok')

  const resourceType =
    options?.resourceType && options.resourceType !== 'auto'
      ? options.resourceType
      : guessResourceType(sourceContentType, format)

  return {
    url: publicUrlForKey(destKey),
    publicId: destKey,
    resourceType,
    format,
  }
}

/** Bucket key for a public URL on our bucket (null for foreign / YouTube / legacy URLs). */
const keyFromPublicUrl = (url: string | null | undefined): string | null => {
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  const trimmed = (url || '').trim()
  if (!base || !trimmed.startsWith(`${base}/`)) return null
  const raw = trimmed.slice(base.length + 1).split(/[?#]/)[0]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export type RestoreVersionResult =
  | { status: 'alive' }
  | { status: 'restored'; versionId: string }
  | { status: 'unrecoverable'; reason: string }
  /** S3 could not be reached reliably — status unknown, nothing was changed. */
  | { status: 'check-failed'; reason: string }

/**
 * Self-heal a missing key from S3 versioning: copy the newest real (non delete-marker)
 * version back on top. Uses only Get/Put permissions — the app IAM user has no delete
 * rights, so we never remove delete markers, we just write a fresh current version.
 */
const restoreFromVersions = async (key: string): Promise<RestoreVersionResult> => {
  const s3 = ensureConfigured()
  const cleanKey = key.replace(/^\/+/, '').trim()
  if (!cleanKey) return { status: 'unrecoverable', reason: 'empty key' }
  const check = await checkObject(cleanKey)
  if (check === 'exists') return { status: 'alive' }
  if (check === 'error') return { status: 'check-failed', reason: 'S3 HEAD failed (throttled or unreachable)' }

  let listed
  try {
    listed = await s3.send(new ListObjectVersionsCommand({ Bucket: config.S3.BUCKET, Prefix: cleanKey, MaxKeys: 50 }))
  } catch (error) {
    const name = (error as { name?: string })?.name || 'error'
    return { status: 'unrecoverable', reason: `cannot list versions (${name})` }
  }
  const versions = (listed.Versions || [])
    .filter((v) => v.Key === cleanKey && v.VersionId)
    .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0))
  const target = versions[0]
  if (!target?.VersionId) {
    return { status: 'unrecoverable', reason: 'no stored versions (deleted before versioning was enabled)' }
  }

  const copySource = `${config.S3.BUCKET}/${cleanKey
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}?versionId=${encodeURIComponent(target.VersionId)}`
  await s3.send(
    new CopyObjectCommand({
      Bucket: config.S3.BUCKET,
      Key: cleanKey,
      CopySource: copySource,
      MetadataDirective: 'COPY',
    })
  )
  if (!(await headObject(cleanKey))) {
    return { status: 'unrecoverable', reason: 'copy from version did not persist' }
  }
  await setMediaStatus(cleanKey, 'ok', { recovered: true })
  return { status: 'restored', versionId: target.VersionId }
}

// NOTE: there is intentionally no `destroy` here. The API must never delete card media.
// Reclaiming unused files is done offline by scripts/s3-orphan-cleanup.ts with separate
// credentials. See docs/S3_MEDIA_SAFETY.md.
const s3Utils = {
  uploadBuffer,
  uploadFromUrl,
  copyObject,
  headObject,
  checkObject,
  restoreFromVersions,
  keyFromPublicUrl,
  ensureConfigured,
  publicUrlForKey,
}

export default s3Utils
