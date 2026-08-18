import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import path from 'path'
import config from '../configs/config'
import AppError from '../error/AppError'

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

const uploadBuffer = async (
  buffer: Buffer,
  options?: {
    folder?: string
    /** Exact object key. When set, folder/filename timestamp naming is skipped. */
    key?: string
    contentType?: string
    filename?: string
    resourceType?: 'image' | 'video' | 'raw' | 'auto'
  }
): Promise<S3UploadResult> => {
  const s3 = ensureConfigured()
  const folder = options?.folder || config.S3.KEY_PREFIX
  const format = options?.filename ? path.extname(options.filename).replace(/^\./, '') || undefined : undefined
  const key = options?.key?.replace(/^\/+/, '') || buildKey(folder, options?.filename, format)
  const contentType = options?.contentType || 'application/octet-stream'

  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3.BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Public-read if bucket policy allows; CDN/base URL still used for serving
      ACL: undefined,
    })
  )

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
  options?: { folder?: string; resourceType?: 'image' | 'video' | 'raw' | 'auto' }
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
  })
}

const headObject = async (key: string): Promise<boolean> => {
  const s3 = ensureConfigured()
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: config.S3.BUCKET,
        Key: key,
      })
    )
    return true
  } catch {
    return false
  }
}

const destroy = async (key: string) => {
  const s3 = ensureConfigured()
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.S3.BUCKET,
      Key: key,
    })
  )
}

const s3Utils = {
  uploadBuffer,
  uploadFromUrl,
  headObject,
  destroy,
  ensureConfigured,
  publicUrlForKey,
}

export default s3Utils
