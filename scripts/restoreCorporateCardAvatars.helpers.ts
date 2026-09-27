export function normalizeAvatarUrl(url?: string | null): string {
  return (url || '').trim().split(/[?#]/)[0]
}

export function mostCommonSharedUrl(urls: Array<string | null | undefined>): string | null {
  const counts = new Map<string, { count: number; raw: string }>()
  for (const url of urls) {
    const raw = (url || '').trim()
    const key = normalizeAvatarUrl(raw)
    if (!key) continue
    const prev = counts.get(key)
    counts.set(key, { count: (prev?.count || 0) + 1, raw: prev?.raw || raw })
  }
  let best: { count: number; raw: string } | null = null
  for (const row of counts.values()) {
    if (!best || row.count > best.count) best = row
  }
  return best && best.count >= 2 ? best.raw : null
}

export function extractProfileImageFromDisplaySettings(raw?: string | null): string {
  if (!raw?.trim()) return ''
  try {
    const parsed = JSON.parse(raw) as { fields?: Record<string, { customValue?: unknown }> }
    const value = parsed?.fields?.['Profile Image/Video']?.customValue
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

export function patchDisplaySettingsProfileImage(raw: string | null | undefined, nextUrl: string): string | null {
  if (!raw?.trim()) {
    return JSON.stringify({
      fields: {
        'Profile Image/Video': { customValue: nextUrl },
      },
    })
  }
  try {
    const parsed = JSON.parse(raw) as { fields?: Record<string, Record<string, unknown>> }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    const fields =
      parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields) ? parsed.fields : {}
    fields['Profile Image/Video'] = {
      ...(fields['Profile Image/Video'] || {}),
      customValue: nextUrl,
    }
    parsed.fields = fields
    return JSON.stringify(parsed)
  } catch {
    return raw
  }
}

export function extractAvatarUrlsFromSnapshot(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
  const row = snapshot as Record<string, unknown>
  const urls: string[] = []
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) urls.push(value.trim())
  }

  const settings = row.settings
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const map = settings as Record<string, unknown>
    for (const key of ['profile_media_url', 'avatar', 'avatar_url', 'profile_image', 'profile_image_url']) {
      push(map[key])
    }
    if (typeof map.display_settings_json === 'string') {
      push(extractProfileImageFromDisplaySettings(map.display_settings_json))
    }
  }

  const profileFields = row.profileFields
  if (profileFields && typeof profileFields === 'object' && !Array.isArray(profileFields)) {
    push((profileFields as Record<string, unknown>).avatar)
  }

  return urls
}

export function pickRestoreAvatarUrl(input: {
  currentUrl: string
  sharedOverwriteUrl: string | null
  attachmentUrls: string[]
  historyUrls: string[]
}): { url: string; source: 'keep' | 'attachment' | 'history' | 'none' } {
  const current = normalizeAvatarUrl(input.currentUrl)
  const shared = normalizeAvatarUrl(input.sharedOverwriteUrl)
  const uniqueAttachment = input.attachmentUrls.find((url) => {
    const key = normalizeAvatarUrl(url)
    return key && (!shared || key !== shared)
  })
  if (uniqueAttachment) {
    return { url: uniqueAttachment.trim(), source: 'attachment' }
  }

  const uniqueHistory = input.historyUrls.find((url) => {
    const key = normalizeAvatarUrl(url)
    return key && (!shared || key !== shared)
  })
  if (uniqueHistory) {
    return { url: uniqueHistory.trim(), source: 'history' }
  }

  if (current) return { url: input.currentUrl.trim(), source: 'keep' }
  return { url: '', source: 'none' }
}
