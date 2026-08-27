-- Live direct-section tables often predate Prisma and have extra NOT NULL columns
-- (especially legacyPostTypeId / tabKey) plus status/sortOrder/updatedAt without defaults.
-- Prisma create() then fails with a null constraint on "(not available)".
DO $$
DECLARE
  rec RECORD;
  col_exists BOOLEAN;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('Gallery', 4, 'gallery'),
      ('Video', 5, 'videos'),
      ('BlogDirect', 6, 'blogs'),
      ('GeneralPost', 7, 'general_posts'),
      ('BBBAccreditation', 8, 'bbb_accreditations'),
      ('Licensing', 9, 'licensing'),
      ('DCP', 10, 'dcp'),
      ('CertificateLicense', 11, 'certificates'),
      ('InsuranceLicense', 12, 'insurance_licenses'),
      ('Faq', 13, 'faqs'),
      ('CalendarSection', 14, 'calendar'),
      ('PropertyListing', 15, 'property_listings'),
      ('Event', 17, 'events'),
      ('MediaPress', 18, 'media_press'),
      ('MissionStatement', 19, 'mission_statement'),
      ('VideoExplainer', 20, 'video_explainers'),
      ('MenuSection', 21, 'menu'),
      ('WhyChooseUs', 22, 'why_choose_us'),
      ('AnnouncementDirect', 23, 'announcements'),
      ('JoinMyTeam', 24, 'join_my_team'),
      ('Booking', 25, 'bookings'),
      ('AdditionalService', 26, 'additional_services'),
      ('VideoLink', 27, 'video_links'),
      ('Inventory', 28, 'inventory'),
      ('HomeSolar', 29, 'home_solar'),
      ('ResiliencyProduct', 30, 'resiliency_products'),
      ('Breakfast', 31, 'breakfast'),
      ('Lunch', 32, 'lunch'),
      ('Dinner', 33, 'dinner'),
      ('Product', 34, 'products'),
      ('SalesPerson', 35, 'sales_people'),
      ('TeamMember', 36, 'meet_our_team'),
      ('Client', 2, 'clients')
    ) AS t(tbl, type_id, tab_key)
  LOOP
    IF to_regclass('public.' || quote_ident(rec.tbl)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS "legacyPostTypeId" INTEGER NOT NULL DEFAULT %s',
      rec.tbl,
      rec.type_id
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "legacyPostTypeId" SET DEFAULT %s', rec.tbl, rec.type_id);
    EXECUTE format('UPDATE %I SET "legacyPostTypeId" = %s WHERE "legacyPostTypeId" IS NULL', rec.tbl, rec.type_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "legacyPostTypeId" SET NOT NULL', rec.tbl);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = 'tabKey'
    ) INTO col_exists;
    IF col_exists THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "tabKey" SET DEFAULT %L', rec.tbl, rec.tab_key);
      EXECUTE format('UPDATE %I SET "tabKey" = %L WHERE "tabKey" IS NULL', rec.tbl, rec.tab_key);
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = 'status'
    ) INTO col_exists;
    IF col_exists THEN
      EXECUTE format('UPDATE %I SET "status" = %L WHERE "status" IS NULL', rec.tbl, '1');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" SET DEFAULT %L', rec.tbl, '1');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" SET NOT NULL', rec.tbl);
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = 'sortOrder'
    ) INTO col_exists;
    IF col_exists THEN
      EXECUTE format('UPDATE %I SET "sortOrder" = 0 WHERE "sortOrder" IS NULL', rec.tbl);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "sortOrder" SET DEFAULT 0', rec.tbl);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "sortOrder" SET NOT NULL', rec.tbl);
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = rec.tbl AND column_name = 'updatedAt'
    ) INTO col_exists;
    IF col_exists THEN
      EXECUTE format('UPDATE %I SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL', rec.tbl);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP', rec.tbl);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "updatedAt" SET NOT NULL', rec.tbl);
    END IF;
  END LOOP;
END $$;
