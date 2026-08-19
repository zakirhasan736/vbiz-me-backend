# Production cutover checklist (Laravel → Node)

## Prerequisites

- [ ] PostgreSQL production database reachable via `DATABASE_URL`
- [ ] AWS S3 credentials set (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`, `S3_PUBLIC_BASE_URL`)
- [ ] Temporary MySQL with `vbizme_app_backup.sql` loaded
- [ ] `LARAVEL_MYSQL_URL` pointing at that MySQL
- [ ] `MEDIA_BASE_URL` set to the old public media host (default `https://app.vbizme.com`)
- [ ] Reverse proxy body limit ≥ **50MB** (matches multer on `POST /api/v1/media/upload`). Without this, production returns `413 Request entity too large` while local Node works.
  - Nginx: `client_max_body_size 50m;` in the API `server` / `http` block, then reload Nginx
  - Also raise any CDN / WAF / PaaS upload limit to ≥ 50MB if applicable
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

---

# Package / auth / Stripe go-live (plan Step 13)

Do **not** delete cards. Admin-granted subscriptions stay active. Stripe paid access activates only after a successful payment.

## Env (backend)

- [ ] `LOGIN_OTP_REQUIRED=true` (default). Staff remain password-only.
- [ ] Mail working (`MAIL_ADDRESS` / `MAIL_PASS`) so owner OTP and password-setup mail send.
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` if Checkout is going live.
- [ ] Stripe Dashboard webhook: `POST https://<api-host>/api/v1/billing/webhook` (raw JSON body).
- [ ] Frontend: `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_PUBLIC_API_URL` already pointing at this API.

## Order

Run migrate/backfill only on a host whose `DATABASE_URL` authenticates. Do not delete cards. Do not invent credentials.

1. Deploy **backend** with the new code.
2. `yarn migrate:deploy`  
   Must include at least: `auth_challenge`, `corporate_feature_override`, `signup_fee_and_negotiated_monthly`, `stripe_events`, `package_owner_mode`.
3. Backfill report only: `yarn backfill:owner-packages`  
   Review Corporate owners on Free (listed, not auto-demoted). Existing cards are never deleted.
4. If the report is accepted: `yarn backfill:owner-packages -- --apply`
5. Deploy **administration** frontend (`corepack yarn build` then your usual host start).
6. Preflight: `yarn cutover:check`  
   Optional live health: `SMOKE_API_URL=https://<api-host> yarn cutover:check`

## Smoke

- [ ] `GET /api/v1/health`
- [ ] Staff login (password only)
- [ ] Card-owner login: password → email OTP → session
- [ ] One Single owner → `/`
- [ ] One Corporate owner → `/teamvcard`
- [ ] Admin package edit
- [ ] Create-card blocked at cap; existing cards still there
- [ ] Media flag off → upload 403 `FEATURE_NOT_INCLUDED`; existing files still on the card

## Rollback (OTP mail failure)

If owners cannot receive OTP mail, set `LOGIN_OTP_REQUIRED=false` on the API and restart. Do not roll back migrations. Do not delete cards.

## Rollback

- Keep Laravel + MySQL read-only for 48h.
- Revert frontend env to Laravel public URL only if public cards fail critically.
- Do not re-run import without truncating migrated domain tables first.
