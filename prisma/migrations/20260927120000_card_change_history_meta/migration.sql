-- Durable health + actor footprint that survives 72h snapshot expiry
ALTER TABLE "CardChangeHistory" ADD COLUMN "meta" JSONB;
