/** Builder media uploads are not size-capped in application code. */
export const MEDIA_UPLOAD_TOO_LARGE_MESSAGE =
  'Upload was rejected. The file may be too large for the server or network proxy.'

export const MEDIA_UPLOAD_INTERRUPTED_MESSAGE =
  'Upload was interrupted before the file finished sending. Please try again.'

export function isMultipartTruncatedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /unexpected end of form|unexpected end of request|multipart.*truncated|premature close/i.test(message)
}

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
  '2D Video Explainer': {
    label: '2D explainer video',
    allowedLabel: 'video',
    allowedKinds: ['video'] as const,
  },
} as const

export type MediaAttachmentPolicy = (typeof MEDIA_ATTACHMENT_POLICIES)[keyof typeof MEDIA_ATTACHMENT_POLICIES]

export const mediaAttachmentTypeMessage = (policy: MediaAttachmentPolicy) =>
  `${policy.label} supports ${policy.allowedLabel} files only.`
