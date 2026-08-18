-- AI create previously left published profiles linked to the Draft status row.
UPDATE "Profile" AS profile
SET "statusId" = target.id,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Status" AS current_status,
     "Status" AS target
WHERE profile."statusId" = current_status.id
  AND LOWER(current_status.name) = 'draft'
  AND profile."isDraft" = FALSE
  AND profile."isPublic" = TRUE
  AND LOWER(target.name) = 'active';

UPDATE "Profile" AS profile
SET "statusId" = target.id,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Status" AS current_status,
     "Status" AS target
WHERE profile."statusId" = current_status.id
  AND LOWER(current_status.name) = 'draft'
  AND profile."isDraft" = FALSE
  AND profile."isPublic" = FALSE
  AND LOWER(target.name) = 'inactive';
