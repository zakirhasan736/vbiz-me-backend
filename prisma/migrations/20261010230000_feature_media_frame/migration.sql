-- Crop position for featured images and videos that do not already store it in metas JSON.
ALTER TABLE "BlogDirect" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "Faq" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "Portfolio" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "mediaFrame" JSONB;
