import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { getCanvaConfig } from './canva.config'

export type PlainCanvaTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope?: string
}

function encryptionKey() {
  return createHash('sha256').update(getCanvaConfig().tokenEncryptionKey).digest()
}

export function encryptSecret(plain: string): { enc: string; iv: string; tag: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptSecret(enc: string, iv: string, tag: string): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8')
}

/** Pack access+refresh into one ciphertext payload; iv/tag shared for the row. */
export function encryptTokenPair(tokens: PlainCanvaTokens): {
  accessTokenEnc: string
  refreshTokenEnc: string
  tokenIv: string
  tokenTag: string
} {
  const payload = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  })
  const { enc, iv, tag } = encryptSecret(payload)
  return {
    accessTokenEnc: enc,
    refreshTokenEnc: '', // pair stored in accessTokenEnc JSON for simpler key rotation
    tokenIv: iv,
    tokenTag: tag,
  }
}

export function decryptTokenPair(row: {
  accessTokenEnc: string
  refreshTokenEnc: string
  tokenIv: string
  tokenTag: string
}): { accessToken: string; refreshToken: string } {
  // Prefer packed JSON in accessTokenEnc; fall back to separate fields for safety.
  try {
    const decoded = decryptSecret(row.accessTokenEnc, row.tokenIv, row.tokenTag)
    const parsed = JSON.parse(decoded) as { accessToken?: string; refreshToken?: string }
    if (parsed.accessToken && parsed.refreshToken) {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
    }
  } catch {
    // fall through
  }

  return {
    accessToken: decryptSecret(row.accessTokenEnc, row.tokenIv, row.tokenTag),
    refreshToken: decryptSecret(row.refreshTokenEnc, row.tokenIv, row.tokenTag),
  }
}
