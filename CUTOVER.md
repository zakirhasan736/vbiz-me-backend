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

## Steps

1. Deploy backend with domain migrations applied (`yarn prisma migrate deploy` or already-pushed schema).
2. Run data import: `yarn migrate:laravel`
3. Run media backfill: `yarn migrate:media` (uploads legacy files to S3)
4. Smoke test:
   - `GET /api/v1/health`
   - `GET /api/v1/public/v/zohaib-ullah-baig`
   - `GET /api/v1/public/post-types?profile_id=<id>`
   - `GET /api/v1/public/dynamic-section/services?profile_id=<id>`
   - Auth login + `GET /api/v1/profiles`
   - Upload via `POST /api/v1/media/upload`
5. Point administration production env to the new API URLs and redeploy frontend.
6. Verify public card `/v/<slug>` and dashboard My vCards against production data.
7. Decommission Laravel API / stop writing to old MySQL.

## Rollback

- Keep Laravel + MySQL read-only for 48h.
- Revert frontend env to Laravel public URL only if public cards fail critically.
- Do not re-run import without truncating migrated domain tables first.
