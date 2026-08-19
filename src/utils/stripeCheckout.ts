export type CheckoutLineItem = {
  name: string
  unitAmountCents: number
  interval?: 'month'
}

export function buildCheckoutLineItems(input: {
  productName: string
  monthlyCents: number
  signupFeeCents?: number | null
  includeSignup: boolean
}): CheckoutLineItem[] {
  const monthly = Math.max(0, Math.round(Number(input.monthlyCents) || 0))
  const signup = Math.max(0, Math.round(Number(input.signupFeeCents) || 0))
  const items: CheckoutLineItem[] = []
  if (monthly > 0) {
    items.push({
      name: `${input.productName} monthly`,
      unitAmountCents: monthly,
      interval: 'month',
    })
  }
  if (input.includeSignup && signup > 0) {
    items.push({
      name: `${input.productName} signup fee`,
      unitAmountCents: signup,
    })
  }
  return items
}

export function toStripeSubscriptionLineItems(items: CheckoutLineItem[]) {
  return items.map((item) => ({
    quantity: 1,
    price_data: {
      currency: 'usd' as const,
      unit_amount: item.unitAmountCents,
      product_data: { name: item.name },
      ...(item.interval ? { recurring: { interval: item.interval } } : {}),
    },
  }))
}

export function checkoutModeForItems(items: CheckoutLineItem[]): 'subscription' | 'payment' | 'none' {
  if (!items.length) return 'none'
  return items.some((item) => item.interval === 'month') ? 'subscription' : 'payment'
}
