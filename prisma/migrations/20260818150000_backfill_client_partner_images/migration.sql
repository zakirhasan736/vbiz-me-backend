-- Restore each migrated client/partner image from its own legacy Post media.
DO $$
BEGIN
  IF to_regclass('public."Client"') IS NULL
    OR to_regclass('public."Post"') IS NULL
    OR to_regclass('public."Attachment"') IS NULL THEN
    RETURN;
  END IF;

  UPDATE "Client" AS client
  SET "featuredImage" = source.image_url
  FROM (
    SELECT
      post.id,
      post."legacyId",
      post."profileId",
      COALESCE(
        NULLIF(BTRIM(post."featuredImage"), ''),
        (
          SELECT COALESCE(NULLIF(BTRIM(attachment.url), ''), NULLIF(BTRIM(attachment."docName"), ''))
          FROM "Attachment" AS attachment
          WHERE attachment."postId" = post.id
          ORDER BY attachment."createdAt" ASC
          LIMIT 1
        )
      ) AS image_url
    FROM "Post" AS post
    WHERE post."deletedAt" IS NULL
  ) AS source
  WHERE client."profileId" = source."profileId"
    AND (client."legacyPostId" = source."legacyId" OR client.id = source.id)
    AND NULLIF(BTRIM(client."featuredImage"), '') IS NULL
    AND source.image_url IS NOT NULL;
END $$;
