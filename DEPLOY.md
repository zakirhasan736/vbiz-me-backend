# Zero-downtime deploy — Backend API

## Why production used to go down

Running `yarn build` / reinstalling `node_modules` **inside the live API folder** replaces files while Express is running. That drops API + Socket.io for everyone.

This pipeline builds in `releases/<sha>/`, runs migrations, then flips `current` and reloads PM2.

```
/var/www/vbiz-me-backend/
  current → releases/a1b2c3d/
  releases/
    a1b2c3d/
  shared/
    .env
  ecosystem.config.cjs
```

## One-time server setup

```bash
sudo mkdir -p /var/www/vbiz-me-backend/{releases,shared}
sudo chown -R "$USER":"$USER" /var/www/vbiz-me-backend

nano /var/www/vbiz-me-backend/shared/.env   # full production .env from .env.example

npm i -g pm2
pm2 startup
```

Nginx should proxy the API host → `http://127.0.0.1:5000` with:

- `client_max_body_size 50m;`
- WebSocket upgrade headers for Socket.io
- Strip inbound `X-Vbiz-Internal-Key` (see `.env.example`)

## Production start command

PM2 runs **`node dist/server.js`** (compiled). Deploy always runs `yarn build` in the release folder first.

## GitHub secrets

| Secret            | Example                                |
| ----------------- | -------------------------------------- |
| `DEPLOY_HOST`     | server IP/hostname                     |
| `DEPLOY_USER`     | `ubuntu`                               |
| `DEPLOY_SSH_KEY`  | private key                            |
| `DEPLOY_SSH_PORT` | `22` (optional)                        |
| `DEPLOY_PATH_API` | `/var/www/vbiz-me-backend`             |
| `API_HEALTH_URL`  | `https://api.vbizme.com/api/v1/health` |

Create GitHub Environment **`production`** (optional approval before deploy).

## Deploy order (safe for users)

1. **Backend** CI → Deploy (migrate → build in release → flip → health)
2. **Frontend** CI → Deploy (build in release → flip → health)

Do **not** build either app on the live `current` path while users are online.

## Rollback

```bash
cd /var/www/vbiz-me-backend
ls releases/
ln -sfn releases/<previous-sha> current
pm2 reload ecosystem.config.cjs --env production
```

Note: DB migrations are **not** auto-rolled back. Prefer additive migrations.

## Local development

Use `yarn dev` locally. Never run production `yarn build` inside the live `current` directory on the server.
