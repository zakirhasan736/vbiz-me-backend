/** Normalize See Products pricing from metas / top-level fields. */

export function resolveStoredProductPricing(input: {
  price?: unknown
  offerPrice?: unknown
  offer_price?: unknown
  metas?: Record<string, unknown> | null
}): { price: string; offerPrice: string; metas: Record<string, string> } {
  const metasIn =
    input.metas && typeof input.metas === 'object' && !Array.isArray(input.metas)
      ? (input.metas as Record<string, unknown>)
      : {}

  const pick = (...values: unknown[]) => {
    for (const value of values) {
      if (value == null) continue
      const text = String(value).trim()
      if (text) return text
    }
    return ''
  }

  const price = pick(input.price, metasIn.price)
  const offerPrice = pick(input.offerPrice, input.offer_price, metasIn.offer_price, metasIn.offerPrice)

  const metas: Record<string, string> = {}
  for (const [key, value] of Object.entries(metasIn)) {
    metas[key] = value == null ? '' : String(value)
  }
  if (price) metas.price = price
  if (offerPrice) metas.offer_price = offerPrice

  return { price, offerPrice, metas }
}
