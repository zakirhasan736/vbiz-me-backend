# VBizMe Backend

Node.js + Express + TypeScript API with PostgreSQL (Prisma ORM 7), JWT cookie auth, and Passport social login (Google + Facebook).

## Stack

- Yarn 4
- Express (ESM)
- TypeScript
- PostgreSQL + Prisma 7 (`prisma.config.ts`, `@prisma/adapter-pg`)
- Zod validation
- Passport (`passport-google-oauth20`, `passport-facebook`)
- JWT access/refresh tokens in httpOnly cookies

## Folder structure

```text
src/
  app.ts
  server.ts
  configs/          # env + passport
  controller/       # HTTP handlers
  services/         # business logic + Prisma
  router/           # Express routes (/api/v1)
  middlewares/
  interfaces/
  zodValidation/
  error/
  utils/
  constants/
prisma/
  schema.prisma
generated/prisma/   # prisma generate output
```

## Setup

1. Install dependencies:

```bash
yarn install
```

2. Copy env and fill values:

```bash
cp .env.example .env
```

Required:

- `DATABASE_URL` — PostgreSQL connection string
- `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET`
- `SERVER_URL` — e.g. `http://localhost:5000`
- `BASE_SITE` — frontend URL for OAuth redirects
- Google / Facebook OAuth credentials (for social login)

3. Create the database (example):

```bash
createdb vbizme
```

4. Generate client and run migrations:

```bash
yarn generate
yarn migrate:dev
```

5. Start the API:

```bash
yarn dev
```

Server defaults to `http://localhost:5000`.

## Auth endpoints

| Method | Path                             | Auth   | Description                         |
| ------ | -------------------------------- | ------ | ----------------------------------- |
| POST   | `/api/v1/auth/register`          | No     | Register with name, email, password |
| POST   | `/api/v1/auth/login`             | No     | Login; sets cookies                 |
| GET    | `/api/v1/auth/author`            | Cookie | Current user                        |
| POST   | `/api/v1/auth/logout`            | Cookie | Clear cookies                       |
| POST   | `/api/v1/auth/refreshToken`      | Cookie | Rotate tokens                       |
| GET    | `/api/v1/auth/google`            | No     | Start Google OAuth                  |
| GET    | `/api/v1/auth/google/callback`   | No     | Google callback                     |
| GET    | `/api/v1/auth/facebook`          | No     | Start Facebook OAuth                |
| GET    | `/api/v1/auth/facebook/callback` | No     | Facebook callback                   |
| GET    | `/api/v1/health`                 | No     | Health check                        |

### Register / login body

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "secret123"
}
```

Login only needs `email` and `password`.

### OAuth app setup

**Google**

1. Create OAuth credentials in Google Cloud Console
2. Authorized redirect URI: `{SERVER_URL}/api/v1/auth/google/callback`

**Facebook**

1. Create an app at [Meta Developers](https://developers.facebook.com/)
2. Add Facebook Login and set Valid OAuth Redirect URI: `{SERVER_URL}/api/v1/auth/facebook/callback`
3. Request `email` permission

## Scripts

| Script             | Description             |
| ------------------ | ----------------------- |
| `yarn dev`         | Dev server with watch   |
| `yarn build`       | Compile TypeScript      |
| `yarn start`       | Run compiled server     |
| `yarn generate`    | Prisma client generate  |
| `yarn migrate:dev` | Create/apply migrations |
| `yarn studio`      | Prisma Studio           |

## Response shape

Success:

```json
{ "success": true, "statusCode": 200, "message": "...", "data": {} }
```

Error:

```json
{ "success": false, "message": "...", "errorMessages": [{ "path": "", "message": "..." }] }
```
