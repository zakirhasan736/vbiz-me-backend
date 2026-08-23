import AppError from '../error/AppError'

export const FEATURE_NOT_INCLUDED = 'FEATURE_NOT_INCLUDED'
export const FEATURE_LIMIT_REACHED = 'FEATURE_LIMIT_REACHED'
export const PACKAGE_FEATURE_LOCKED = 'PACKAGE_FEATURE_LOCKED'
export const PACKAGE_LIMIT_REACHED = 'PACKAGE_LIMIT_REACHED'
export const CORPORATE_CARD_LIMIT_REACHED = 'CORPORATE_CARD_LIMIT_REACHED'

export const FEATURE_NOT_INCLUDED_MESSAGE =
  'This feature is not included in your package. Ask an administrator to enable it on your plan.'

export function featureNotIncludedError(featureKey: string, message?: string) {
  return new AppError(403, message || FEATURE_NOT_INCLUDED_MESSAGE, {
    code: FEATURE_NOT_INCLUDED,
    data: {
      featureKey,
      codes: [FEATURE_NOT_INCLUDED, PACKAGE_FEATURE_LOCKED],
    },
  })
}

export function featureLimitReachedError(
  message: string,
  data: Record<string, unknown> = {},
  options?: { statusCode?: number; code?: string }
) {
  const code = options?.code || FEATURE_LIMIT_REACHED
  const codes = [code, FEATURE_LIMIT_REACHED, PACKAGE_LIMIT_REACHED]
  if (code === CORPORATE_CARD_LIMIT_REACHED) codes.push(CORPORATE_CARD_LIMIT_REACHED)
  return new AppError(options?.statusCode || 403, message, {
    code,
    data: { ...data, codes: [...new Set(codes)] },
  })
}
