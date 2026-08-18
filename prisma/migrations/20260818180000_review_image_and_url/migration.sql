-- Public reviews need reviewer photos and leave-a-review links.
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "reviewUrl" TEXT;

-- Restore media/links from legacy review/testimonial posts matched by profile + author/title.
DO $$
BEGIN
  IF to_regclass('public."Review"') IS NULL
    OR to_regclass('public."Post"') IS NULL
    OR to_regclass('public."PostType"') IS NULL THEN
    RETURN;
  END IF;

  UPDATE "Review" AS review
  SET
    "imageUrl" = COALESCE(NULLIF(BTRIM(review."imageUrl"), ''), source.image_url),
    "reviewUrl" = COALESCE(NULLIF(BTRIM(review."reviewUrl"), ''), source.url)
  FROM (
    SELECT
      post."profileId",
      post.title,
      post.url,
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
    LEFT JOIN "PostType" AS post_type ON post_type.id = post."postTypeId"
    WHERE post."deletedAt" IS NULL
      AND (
        post_type."legacyId" = 3
        OR LOWER(COALESCE(post_type.name, '')) IN ('reviews', 'review', 'testimonials', 'testimonial')
      )
  ) AS source
  WHERE review."profileId" = source."profileId"
    AND LOWER(BTRIM(COALESCE(review.author, ''))) = LOWER(BTRIM(COALESCE(source.title, '')))
    AND (
      NULLIF(BTRIM(review."imageUrl"), '') IS NULL
      OR NULLIF(BTRIM(review."reviewUrl"), '') IS NULL
    )
    AND (source.image_url IS NOT NULL OR NULLIF(BTRIM(source.url), '') IS NOT NULL);
END $$;
