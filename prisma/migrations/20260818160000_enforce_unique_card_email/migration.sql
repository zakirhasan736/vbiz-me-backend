-- Keep one canonical card for each existing email. Other conflicts return to
-- draft with a blank email so the owner can assign a new unique address.
WITH ranked_emails AS (
  SELECT
    profile.id,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(BTRIM(profile.email))
      ORDER BY
        CASE
          WHEN profile."isDraft" = FALSE AND profile."isPublic" = TRUE THEN 0
          WHEN profile."isDraft" = FALSE THEN 1
          ELSE 2
        END,
        profile."createdAt" ASC,
        profile.id ASC
    ) AS email_rank
  FROM "Profile" AS profile
  WHERE NULLIF(BTRIM(profile.email), '') IS NOT NULL
), duplicate_emails AS (
  SELECT id
  FROM ranked_emails
  WHERE email_rank > 1
)
UPDATE "Profile" AS profile
SET email = '',
    "isDraft" = TRUE,
    "isPublic" = FALSE,
    "statusId" = COALESCE(
      (
        SELECT status.id
        FROM "Status" AS status
        WHERE LOWER(status.name) = 'draft'
        LIMIT 1
      ),
      profile."statusId"
    ),
    "updatedAt" = CURRENT_TIMESTAMP
FROM duplicate_emails
WHERE profile.id = duplicate_emails.id;

-- Blank draft emails are allowed; every non-empty card email is unique without
-- regard to casing or accidental surrounding whitespace.
CREATE UNIQUE INDEX IF NOT EXISTS "Profile_email_unique_ci"
ON "Profile" (LOWER(BTRIM(email)))
WHERE NULLIF(BTRIM(email), '') IS NOT NULL;
