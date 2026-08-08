-- Portfolio secondary media: Attachments (Images/Video)
ALTER TABLE "Portfolio" ADD COLUMN IF NOT EXISTS "attachmentUrl" TEXT;
ALTER TABLE "Portfolio" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;
