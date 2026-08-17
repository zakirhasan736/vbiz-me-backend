-- Live tables created before the direct-section migration (CREATE TABLE IF NOT EXISTS
-- skipped them) are missing Prisma columns such as deletedAt / metas.
DO $$
DECLARE
  t TEXT;
  list_tables TEXT[] := ARRAY[
    'Gallery', 'Video', 'BBBAccreditation', 'Licensing', 'DCP', 'CertificateLicense',
    'Faq', 'CalendarSection', 'PropertyListing', 'Event', 'MediaPress',
    'MenuSection', 'AnnouncementDirect', 'JoinMyTeam', 'Booking',
    'AdditionalService', 'VideoLink', 'Inventory', 'HomeSolar',
    'ResiliencyProduct', 'Breakfast', 'Lunch', 'Dinner', 'Product',
    'SalesPerson', 'TeamMember', 'Client', 'GeneralPost',
    'InsuranceLicense', 'VideoExplainer'
  ];
BEGIN
  FOREACH t IN ARRAY list_tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "legacyPostId" INTEGER', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "title" TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "description" TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "url" TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "featuredImage" TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT %L', t, '1');
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "metas" JSONB', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', t);
  END LOOP;

  IF to_regclass('public."Gallery"') IS NOT NULL THEN
    ALTER TABLE "Gallery" ADD COLUMN IF NOT EXISTS "attachmentUrl" TEXT;
    ALTER TABLE "Gallery" ADD COLUMN IF NOT EXISTS "attachmentName" TEXT;
  END IF;

  IF to_regclass('public."WhyChooseUs"') IS NOT NULL THEN
    ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "legacyPostId" INTEGER;
    ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL DEFAULT 'Why Choose Us';
    ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "description" TEXT;
    ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "featuredMediaUrl" TEXT;
    ALTER TABLE "WhyChooseUs" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT '1';
  END IF;

  IF to_regclass('public."MissionStatement"') IS NOT NULL THEN
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "legacyPostId" INTEGER;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "legacyPostTypeId" INTEGER NOT NULL DEFAULT 19;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "title" TEXT;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "description" TEXT;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "url" TEXT;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "featuredImage" TEXT;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT '1';
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "MissionStatement" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
  END IF;

  IF to_regclass('public."Faq"') IS NOT NULL THEN
    ALTER TABLE "Faq" ADD COLUMN IF NOT EXISTS "legacyPostTypeId" INTEGER NOT NULL DEFAULT 13;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Faq' AND column_name = 'deletedAt'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Faq_profile_public_sort"
      ON "Faq"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Gallery' AND column_name = 'deletedAt'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Gallery_profile_public_sort"
      ON "Gallery"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Video' AND column_name = 'deletedAt'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Video_profile_public_sort"
      ON "Video"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;
END $$;
