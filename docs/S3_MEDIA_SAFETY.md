# Card media on S3 — safety rules

## What went wrong (Oct 2026)

Images and videos on cards randomly showed **AccessDenied**. The files were not
blocked; they had been **deleted** by the API. The bucket has no public `ListBucket`,
so S3 answers a missing key with AccessDenied instead of 404.

Before this change, `POST /media/clear` (Remove / Replace on any featured image)
matched every attachment of the same type on the card (e.g. all "Service Featured"
rows), and its "is this still used?" check skipped the card's own rows and never
looked at `Service.imageUrl`, `Gallery`, `Blog`, … So removing one service image
deleted all of them from S3 while the card still pointed at the URLs. History
Restore could not help: it restores database rows (URLs), not files.

## The rules now

1. **The API never deletes media.** `s3Utils` has no `destroy`. Remove / Replace only
   detach the `Attachment` row and update the card; the old file stays in S3.
2. **The app IAM user cannot delete** (`deploy/iam/s3-app-user-policy.json`). Even a
   future bug cannot remove a file.
3. **Versioning stays on** (`scripts/enable-s3-versioning.ts`, 90-day noncurrent
   window). Any delete — by anyone — is recoverable for 90 days.
4. **Self-healing:**
   - History **Restore** first checks every image/video URL in the snapshot and
     brings missing files back from S3 versions (response includes `media.recovered`
     and `media.unrecoverable`).
   - `POST /api/v1/media/repair { profileId }` checks and heals every media URL on
     one card.
   - `yarn media:repair [--card=<slug>] [--apply]` does the same site-wide and lists
     cards that still need a re-upload.
5. **Duplicating a card copies every file** (profile media, settings, all tabs, rich
   text) to new keys owned by the new card (`copyAllCardMediaToOwnKeys`).
   Corporate owner edits that fan out to member cards afterwards share the owner's
   URLs again by design — that is safe because nothing deletes media.
6. **Storage is reclaimed offline only:** `yarn media:cleanup` (dry-run by default)
   deletes a file only if it is referenced nowhere in the database (all tables incl.
   history and backups), is older than 30 days, and has the app's own key pattern.
   It runs with a separate cleanup IAM user and refuses to run if >50% of the bucket
   looks unused.

## AWS setup checklist (one time)

1. IAM → the user whose keys are in the API `.env` (`AWS_ACCESS_KEY_ID`) → replace
   its S3 permissions with `deploy/iam/s3-app-user-policy.json`.
2. Create a second IAM user `vbizme-media-cleanup` with
   `deploy/iam/s3-cleanup-user-policy.json`. Put its keys only on the machine that
   runs cleanup, as `S3_CLEANUP_ACCESS_KEY_ID` / `S3_CLEANUP_SECRET_ACCESS_KEY`.
3. Confirm versioning: S3 → bucket → Properties → Bucket Versioning = Enabled.
   (Or run `npx tsx --env-file=.env scripts/enable-s3-versioning.ts` with admin keys —
   the app user is not allowed to change versioning.)
4. After deploy: `yarn media:repair` (dry-run), then `yarn media:repair --apply`.

## For developers

- Do not add `DeleteObjectCommand` to `src/`. If storage must be reclaimed, extend
  `scripts/s3-orphan-cleanup.ts`.
- New tables/columns holding media URLs need no registration — the scanners read
  `information_schema` and cover every text/json column automatically.
