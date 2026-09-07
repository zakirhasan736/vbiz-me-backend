import dotenvFlow from 'dotenv-flow'

dotenvFlow.config()

const {
  NODE_ENV,
  PORT,
  SERVER_URL,
  DATABASE_URL,
  REFRESH_TOKEN_SECRET,
  ACCESS_TOKEN_SECRET,
  FRONTEND_URL,
  CORS_ORIGINS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_FONTS_API_KEY,
  GOOGLE_CALENDAR_CLIENT_ID,
  GOOGLE_CALENDAR_CLIENT_SECRET,
  GOOGLE_CALENDAR_REDIRECT_URI,
  GOOGLE_CALENDAR_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID,
  GOOGLE_CALENDAR_TIMEZONE,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_CALENDAR_UID,
  ZOHO_CALENDAR_TIMEZONE,
  ZOHO_ACCOUNTS_DOMAIN,
  ZOHO_API_DOMAIN,
  CALENDAR_PROVIDER,
  CRM_REMINDER_CRON_ENABLED,
  CRM_REMINDER_CRON_TZ,
  CRM_REMINDER_CRON_EXPR,
  CRM_REMINDER_LEAD_MINUTES,
  FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  AI_ASSISTANCE_ADDON_PRICE_CENTS,
  ZOHO_SMTP_HOST,
  ZOHO_SMTP_PORT,
  ZOHO_SMTP_SECURE,
  ZOHO_EMAIL_USER,
  ZOHO_EMAIL_PASSWORD,
  RESEND_MAIL_MINUTES,
  OTP_EXPIRE_MINUTES,
  FORGOT_PASSWORD_EXPIRY_MINUTES,
  PASSWORD_SETUP_EXPIRY_MINUTES,
  PUBLIC_SIGNUP_ENABLED,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  AWS_BUCKET,
  S3_BUCKET,
  S3_KEY_PREFIX,
  S3_PUBLIC_BASE_URL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  PUBLIC_RATE_LIMIT_MAX,
  PUBLIC_INTERNAL_RATE_LIMIT_MAX,
  INTERNAL_PUBLIC_API_KEY,
  TURNSTILE_ENABLED,
  TURNSTILE_SECRET_KEY,
  TURNSTILE_EXPECTED_HOSTNAME,
  LARAVEL_MYSQL_URL,
  MEDIA_BASE_URL,
  CANVA_CLIENT_ID,
  CANVA_CLIENT_SECRET,
  CANVA_REDIRECT_URI,
  CANVA_TOKEN_ENCRYPTION_KEY,
  CANVA_SCOPES,
  BIRTHDAY_CRON_ENABLED,
  BIRTHDAY_CRON_TZ,
  BIRTHDAY_CRON_EXPR,
  GOOGLE_WALLET_ISSUER_ID,
  GOOGLE_WALLET_SA_JSON,
  GOOGLE_WALLET_SA_EMAIL,
  GOOGLE_WALLET_SA_PRIVATE_KEY,
  GOOGLE_WALLET_CLASS_SUFFIX,
  GOOGLE_WALLET_LOGO_URL,
  GEMINI_API_KEY,
  GEMINI_LIVE_MODEL,
  OPENAI_TAB_FILL_MODEL,
  APPLE_WALLET_PASS_TYPE_ID,
  APPLE_WALLET_TEAM_ID,
  APPLE_WALLET_ORGANIZATION,
  APPLE_WALLET_SIGNER_CERT,
  APPLE_WALLET_SIGNER_KEY,
  APPLE_WALLET_SIGNER_KEY_PASSPHRASE,
  APPLE_WALLET_P12_BASE64,
  APPLE_WALLET_P12_PASSPHRASE,
  APPLE_WALLET_WWDR_CERT,
} = process.env

const parseCommaSeparatedList = (value?: string): string[] =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? []

const frontendUrl = NODE_ENV === 'production' ? FRONTEND_URL : FRONTEND_URL || 'http://localhost:3000'
const corsOrigins = parseCommaSeparatedList(CORS_ORIGINS)
const turnstileEnabled = (TURNSTILE_ENABLED || 'false').trim().toLowerCase() === 'true'
const allowedCorsOrigins = Array.from(
  new Set(
    [
      frontendUrl,
      ...corsOrigins,
      'https://app.nextcreavo.com',
      'https://app.vbizme.com',
      'https://www.vbizme.com',
      'https://vbizme.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
    ]
      .filter((origin): origin is string => Boolean(origin))
      .map((origin) => origin.replace(/\/$/, ''))
  )
)

export default {
  NODE_ENV: NODE_ENV || 'development',
  PORT: PORT || '5000',
  SERVER_URL: SERVER_URL || 'http://localhost:5000',
  DATABASE_URL,
  argon2: {
    type: 2 as const, // argon2id
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  },
  REFRESH_TOKEN: {
    SECRET: REFRESH_TOKEN_SECRET,
    EXPIRY: '24h',
  },
  ACCESS_TOKEN: {
    SECRET: ACCESS_TOKEN_SECRET,
    EXPIRY: '24h',
  },
  FRONTEND_URL: frontendUrl,
  CORS_ORIGINS: corsOrigins,
  ALLOWED_CORS_ORIGINS: allowedCorsOrigins,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_FONTS_API_KEY,
  GOOGLE_CALENDAR: {
    CLIENT_ID: (GOOGLE_CALENDAR_CLIENT_ID || '').trim() || undefined,
    CLIENT_SECRET: (GOOGLE_CALENDAR_CLIENT_SECRET || '').trim() || undefined,
    REDIRECT_URI: (GOOGLE_CALENDAR_REDIRECT_URI || '').trim() || undefined,
    REFRESH_TOKEN: (GOOGLE_CALENDAR_REFRESH_TOKEN || '').trim() || undefined,
    CALENDAR_ID: (GOOGLE_CALENDAR_ID || 'primary').trim(),
    TIMEZONE: (GOOGLE_CALENDAR_TIMEZONE || 'UTC').trim(),
  },
  ZOHO_CALENDAR: {
    CLIENT_ID: (ZOHO_CLIENT_ID || '').trim() || undefined,
    CLIENT_SECRET: (ZOHO_CLIENT_SECRET || '').trim() || undefined,
    REFRESH_TOKEN: (ZOHO_REFRESH_TOKEN || '').trim() || undefined,
    CALENDAR_UID: (ZOHO_CALENDAR_UID || '').trim() || undefined,
    TIMEZONE: (ZOHO_CALENDAR_TIMEZONE || GOOGLE_CALENDAR_TIMEZONE || 'UTC').trim(),
    ACCOUNTS_DOMAIN: (ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.com').trim(),
    API_DOMAIN: (ZOHO_API_DOMAIN || 'calendar.zoho.com').trim(),
  },
  CALENDAR: {
    PROVIDER: (CALENDAR_PROVIDER || 'auto').trim().toLowerCase(),
  },
  CRM_REMINDER_CRON: {
    ENABLED: (CRM_REMINDER_CRON_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    TZ: (CRM_REMINDER_CRON_TZ || 'Asia/Dhaka').trim() || 'Asia/Dhaka',
    EXPR: (CRM_REMINDER_CRON_EXPR || '*/5 * * * *').trim() || '*/5 * * * *',
    LEAD_MINUTES: Number(CRM_REMINDER_LEAD_MINUTES) || 30,
  },
  FACEBOOK_APP_ID,
  FACEBOOK_APP_SECRET,
  STRIPE: {
    SECRET_KEY: (STRIPE_SECRET_KEY || '').trim(),
    WEBHOOK_SECRET: (STRIPE_WEBHOOK_SECRET || '').trim(),
  },
  /** AI Assistance monthly add-on (USD cents). Default $10.00. */
  AI_ASSISTANCE_ADDON_PRICE_CENTS: Math.max(100, Number(AI_ASSISTANCE_ADDON_PRICE_CENTS) || 1000),
  ZOHO_EMAIL_USER: (ZOHO_EMAIL_USER || '').trim() || undefined,
  ZOHO_EMAIL_PASSWORD: (ZOHO_EMAIL_PASSWORD || '').trim() || undefined,
  MAIL_SMTP: {
    HOST: (ZOHO_SMTP_HOST || 'smtp.zoho.com').trim() || 'smtp.zoho.com',
    PORT: Number(ZOHO_SMTP_PORT) || 587,
    SECURE: (ZOHO_SMTP_SECURE || 'false').trim().toLowerCase() === 'true',
  },
  RESEND_MAIL_MINUTES: Number(RESEND_MAIL_MINUTES),
  OTP_EXPIRE_MINUTES: Number(OTP_EXPIRE_MINUTES) || 10,
  /**
   * TEMP: force login email OTP off while transactional mail is broken.
   * Restore: `(LOGIN_OTP_REQUIRED || 'false').trim().toLowerCase() === 'true'`
   * and set LOGIN_OTP_REQUIRED=true in env.
   */
  LOGIN_OTP_REQUIRED: false,
  /**
   * TEMP: skip “verify email before login” while mail is broken.
   * Restore: `(EMAIL_VERIFICATION_REQUIRED || 'false').trim().toLowerCase() === 'true'`
   * and set EMAIL_VERIFICATION_REQUIRED=true in env.
   */
  EMAIL_VERIFICATION_REQUIRED: false,
  PUBLIC_SIGNUP_ENABLED: (PUBLIC_SIGNUP_ENABLED || 'false').trim().toLowerCase() === 'true',
  FORGOT_PASSWORD_EXPIRY_MINUTES: Number(FORGOT_PASSWORD_EXPIRY_MINUTES) || 15,
  PASSWORD_SETUP_EXPIRY_MINUTES: Number(PASSWORD_SETUP_EXPIRY_MINUTES) || 15,
  S3: {
    ACCESS_KEY_ID: AWS_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: AWS_SECRET_ACCESS_KEY,
    REGION: AWS_REGION || 'us-east-1',
    BUCKET: S3_BUCKET || AWS_BUCKET,
    KEY_PREFIX: S3_KEY_PREFIX || 'vbizme',
    PUBLIC_BASE_URL: S3_PUBLIC_BASE_URL,
  },
  VAPID: {
    PUBLIC_KEY: VAPID_PUBLIC_KEY,
    PRIVATE_KEY: VAPID_PRIVATE_KEY,
    SUBJECT: VAPID_SUBJECT || 'mailto:admin@vbizme.com',
  },
  INTERNAL_PUBLIC_API_KEY: (INTERNAL_PUBLIC_API_KEY || '').trim() || undefined,
  PUBLIC_RATE_LIMIT: {
    WINDOW_MS: Number(PUBLIC_RATE_LIMIT_WINDOW_MS) || 60_000,
    MAX: Number(PUBLIC_RATE_LIMIT_MAX) || 600,
    INTERNAL_MAX: Number(PUBLIC_INTERNAL_RATE_LIMIT_MAX) || 2400,
  },
  TURNSTILE: {
    ENABLED: turnstileEnabled,
    SECRET_KEY: TURNSTILE_SECRET_KEY?.trim() || undefined,
    EXPECTED_HOSTNAME: TURNSTILE_EXPECTED_HOSTNAME?.trim() || undefined,
  },
  LARAVEL_MYSQL_URL,
  MEDIA_BASE_URL: MEDIA_BASE_URL || 'https://app.vbizme.com',
  CANVA_CLIENT_ID,
  CANVA_CLIENT_SECRET,
  CANVA_REDIRECT_URI,
  CANVA_TOKEN_ENCRYPTION_KEY,
  CANVA_SCOPES,
  BIRTHDAY_CRON: {
    ENABLED: (BIRTHDAY_CRON_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    TZ: (BIRTHDAY_CRON_TZ || 'Asia/Dhaka').trim() || 'Asia/Dhaka',
    EXPR: (BIRTHDAY_CRON_EXPR || '0 9 * * *').trim() || '0 9 * * *',
  },
  GOOGLE_WALLET: {
    ISSUER_ID: (GOOGLE_WALLET_ISSUER_ID || '').trim(),
    SA_JSON: (GOOGLE_WALLET_SA_JSON || '').trim() || undefined,
    SA_EMAIL: (GOOGLE_WALLET_SA_EMAIL || '').trim() || undefined,
    SA_PRIVATE_KEY: (GOOGLE_WALLET_SA_PRIVATE_KEY || '').trim() || undefined,
    CLASS_SUFFIX: (GOOGLE_WALLET_CLASS_SUFFIX || 'vbiz-digital-card').trim(),
    LOGO_URL: (GOOGLE_WALLET_LOGO_URL || '').trim() || undefined,
  },
  GEMINI: {
    API_KEY: (GEMINI_API_KEY || '').trim() || undefined,
    LIVE_MODEL: (GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview').trim(),
  },
  OPENAI_TAB_FILL_MODEL: (OPENAI_TAB_FILL_MODEL || 'gpt-4o').trim(),
  APPLE_WALLET: {
    PASS_TYPE_ID: (APPLE_WALLET_PASS_TYPE_ID || '').trim(),
    TEAM_ID: (APPLE_WALLET_TEAM_ID || '').trim(),
    ORGANIZATION: (APPLE_WALLET_ORGANIZATION || 'vBiz').trim() || 'vBiz',
    SIGNER_CERT: (APPLE_WALLET_SIGNER_CERT || '').trim() || undefined,
    SIGNER_KEY: (APPLE_WALLET_SIGNER_KEY || '').trim() || undefined,
    SIGNER_KEY_PASSPHRASE: (APPLE_WALLET_SIGNER_KEY_PASSPHRASE || '').trim() || undefined,
    P12_BASE64: (APPLE_WALLET_P12_BASE64 || '').trim() || undefined,
    P12_PASSPHRASE: (APPLE_WALLET_P12_PASSPHRASE || '').trim() || undefined,
    WWDR_CERT: (APPLE_WALLET_WWDR_CERT || '').trim() || undefined,
  },
}
