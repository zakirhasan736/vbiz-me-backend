/** Professional per-file cap for image, video, and document uploads. */
export const MEDIA_UPLOAD_PROFESSIONAL_MAX_MB = 50
export const MEDIA_UPLOAD_PROFESSIONAL_MAX_BYTES = MEDIA_UPLOAD_PROFESSIONAL_MAX_MB * 1024 * 1024

/**
 * Multipart / reverse-proxy ceiling for unlimited packages (corporate, concierge).
 * Package rules never sum files on a card — each upload is checked on its own.
 */
export const MEDIA_UPLOAD_TRANSPORT_MAX_MB = 512
export const MEDIA_UPLOAD_TRANSPORT_MAX_BYTES = MEDIA_UPLOAD_TRANSPORT_MAX_MB * 1024 * 1024

/** Multer limit: must accept the largest allowed per-file upload. */
export const MEDIA_UPLOAD_MAX_MB = MEDIA_UPLOAD_TRANSPORT_MAX_MB
export const MEDIA_UPLOAD_MAX_BYTES = MEDIA_UPLOAD_TRANSPORT_MAX_BYTES

export const MEDIA_UPLOAD_TOO_LARGE_MESSAGE = `File size exceeds ${MEDIA_UPLOAD_PROFESSIONAL_MAX_MB}MB`

export const MEDIA_ATTACHMENT_POLICIES = {
  'Profile Image/Video': {
    label: 'Avatar media',
    allowedLabel: 'image or video',
    allowedKinds: ['image', 'video'] as const,
  },
  'Background Video/Image': {
    label: 'Background media',
    allowedLabel: 'image or video',
    allowedKinds: ['image', 'video'] as const,
  },
  'Intro vCard Video': {
    label: 'Intro video',
    allowedLabel: 'video',
    allowedKinds: ['video'] as const,
  },
} as const

export type MediaAttachmentPolicy = (typeof MEDIA_ATTACHMENT_POLICIES)[keyof typeof MEDIA_ATTACHMENT_POLICIES]

export const mediaAttachmentTypeMessage = (policy: MediaAttachmentPolicy) =>
  `${policy.label} supports ${policy.allowedLabel} files only.`
