-- First-class price fields for See Products (Product table).
-- Also keep values mirrored in metas.price / metas.offer_price for API clients.

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "price" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "offerPrice" TEXT;

-- Backfill from existing metas JSON when present.
UPDATE "Product"
SET
  "price" = COALESCE(
    NULLIF(BTRIM("price"), ''),
    NULLIF(BTRIM(metas ->> 'price'), '')
  ),
  "offerPrice" = COALESCE(
    NULLIF(BTRIM("offerPrice"), ''),
    NULLIF(BTRIM(metas ->> 'offer_price'), ''),
    NULLIF(BTRIM(metas ->> 'offerPrice'), '')
  )
WHERE metas IS NOT NULL;
