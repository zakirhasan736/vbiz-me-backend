import config from '../../configs/config'

const DEFAULT_SCOPES = [
  'asset:read',
  'asset:write',
  'design:meta:read',
  'design:content:read',
  'design:content:write',
  'folder:read',
  'folder:write',
  'profile:read',
]

export function isCanvaConfigured(): boolean {
  return Boolean(config.CANVA_CLIENT_ID && config.CANVA_CLIENT_SECRET && config.CANVA_TOKEN_ENCRYPTION_KEY)
}

export function getCanvaConfig() {
  if (!isCanvaConfigured()) {
    throw new Error('Canva is not configured')
  }

  const serverUrl = (config.SERVER_URL || 'http://localhost:5000').replace(/\/$/, '')
  const redirectUri = config.CANVA_REDIRECT_URI?.trim() || `${serverUrl}/api/v1/integrations/canva/callback`

  return {
    clientId: config.CANVA_CLIENT_ID as string,
    clientSecret: config.CANVA_CLIENT_SECRET as string,
    redirectUri,
    scopes: config.CANVA_SCOPES?.trim() || DEFAULT_SCOPES.join(' '),
    authBaseUrl: 'https://www.canva.com/api/oauth/authorize',
    apiBaseUrl: 'https://api.canva.com/rest/v1',
    tokenEncryptionKey: config.CANVA_TOKEN_ENCRYPTION_KEY as string,
    frontendUrl: (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
  }
}
