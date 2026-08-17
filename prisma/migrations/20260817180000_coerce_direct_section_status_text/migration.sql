-- Live Gallery/Video/etc. may still have integer `status` from older tables.
-- Drop status indexes/checks first: Postgres cannot rewrite `status = 1` while
-- changing the column to TEXT (42883: operator does not exist: text = integer).
DO $$
DECLARE
  t TEXT;
  col_type TEXT;
  idx RECORD;
  con RECORD;
  tables TEXT[] := ARRAY[
    'Gallery', 'Video', 'BBBAccreditation', 'Licensing', 'DCP', 'CertificateLicense',
    'Faq', 'CalendarSection', 'PropertyListing', 'Event', 'MediaPress',
    'MenuSection', 'AnnouncementDirect', 'JoinMyTeam', 'Booking',
    'AdditionalService', 'VideoLink', 'Inventory', 'HomeSolar',
    'ResiliencyProduct', 'Breakfast', 'Lunch', 'Dinner', 'Product',
    'SalesPerson', 'TeamMember', 'Client', 'GeneralPost',
    'InsuranceLicense', 'VideoExplainer'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "metas" JSONB', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0', t);

    FOR idx IN
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = t
        AND indexdef ILIKE '%status%'
    LOOP
      EXECUTE format('DROP INDEX IF EXISTS %I', idx.indexname);
    END LOOP;

    FOR con IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public'
        AND r.relname = t
        AND c.contype IN ('c', 'u')
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, con.conname);
    END LOOP;

    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t AND column_name = 'status';

    IF col_type IN ('integer', 'bigint', 'smallint', 'numeric', 'boolean') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" DROP DEFAULT', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" TYPE TEXT USING ("status"::text)', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" SET DEFAULT %L', t, '1');
    END IF;

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("profileId", "status")', t || '_profileId_status_idx', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Faq' AND column_name = 'deletedAt'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Faq' AND column_name = 'status' AND data_type = 'text'
      )
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
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Gallery' AND column_name = 'status' AND data_type = 'text'
      )
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
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Video' AND column_name = 'status' AND data_type = 'text'
      )
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Video_profile_public_sort"
      ON "Video"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;
END $$;
