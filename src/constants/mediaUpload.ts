/** Max multipart upload size for POST /api/v1/media/upload (must match reverse-proxy body limit). */
export const MEDIA_UPLOAD_MAX_MB = 50
export const MEDIA_UPLOAD_MAX_BYTES = MEDIA_UPLOAD_MAX_MB * 1024 * 1024

export const MEDIA_UPLOAD_TOO_LARGE_MESSAGE = `File size exceeds ${MEDIA_UPLOAD_MAX_MB}MB`

export const MEDIA_ATTACHMENT_POLICIES = {
  'Profile Image/Video': {
    label: 'Avatar media',
    maxBytes: 15 * 1024 * 1024,
    maxMb: 15,
    allowedLabel: 'image or video',
    allowedKinds: ['image', 'video'] as const,
  },
  'Background Video/Image': {
    label: 'Background media',
    maxBytes: 15 * 1024 * 1024,
    maxMb: 15,
    allowedLabel: 'image or video',
    allowedKinds: ['image', 'video'] as const,
  },
  'Intro vCard Video': {
    label: 'Intro video',
    maxBytes: 30 * 1024 * 1024,
    maxMb: 30,
    allowedLabel: 'video',
    allowedKinds: ['video'] as const,
  },
} as const

export type MediaAttachmentPolicy = (typeof MEDIA_ATTACHMENT_POLICIES)[keyof typeof MEDIA_ATTACHMENT_POLICIES]

export const mediaAttachmentTooLargeMessage = (policy: MediaAttachmentPolicy) =>
  `${policy.label} must be ${policy.maxMb}MB or smaller.`

export const mediaAttachmentTypeMessage = (policy: MediaAttachmentPolicy) =>
  `${policy.label} supports ${policy.allowedLabel} files only.`
