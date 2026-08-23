-- Stripe webhook idempotency + optional Stripe Price IDs on packages.
CREATE TABLE IF NOT EXISTS "StripeEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StripeEvent_eventId_key" ON "StripeEvent"("eventId");

ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT;
ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "stripeSignupPriceId" TEXT;
