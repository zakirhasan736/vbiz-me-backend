/** Max multipart upload size for POST /api/v1/media/upload (must match reverse-proxy body limit). */
export const MEDIA_UPLOAD_MAX_MB = 50
export const MEDIA_UPLOAD_MAX_BYTES = MEDIA_UPLOAD_MAX_MB * 1024 * 1024

export const MEDIA_UPLOAD_TOO_LARGE_MESSAGE = `File size exceeds ${MEDIA_UPLOAD_MAX_MB}MB`
