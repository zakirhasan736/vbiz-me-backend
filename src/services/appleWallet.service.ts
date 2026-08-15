import { PKPass } from 'passkit-generator'
import config from '../configs/config'
import AppError from '../error/AppError'
import { publicReadableWhere, slugEquals } from '../utils/cardStatus'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
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
  const title = profile.designation?.trim() || profile.companyName?.trim() || ''
  const cardUrl = publicCardUrl(slugForPass)
  const avatarUrl = profile.avatar
    ? ensureAbsoluteMediaUrl(profile.avatar.trim(), {
        docName: profile.avatar.trim(),
        profileLegacyId: profile.legacyId,
      })
    : undefined
  const photo = (avatarUrl && (await fetchPng(avatarUrl))) || createSolidPng(180, 180, [28, 28, 30])
  const icon = createSolidPng(58, 58, [28, 28, 30])
  const logo = createSolidPng(160, 50, [28, 28, 30])

  const pass = new PKPass(
    {
      'icon.png': icon,
      'icon@2x.png': icon,
      'logo.png': logo,
      'logo@2x.png': logo,
      'thumbnail.png': photo,
      'thumbnail@2x.png': photo,
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
      serialNumber: `card-basic-${profile.id}`.slice(0, 64),
      organizationName: config.APPLE_WALLET.ORGANIZATION,
      description: `${name} digital card`,
      logoText: name,
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: 'rgb(28, 28, 30)',
      labelColor: 'rgb(174, 174, 178)',
      sharingProhibited: false,
    }
  )

  pass.type = 'generic'
  pass.primaryFields.push({ key: 'name', label: 'NAME', value: name })
  pushField(pass.secondaryFields, 'title', 'TITLE', title)
  pushField(pass.backFields, 'card', 'Open digital card', cardUrl)
  pushField(pass.backFields, 'phone', 'Phone', profile.phone)
  pushField(pass.backFields, 'email', 'Email', profile.email)
  pass.setBarcodes({
    message: cardUrl,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: name,
  })

  const filename = `${slugForPass.replace(/[^a-zA-Z0-9._-]/g, '-') || 'vbiz-card'}.pkpass`
  return { buffer: pass.getAsBuffer(), filename }
}

const appleWalletService = {
  isConfigured: isAppleWalletConfigured,
  createPass: createAppleWalletPass,
}

export default appleWalletService
