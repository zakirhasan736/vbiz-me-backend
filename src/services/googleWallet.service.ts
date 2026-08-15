import jwt from 'jsonwebtoken'
import config from '../configs/config'
import AppError from '../error/AppError'
import { publicReadableWhere, slugEquals } from '../utils/cardStatus'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'

type WalletServiceAccount = {
  email: string
  key: string
}

type Localized = {
  defaultValue: { language: string; value: string }
}

function localized(value: string, language = 'en'): Localized {
  return { defaultValue: { language, value } }
}

function sanitizeWalletSuffix(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return (cleaned || 'card').slice(0, 64)
}

function isHttpsImageUrl(url?: string | null): boolean {
  if (!url?.trim()) return false
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) || url.includes('/backgroundVideos/')) return false
  return /^https:\/\//i.test(url.trim())
}

function parseServiceAccount(): WalletServiceAccount | null {
  const rawJson = config.GOOGLE_WALLET.SA_JSON?.trim()
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as { client_email?: string; private_key?: string }
      const email = parsed.client_email?.trim()
      const key = parsed.private_key?.replace(/\\n/g, '\n').trim()
      if (email && key) return { email, key }
    } catch {
      throw new AppError(500, 'GOOGLE_WALLET_SA_JSON is not valid JSON')
    }
  }

  const email = config.GOOGLE_WALLET.SA_EMAIL
  const key = config.GOOGLE_WALLET.SA_PRIVATE_KEY?.replace(/\\n/g, '\n').trim()
  if (email && key) return { email, key }
  return null
}

export function isGoogleWalletConfigured(): boolean {
  return Boolean(config.GOOGLE_WALLET.ISSUER_ID && parseServiceAccount())
}

function publicSiteBase(): string {
  return (config.FRONTEND_URL || config.SERVER_URL || 'https://app.vbizme.com').replace(/\/$/, '')
}

function walletArtUrl(slug: string, format: 'card' | 'hero' | 'strip' | 'wide' = 'hero'): string | undefined {
  const base = publicSiteBase()
  if (!/^https:\/\//i.test(base)) return undefined
  return `${base}/v/${encodeURIComponent(slug)}/wallet-art?format=${format}&v=3`
}

function stillImageUrl(candidates: Array<string | null | undefined>, legacyId?: number | null): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) continue
    const absolute =
      ensureAbsoluteMediaUrl(raw.trim(), { docName: raw.trim(), profileLegacyId: legacyId }) || raw.trim()
    if (isHttpsImageUrl(absolute)) return absolute
  }
  if (isHttpsImageUrl(config.GOOGLE_WALLET.LOGO_URL)) return config.GOOGLE_WALLET.LOGO_URL
  return undefined
}

function buildGenericClass(classId: string) {
  return { id: classId }
}

function buildGenericObject(input: {
  objectId: string
  classId: string
  name: string
  title: string
  cardUrl: string
  logoUrl?: string
  wideLogoUrl?: string
  heroUrl?: string
}) {
  return {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    hexBackgroundColor: '#000000',
    cardTitle: localized(input.name || 'Digital Card'),
    header: localized(input.title || 'Digital Card'),
    logo: input.logoUrl
      ? {
          sourceUri: { uri: input.logoUrl },
          contentDescription: localized(input.name || 'Card'),
        }
      : undefined,
    wideLogo: input.wideLogoUrl
      ? {
          sourceUri: { uri: input.wideLogoUrl },
          contentDescription: localized(input.name || 'Card'),
        }
      : undefined,
    heroImage: input.heroUrl
      ? {
          sourceUri: { uri: input.heroUrl },
          contentDescription: localized(input.name || 'Digital card'),
        }
      : undefined,
    barcode: {
      type: 'QR_CODE',
      value: input.cardUrl,
      alternateText: 'Scan to Connect',
    },
  }
}

export async function createGoogleWalletSaveUrl(slug: string): Promise<{ wallet_url: string }> {
  const trimmed = slug.trim()
  if (!trimmed) throw new AppError(400, 'Missing card slug')

  const issuerId = config.GOOGLE_WALLET.ISSUER_ID
  const account = parseServiceAccount()
  if (!issuerId || !account) {
    throw new AppError(503, 'Google Wallet is not configured on the server')
  }

  const profile = await prisma.profile.findFirst({
    where: { slug: slugEquals(trimmed), ...publicReadableWhere() },
    include: {
      settings: true,
    },
  })
  if (!profile) throw new AppError(404, 'Card not found')

  const settings = Object.fromEntries(profile.settings.map((row) => [row.key, row.value ?? '']))
  const logoUrl = stillImageUrl(
    [settings.company_icon_url, settings.profile_media_url, profile.avatar, config.GOOGLE_WALLET.LOGO_URL],
    profile.legacyId
  )

  const slugForPass = profile.slug?.trim() || trimmed
  const classSuffix = sanitizeWalletSuffix(`${config.GOOGLE_WALLET.CLASS_SUFFIX || 'vbiz-card'}-credit`)
  const objectSuffix = sanitizeWalletSuffix(`credit-${slugForPass || profile.id}`)
  const classId = `${issuerId}.${classSuffix}`
  const objectId = `${issuerId}.${objectSuffix}`
  const title = [profile.designation, profile.companyName].filter(Boolean).join(' | ')
  const cardUrl = `${publicSiteBase()}/v/${encodeURIComponent(slugForPass)}`

  const claims = {
    iss: account.email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: config.ALLOWED_CORS_ORIGINS,
    payload: {
      genericClasses: [buildGenericClass(classId)],
      genericObjects: [
        buildGenericObject({
          objectId,
          classId,
          name: profile.name?.trim() || slugForPass,
          title,
          cardUrl,
          logoUrl,
          wideLogoUrl: walletArtUrl(slugForPass, 'wide'),
          heroUrl: walletArtUrl(slugForPass, 'hero'),
        }),
      ],
    },
  }

  const token = jwt.sign(claims, account.key, { algorithm: 'RS256' })
  return { wallet_url: `https://pay.google.com/gp/v/save/${token}` }
}

const googleWalletService = {
  isConfigured: isGoogleWalletConfigured,
  createSaveUrl: createGoogleWalletSaveUrl,
}

export default googleWalletService
