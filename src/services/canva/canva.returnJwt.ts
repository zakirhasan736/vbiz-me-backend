import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { getCanvaConfig } from './canva.config'

const CANVA_JWKS_URL = 'https://api.canva.com/rest/v1/connect/keys'

export type CanvaCorrelationClaims = {
  sub: string
  team_id: string
  type: 'rti'
  design_id: string
  correlation_state: string
  jti: string
  aud: string | string[]
  exp: number
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(CANVA_JWKS_URL))
  }
  return jwks
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Verify Canva Return Navigation correlation_jwt against published JWKS. */
export async function verifyCanvaCorrelationJwt(token: string): Promise<CanvaCorrelationClaims> {
  const { clientId } = getCanvaConfig()
  const { payload } = await jwtVerify(token, getJwks(), {
    audience: clientId,
  })

  return assertCorrelationClaims(payload)
}

export function assertCorrelationClaims(payload: JWTPayload): CanvaCorrelationClaims {
  const type = asString(payload.type)
  const sub = asString(payload.sub)
  const teamId = asString(payload.team_id)
  const designId = asString(payload.design_id)
  const correlationState = asString(payload.correlation_state)
  const jti = asString(payload.jti)

  if (type !== 'rti') throw new Error('Invalid correlation JWT type')
  if (!sub) throw new Error('Invalid correlation JWT subject')
  if (!teamId) throw new Error('Invalid correlation JWT team_id')
  if (!designId) throw new Error('Invalid correlation JWT design_id')
  if (!correlationState) throw new Error('Invalid correlation JWT correlation_state')
  if (!jti) throw new Error('Invalid correlation JWT jti')
  if (typeof payload.exp !== 'number') throw new Error('Invalid correlation JWT expiry')

  return {
    sub,
    team_id: teamId,
    type: 'rti',
    design_id: designId,
    correlation_state: correlationState,
    jti,
    aud: payload.aud as string | string[],
    exp: payload.exp,
  }
}
