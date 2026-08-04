# Production cutover checklist (Laravel → Node)

## Prerequisites

- [ ] PostgreSQL production database reachable via `DATABASE_URL`
- [ ] AWS S3 credentials set (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`, `S3_PUBLIC_BASE_URL`)
- [ ] Temporary MySQL with `vbizme_app_backup.sql` loaded
- [ ] `LARAVEL_MYSQL_URL` pointing at that MySQL
- [ ] `MEDIA_BASE_URL` set to the old public media host (default `https://app.vbizme.com`)
- [ ] Frontend envs ready:
  - `NEXT_PUBLIC_API_URL=https://<node-api>/api/v1`
  - `NEXT_PUBLIC_PUBLIC_API_URL=https://<node-api>/api/v1/public`
  - Remove `NEXT_PUBLIC_LARAVEL_API_URL`
  - After media migrate: allow the S3/CDN host in Next.js `images.remotePatterns`

## Steps

1. Deploy backend with domain migrations applied (`yarn prisma migrate deploy` or already-pushed schema).
2. Run data import: `yarn migrate:laravel`
3. Rebuild absolute legacy source URLs (fixes bare filenames like `1782843162_arif.jpg`):
   `yarn migrate:media-urls`
4. Copy media to S3 and rewrite DB URLs to S3 only:
   `yarn migrate:media`
   - Re-run until the failure report under `scripts/reports/` is empty (or only lists files already missing on the old host).
   - Failed rows keep their legacy absolute URL — no data loss; fix and re-run.
5. Make the S3 media prefix publicly readable (required for `next/image` / browsers):
   `yarn s3:make-public`
6. Smoke test:
   - `GET /api/v1/health`
   - `GET /api/v1/public/v/zohaib-ullah-baig` (profile_media.url should be an absolute S3 URL)
   - `GET /api/v1/public/post-types?profile_id=<id>`
   - `GET /api/v1/public/dynamic-section/services?profile_id=<id>`
   - Auth login + `GET /api/v1/profiles`
   - Upload via `POST /api/v1/media/upload` (new files already use S3)
7. Point administration production env to the new API URLs and redeploy frontend.
8. Verify public card `/v/<slug>` and dashboard My vCards against production data.
9. Decommission Laravel API / old media host / stop writing to old MySQL.

## Rollback

- Keep Laravel + MySQL read-only for 48h.
- Revert frontend env to Laravel public URL only if public cards fail critically.
- Do not re-run import without truncating migrated domain tables first.
