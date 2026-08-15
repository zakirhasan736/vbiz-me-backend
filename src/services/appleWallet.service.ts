import { PKPass } from 'passkit-generator'
import config from '../configs/config'
import AppError from '../error/AppError'
import { publicReadableWhere, slugEquals } from '../utils/cardStatus'
import { prisma } from '../utils/prisma'
import { createSolidPng } from '../utils/solidPng'

/** Apple WWDR G4 intermediate — public CA cert, bundled so deploys do not need a certs folder. */
const APPLE_WWDR_G4_PEM = `-----BEGIN CERTIFICATE-----
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UE
Aww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMu
MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAf
eKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjo
v9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB
5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVl
PNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64D
YyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0
BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJv
b3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290
LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQD
AgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv
p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPef
x4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJ
EtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQ
A1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgp
pU8RBWk6z/Kf
-----END CERTIFICATE-----
`

type SignerMaterial = {
  cert: string
  key: string
  passphrase?: string
}

function unescapePem(value?: string): string {
  return (value || '').replace(/\\n/g, '\n').trim()
}

function loadWwdrPem(): string {
  const fromEnv = unescapePem(config.APPLE_WALLET.WWDR_CERT)
  if (fromEnv.includes('BEGIN CERTIFICATE')) return fromEnv
  return APPLE_WWDR_G4_PEM
}

function signerFromPem(): SignerMaterial | null {
  const cert = unescapePem(config.APPLE_WALLET.SIGNER_CERT)
  const key = unescapePem(config.APPLE_WALLET.SIGNER_KEY)
  if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('BEGIN')) return null
  return {
    cert,
    key,
    passphrase: config.APPLE_WALLET.SIGNER_KEY_PASSPHRASE,
  }
}

async function signerFromP12(): Promise<SignerMaterial | null> {
  const raw = config.APPLE_WALLET.P12_BASE64
  if (!raw) return null
  const passphrase = config.APPLE_WALLET.P12_PASSPHRASE || ''
  const forgeMod = await import('node-forge')
  const forge = forgeMod.default ?? forgeMod
  const der = forge.util.decode64(raw.replace(/\s+/g, ''))
  const p12Asn1 = forge.asn1.fromDer(der)
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase)
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert
  const shrouded = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
    ?.key
  const plain = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key
  const key = shrouded || plain
  if (!certBag || !key) {
    throw new AppError(500, 'APPLE_WALLET_P12_BASE64 did not contain a Pass Type ID certificate and key')
  }
  return {
    cert: forge.pki.certificateToPem(certBag),
    key: forge.pki.privateKeyToPem(key),
  }
}

export async function isAppleWalletConfigured(): Promise<boolean> {
  const id = config.APPLE_WALLET.PASS_TYPE_ID
  const team = config.APPLE_WALLET.TEAM_ID
  if (!id || !team) return false
  if (signerFromPem()) return true
  return Boolean(config.APPLE_WALLET.P12_BASE64)
}

function publicSiteBase(): string {
  return (config.FRONTEND_URL || config.SERVER_URL || 'https://app.vbizme.com').replace(/\/$/, '')
}

function publicCardUrl(slug: string): string {
  return `${publicSiteBase()}/v/${encodeURIComponent(slug)}`
}

function walletArtUrl(slug: string, format: 'card' | 'hero' | 'strip' = 'strip'): string {
  return `${publicSiteBase()}/v/${encodeURIComponent(slug)}/wallet-art?format=${format}&v=face2`
}

function hexToRgbCss(hex: string, fallback = 'rgb(11, 31, 58)'): string {
  const raw = hex.trim()
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (!match) return fallback
  let h = match[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = Number.parseInt(h, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

function hexLuminance(hex: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return 0
  let h = match[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function hexToRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return [238, 214, 119]
  let h = match[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const n = Number.parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function primaryFromTheme(themeConfig: unknown): string {
  if (!themeConfig || typeof themeConfig !== 'object') return '#EED677'
  const colors = (
    themeConfig as {
      colors?: {
        defaultMode?: string
        themeMode?: string
        dark?: { primary?: string; accent?: string }
        light?: { primary?: string; accent?: string }
      }
    }
  ).colors
  const mode = colors?.defaultMode === 'light' || colors?.themeMode === 'light' ? 'light' : 'dark'
  const set = mode === 'light' ? colors?.light : colors?.dark
  const other = mode === 'light' ? colors?.dark : colors?.light
  const candidates = [set?.primary, set?.accent, other?.primary, other?.accent]
  for (const value of candidates) {
    if (typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())) return value.trim()
  }
  return '#EED677'
}

async function fetchPng(url: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return undefined
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return undefined
    return buffer
  } catch {
    return undefined
  }
}

function pushField(
  fields: { push: (item: { key: string; label: string; value: string }) => unknown },
  key: string,
  label: string,
  value?: string | null
) {
  const trimmed = value?.trim()
  if (!trimmed) return
  fields.push({ key, label, value: trimmed })
}

export async function createAppleWalletPass(slug: string): Promise<{ buffer: Buffer; filename: string }> {
  const trimmed = slug.trim()
  if (!trimmed) throw new AppError(400, 'Missing card slug')

  const passTypeId = config.APPLE_WALLET.PASS_TYPE_ID
  const teamId = config.APPLE_WALLET.TEAM_ID
  if (!passTypeId || !teamId) {
    throw new AppError(
      503,
      'Apple Wallet is not configured. Add APPLE_WALLET_PASS_TYPE_ID and APPLE_WALLET_TEAM_ID from Apple Developer.'
    )
  }

  const signer = signerFromPem() || (await signerFromP12())
  if (!signer) {
    throw new AppError(
      503,
      'Apple Wallet certificates are missing. Add APPLE_WALLET_SIGNER_CERT + APPLE_WALLET_SIGNER_KEY, or APPLE_WALLET_P12_BASE64.'
    )
  }

  const profile = await prisma.profile.findFirst({
    where: { slug: slugEquals(trimmed), ...publicReadableWhere() },
  })
  if (!profile) throw new AppError(404, 'Card not found')

  const slugForPass = profile.slug?.trim() || trimmed
  const name = profile.name?.trim() || slugForPass
  const cardUrl = publicCardUrl(slugForPass)
  const primary = primaryFromTheme(profile.themeConfig)
  const darkBg = hexLuminance(primary) <= 0.55
  const brandRgb = hexToRgb(primary)
  const strip = (await fetchPng(walletArtUrl(slugForPass, 'strip'))) || createSolidPng(1125, 432, brandRgb)
  const icon = createSolidPng(58, 58, brandRgb)

  const pass = new PKPass(
    {
      'icon.png': icon,
      'icon@2x.png': icon,
      'strip.png': strip,
      'strip@2x.png': strip,
      'strip@3x.png': strip,
    },
    {
      wwdr: loadWwdrPem(),
      signerCert: signer.cert,
      signerKey: signer.key,
      signerKeyPassphrase: signer.passphrase,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: passTypeId,
      teamIdentifier: teamId,
      serialNumber: `card-face2-${profile.id}`.slice(0, 64),
      organizationName: config.APPLE_WALLET.ORGANIZATION,
      description: `${name} digital card`,
      logoText: '',
      foregroundColor: darkBg ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 17)',
      backgroundColor: hexToRgbCss(primary),
      labelColor: darkBg ? 'rgb(220, 220, 220)' : 'rgb(80, 80, 80)',
      sharingProhibited: false,
    }
  )

  pass.type = 'storeCard'
  pushField(pass.backFields, 'card', 'Open digital card', cardUrl)
  pushField(pass.backFields, 'phone', 'Phone', profile.phone)
  pushField(pass.backFields, 'email', 'Email', profile.email)

  const filename = `${slugForPass.replace(/[^a-zA-Z0-9._-]/g, '-') || 'vbiz-card'}.pkpass`
  return { buffer: pass.getAsBuffer(), filename }
}

const appleWalletService = {
  isConfigured: isAppleWalletConfigured,
  createPass: createAppleWalletPass,
}

export default appleWalletService
