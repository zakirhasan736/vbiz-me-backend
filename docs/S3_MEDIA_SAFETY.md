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

## Identity + status registry (MediaAsset)

Every file has a `MediaAsset` row: S3 `key` (source of truth), `status`
(`ok | missing | pending`), the card (`profileId`), the tab/screen (`area`: services,
portfolio, gallery, about, profile, intro-video, …) and the item (`itemLabel`).

- **Keys say where a file belongs.** New uploads go to
  `vbizme/cards/<cardId>/<tab>/<ms>-<name>` and carry S3 metadata
  (`profile-id`, `area`, `uploaded-by`, `source`). Old flat keys keep working.
- **Upload:** row is written `pending` → PutObject → HeadObject → `ok` (or
  `missing` with a reason). A URL is only returned when the object exists.
- **Nightly health sweep** (`MEDIA_HEALTH_CRON_EXPR`, default `40 3 * * *`
  America/New_York; disable with `MEDIA_HEALTH_CRON_ENABLED=false`): HEAD every
  referenced file, recover from versions, flag the rest as `missing`.
- **Per card:** `GET /media/status?profileId=` (last known) and
  `POST /media/repair` (check now) list every file as _tab → item → status_.
- **Existing data:** `yarn media:backfill` (dry-run) / `--apply` registers every
  current file with its card and tab.
- **Base URL / CDN change:** set the new `S3_PUBLIC_BASE_URL`, then
  `yarn media:rebase --from=<old base> [--apply]` rewrites every stored URL in one go.

Why a registry table instead of `imageKey`/`imageStatus` columns on every model:
media URLs live in ~15 columns across 10+ tables plus settings JSON and rich-text
HTML. One table covers all of them (including HTML/JSON) with no per-model
migrations, and the scanners pick up new columns automatically.

## Never guess a file from a similar name

`scripts/restore-s3-keys-from-siblings.ts` was removed. It "restored" a missing key
by copying another file with a similar name (e.g. `ML-1.jpeg` → `ML1.jpg`). Those
can be different pictures from different tabs, so a Services item could end up
showing a Portfolio image. Recovery now only uses S3 versions of the exact same key.

## AWS setup checklist (one time)

1. IAM → the user whose keys are in the API `.env` (`AWS_ACCESS_KEY_ID`) → replace
   its S3 permissions with `deploy/iam/s3-app-user-policy.json`.
2. Create a second IAM user `vbizme-media-cleanup` with
   `deploy/iam/s3-cleanup-user-policy.json`. Put its keys only on the machine that
   runs cleanup, as `S3_CLEANUP_ACCESS_KEY_ID` / `S3_CLEANUP_SECRET_ACCESS_KEY`.
3. Confirm versioning: S3 → bucket → Properties → Bucket Versioning = Enabled.
   (Or run `npx tsx --env-file=.env scripts/enable-s3-versioning.ts` with admin keys —
   the app user is not allowed to change versioning.)
4. After deploy: `yarn migrate:deploy` (creates `MediaAsset`), `yarn media:backfill --apply`,
   then `yarn media:repair` (dry-run) and `yarn media:repair --apply`.

## For developers

- Do not add `DeleteObjectCommand` to `src/`. If storage must be reclaimed, extend
  `scripts/s3-orphan-cleanup.ts`.
- New tables/columns holding media URLs need no registration — the scanners read
  `information_schema` and cover every text/json column automatically.
