import jwt from 'jsonwebtoken'
import config from '../configs/config'
import { buildFrontendPublicCardWalletArtUrl } from '../constants/frontendPublicCardPath'
import AppError from '../error/AppError'
import { publicReadableWhere, slugEquals } from '../utils/cardStatus'
import { prisma } from '../utils/prisma'

type WalletServiceAccount = {
  email: string
  key: string
}

type Localized = {
  defaultValue: { language: string; value: string }
}

function localized(value: string, language = 'en'): Localized {
  const text = value.trim()
  return { defaultValue: { language, value: text || 'vBiz' } }
}

function sanitizeWalletSuffix(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return (cleaned || 'card').slice(0, 64)
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

function walletArtUrl(slug: string, format: 'card' | 'hero' | 'strip' | 'logo' | 'icon' = 'hero'): string | undefined {
  const base = publicSiteBase()
  if (!/^https:\/\//i.test(base)) return undefined
  return buildFrontendPublicCardWalletArtUrl(base, slug, format)
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

function firstHex(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed && HEX_RE.test(trimmed)) return trimmed
  }
  return undefined
}

function expandHex(hex: string): string {
  let h = hex.replace('#', '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return `#${h}`
}

function hexLuminance(hex: string): number {
  const h = expandHex(hex).slice(1)
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function faceBackgroundFromTheme(themeConfig: unknown): string {
  if (!themeConfig || typeof themeConfig !== 'object') return '#0A0A0A'
  const colors = (
    themeConfig as {
      colors?: {
        defaultMode?: string
        themeMode?: string
        dark?: { primary?: string; accent?: string; background?: string }
        light?: { primary?: string; accent?: string; background?: string }
      }
    }
  ).colors
  const mode = colors?.defaultMode === 'light' || colors?.themeMode === 'light' ? 'light' : 'dark'
  const set = mode === 'light' ? colors?.light : colors?.dark
  const brand = firstHex(set?.primary, set?.accent)
  const page = firstHex(set?.background)
  if (page && hexLuminance(page) <= 0.48) return page
  if (brand && hexLuminance(brand) <= 0.48) return brand
  return '#0A0A0A'
}

function buildGenericClass(classId: string) {
  return { id: classId }
}

const ISSUER_NAME = 'vBiz Me LLC'

function buildGenericObject(input: {
  objectId: string
  classId: string
  name: string
  background: string
  heroUrl?: string
  logoUrl?: string
  cardUrl?: string
}) {
  return {
    id: input.objectId,
    classId: input.classId,
    state: 'ACTIVE',
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    hexBackgroundColor: input.background,
    cardTitle: localized(ISSUER_NAME),
    header: localized(input.name || ISSUER_NAME),
    logo: input.logoUrl
      ? {
          sourceUri: { uri: input.logoUrl },
          contentDescription: localized(input.name || ISSUER_NAME),
        }
      : undefined,
    heroImage: input.heroUrl
      ? {
          sourceUri: { uri: input.heroUrl },
          contentDescription: localized(input.name || ISSUER_NAME),
        }
      : undefined,
    imageModulesData: input.cardUrl
      ? [
          {
            mainImage: {
              sourceUri: { uri: input.cardUrl },
              contentDescription: localized(input.name || ISSUER_NAME),
            },
          },
        ]
      : undefined,
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
  })
  if (!profile) throw new AppError(404, 'Card not found')

  const slugForPass = profile.slug?.trim() || trimmed
  const classSuffix = sanitizeWalletSuffix(`${config.GOOGLE_WALLET.CLASS_SUFFIX || 'vbiz-card'}-face4`)
  const objectSuffix = sanitizeWalletSuffix(`face4-${slugForPass || profile.id}`)
  const classId = `${issuerId}.${classSuffix}`
  const objectId = `${issuerId}.${objectSuffix}`

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
          background: faceBackgroundFromTheme(profile.themeConfig),
          heroUrl: walletArtUrl(slugForPass, 'hero'),
          logoUrl: walletArtUrl(slugForPass, 'logo'),
          cardUrl: walletArtUrl(slugForPass, 'card'),
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
