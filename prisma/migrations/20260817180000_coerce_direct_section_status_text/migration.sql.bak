-- Live Gallery/Video/etc. may still have integer `status` from older tables.
-- Prisma models these as TEXT, which 500s with "Inconsistent column data".
DO $$
DECLARE
  t TEXT;
  col_type TEXT;
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

    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t AND column_name = 'status';

    IF col_type IN ('integer', 'bigint', 'smallint', 'numeric', 'boolean') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" DROP DEFAULT', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" TYPE TEXT USING "status"::text', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN "status" SET DEFAULT %L', t, '1');
    END IF;
  END LOOP;
END $$;
