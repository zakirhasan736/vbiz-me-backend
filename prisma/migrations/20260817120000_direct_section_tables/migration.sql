CREATE TABLE IF NOT EXISTS "Gallery" (
  "id" TEXT NOT NULL,
  "legacyPostId" INTEGER,
  "profileId" TEXT NOT NULL,
  "title" TEXT,
  "description" TEXT,
  "url" TEXT,
  "featuredImage" TEXT,
  "attachmentUrl" TEXT,
  "attachmentName" TEXT,
  "status" TEXT NOT NULL DEFAULT '1',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "metas" JSONB,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Gallery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Gallery_legacyPostId_key" ON "Gallery"("legacyPostId");
CREATE INDEX IF NOT EXISTS "Gallery_profileId_idx" ON "Gallery"("profileId");
CREATE INDEX IF NOT EXISTS "Gallery_profileId_status_idx" ON "Gallery"("profileId", "status");

DO $$ BEGIN
  ALTER TABLE "Gallery" ADD CONSTRAINT "Gallery_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  table_name TEXT;
  tables TEXT[] := ARRAY[
    'Video', 'BBBAccreditation', 'Licensing', 'DCP', 'CertificateLicense',
    'Faq', 'CalendarSection', 'PropertyListing', 'Event', 'MediaPress',
    'MenuSection', 'AnnouncementDirect', 'JoinMyTeam', 'Booking',
    'AdditionalService', 'VideoLink', 'Inventory', 'HomeSolar',
    'ResiliencyProduct', 'Breakfast', 'Lunch', 'Dinner', 'Product',
    'SalesPerson', 'TeamMember', 'Client', 'GeneralPost',
    'InsuranceLicense', 'VideoExplainer'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I (
        "id" TEXT NOT NULL,
        "legacyPostId" INTEGER,
        "profileId" TEXT NOT NULL,
        "title" TEXT,
        "description" TEXT,
        "url" TEXT,
        "featuredImage" TEXT,
        "status" TEXT NOT NULL DEFAULT ''1'',
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "metas" JSONB,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT %I PRIMARY KEY ("id")
      )',
      table_name,
      table_name || '_pkey'
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I ("legacyPostId")',
      table_name || '_legacyPostId_key',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I ("profileId")',
      table_name || '_profileId_idx',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I ("profileId", "status")',
      table_name || '_profileId_status_idx',
      table_name
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = table_name || '_profileId_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("profileId")
         REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        table_name,
        table_name || '_profileId_fkey'
      );
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS "MissionStatement" (
  "id" TEXT NOT NULL,
  "legacyPostId" INTEGER,
  "profileId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'Mission Statement',
  "description" TEXT,
  "featuredMediaUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MissionStatement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MissionStatement_legacyPostId_key" ON "MissionStatement"("legacyPostId");
CREATE UNIQUE INDEX IF NOT EXISTS "MissionStatement_profileId_key" ON "MissionStatement"("profileId");
CREATE INDEX IF NOT EXISTS "MissionStatement_profileId_idx" ON "MissionStatement"("profileId");

DO $$ BEGIN
  ALTER TABLE "MissionStatement" ADD CONSTRAINT "MissionStatement_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WhyChooseUs" (
  "id" TEXT NOT NULL,
  "legacyPostId" INTEGER,
  "profileId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'Why Choose Us',
  "description" TEXT,
  "featuredMediaUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhyChooseUs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WhyChooseUs_legacyPostId_key" ON "WhyChooseUs"("legacyPostId");
CREATE UNIQUE INDEX IF NOT EXISTS "WhyChooseUs_profileId_key" ON "WhyChooseUs"("profileId");
CREATE INDEX IF NOT EXISTS "WhyChooseUs_profileId_idx" ON "WhyChooseUs"("profileId");

DO $$ BEGIN
  ALTER TABLE "WhyChooseUs" ADD CONSTRAINT "WhyChooseUs_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CustomTab" (
  "id" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "icon" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "isPublic" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT '1',
  "layoutType" TEXT NOT NULL DEFAULT 'list',
  "settings" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomTab_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CustomTab_profileId_key_key" ON "CustomTab"("profileId", "key");
CREATE INDEX IF NOT EXISTS "CustomTab_profileId_status_idx" ON "CustomTab"("profileId", "status");

DO $$ BEGIN
  ALTER TABLE "CustomTab" ADD CONSTRAINT "CustomTab_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CustomTabItem" (
  "id" TEXT NOT NULL,
  "customTabId" TEXT NOT NULL,
  "profileId" TEXT NOT NULL,
  "title" TEXT,
  "description" TEXT,
  "url" TEXT,
  "featuredImage" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT '1',
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomTabItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CustomTabItem_customTabId_status_idx" ON "CustomTabItem"("customTabId", "status");
CREATE INDEX IF NOT EXISTS "CustomTabItem_profileId_status_idx" ON "CustomTabItem"("profileId", "status");

DO $$ BEGIN
  ALTER TABLE "CustomTabItem" ADD CONSTRAINT "CustomTabItem_customTabId_fkey"
    FOREIGN KEY ("customTabId") REFERENCES "CustomTab"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CustomTabItem" ADD CONSTRAINT "CustomTabItem_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "Gallery" (
  "id", "legacyPostId", "profileId", "title", "description", "url",
  "featuredImage", "attachmentUrl", "attachmentName", "status",
  "sortOrder", "createdAt", "updatedAt"
)
SELECT
  p."id", p."legacyId", p."profileId", p."title", p."description", p."url",
  p."imageUrl", p."attachmentUrl", p."attachmentName", p."status"::TEXT,
  p."sortOrder", p."createdAt", p."updatedAt"
FROM "Portfolio" p
WHERE EXISTS (SELECT 1 FROM "Profile" pr WHERE pr."id" = p."profileId")
ON CONFLICT ("id") DO NOTHING;

DO $$
DECLARE
  mapping RECORD;
BEGIN
  IF to_regclass('public."TabItem"') IS NULL THEN
    RETURN;
  END IF;

  FOR mapping IN
    SELECT * FROM (VALUES
      ('videos', 'Video'),
      ('bbb_accreditations', 'BBBAccreditation'),
      ('licensing', 'Licensing'),
      ('dcp', 'DCP'),
      ('certificates', 'CertificateLicense'),
      ('faqs', 'Faq'),
      ('calendar', 'CalendarSection'),
      ('property_listings', 'PropertyListing'),
      ('events', 'Event'),
      ('media_press', 'MediaPress'),
      ('menu', 'MenuSection'),
      ('announcements', 'AnnouncementDirect'),
      ('join_my_team', 'JoinMyTeam'),
      ('bookings', 'Booking'),
      ('additional_services', 'AdditionalService'),
      ('video_links', 'VideoLink'),
      ('inventory', 'Inventory'),
      ('home_solar', 'HomeSolar'),
      ('resiliency_products', 'ResiliencyProduct'),
      ('breakfast', 'Breakfast'),
      ('lunch', 'Lunch'),
      ('dinner', 'Dinner'),
      ('products', 'Product'),
      ('sales_people', 'SalesPerson'),
      ('meet_our_team', 'TeamMember'),
      ('clients', 'Client'),
      ('general_posts', 'GeneralPost'),
      ('insurance_licenses', 'InsuranceLicense'),
      ('video_explainers', 'VideoExplainer')
    ) AS values_table(tab_key, table_name)
  LOOP
    EXECUTE format(
      'INSERT INTO %I (
        "id", "legacyPostId", "profileId", "title", "description", "url",
        "featuredImage", "status", "sortOrder", "metas", "deletedAt",
        "createdAt", "updatedAt"
      )
      SELECT
        t."id", t."legacyPostId", t."profileId", t."title", t."description", t."url",
        t."featuredImage", t."status", t."sortOrder", t."metas", t."deletedAt",
        t."createdAt", t."updatedAt"
      FROM "TabItem" t
      WHERE t."tabKey" = %L
        AND EXISTS (SELECT 1 FROM "Profile" pr WHERE pr."id" = t."profileId")
      ON CONFLICT ("id") DO NOTHING',
      mapping.table_name,
      mapping.tab_key
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public."TabItem"') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "MissionStatement" (
    "id", "legacyPostId", "profileId", "title", "description",
    "featuredMediaUrl", "status", "createdAt", "updatedAt"
  )
  SELECT DISTINCT ON (t."profileId")
    t."id", t."legacyPostId", t."profileId", COALESCE(t."title", 'Mission Statement'),
    t."description", t."featuredImage", t."status", t."createdAt", t."updatedAt"
  FROM "TabItem" t
  WHERE t."tabKey" = 'mission_statement'
    AND EXISTS (SELECT 1 FROM "Profile" pr WHERE pr."id" = t."profileId")
  ORDER BY t."profileId", t."sortOrder", t."createdAt" DESC
  ON CONFLICT DO NOTHING;

  INSERT INTO "WhyChooseUs" (
    "id", "legacyPostId", "profileId", "title", "description",
    "featuredMediaUrl", "status", "createdAt", "updatedAt"
  )
  SELECT DISTINCT ON (t."profileId")
    t."id", t."legacyPostId", t."profileId", COALESCE(t."title", 'Why Choose Us'),
    t."description", t."featuredImage", t."status", t."createdAt", t."updatedAt"
  FROM "TabItem" t
  WHERE t."tabKey" = 'why_choose_us'
    AND EXISTS (SELECT 1 FROM "Profile" pr WHERE pr."id" = t."profileId")
  ORDER BY t."profileId", t."sortOrder", t."createdAt" DESC
  ON CONFLICT DO NOTHING;
END $$;
