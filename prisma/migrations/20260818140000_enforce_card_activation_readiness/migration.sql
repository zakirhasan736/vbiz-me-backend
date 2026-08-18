-- Existing public cards missing starred activation fields must return to Draft.
UPDATE "Profile" AS profile
SET "statusId" = draft_status.id,
    "isDraft" = TRUE,
    "isPublic" = FALSE,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Status" AS draft_status
WHERE LOWER(draft_status.name) = 'draft'
  AND profile."isDraft" = FALSE
  AND profile."isPublic" = TRUE
  AND (
    NULLIF(BTRIM(profile.name), '') IS NULL
    OR NULLIF(BTRIM(profile.email), '') IS NULL
    OR NULLIF(BTRIM(profile.slug), '') IS NULL
    OR profile.dob IS NULL
    OR NULLIF(BTRIM(profile.phone), '') IS NULL
  );
