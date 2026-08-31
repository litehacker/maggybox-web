# Pipeline — GitHub → Vercel

This document describes the CI/CD pipeline for `litehacker/maggybox-web` (MAG-15).
Repo of record is **this repo only**; the legacy `litehacker/maggybox` is archive/reference.

## What runs where

| Event | What happens |
| --- | --- |
| Pull request → `main` | GitHub Actions workflow **CI** (`.github/workflows/ci.yml`, job `build`): install (npm workspaces) → `prisma generate` → typecheck → build all workspaces (`@maggybox/contracts`, `@maggybox/storage`, `@maggybox/web`, `@maggybox/worker`). Build failures are surfaced as annotations. In parallel, **Vercel** creates a Preview deployment for the PR and posts the preview URL as a PR comment (`vercel[bot]`). |
| Merge / push to `main` | Same CI job runs on `main`; Vercel builds and deploys **Production** to https://maggybox-web-three.vercel.app. |
| Failing CI check | **Should** block merge — `build` must be a required status check under branch protection for `main`. ⚠️ **Not yet enabled** (verified 2026-08-31: `branches/main` → `protection.enabled = false`). Repo admin must do a one-time click: Settings → Branches → Add branch protection rule for `main` → Require status checks to pass → select **`build`** (GitHub Actions). Tracked on MAG-15. |

## Vercel project

- Project: [`maggybox-web`](https://vercel.com/giorgi-alik-gvimradze-s-projects/maggybox-web) (id `prj_okNqE8KIbDBhOYKtFm4dVn5D1Hyc`), team `giorgi-alik-gvimradze-s-projects`.
- Git integration: Vercel GitHub App connected to `litehacker/maggybox-web`. Previews on every PR; production from `main`.
- Root repo `vercel.json` sets install/build/output commands. Build command is
  `npm run db:migrate && npm run build --workspace @maggybox/web`, so `prisma migrate deploy`
  applies pending migrations to the linked Postgres on **every** deploy (safe: applies only pending migrations).
- ⚠️ Note: the Vercel dashboard sets the project **Root Directory to `apps/web`**, which makes Vercel use
  `apps/web/vercel.json` (plain `npm run build`) instead of the root `vercel.json` — meaning the
  `db:migrate` step may be skipped on deploys. Coordinate with the DB ticket (MAG-9) before changing.

## Environment variables (never commit values)

Set in Vercel → Project → Settings → Environment Variables for **Production, Preview, and Development**:

| Name | Source |
| --- | --- |
| `DATABASE_URL` | Vercel Storage (Neon/Prisma Postgres) linked to the project — pooled/runtime URL used by the Prisma client |
| `DIRECT_URL` | Same store's **non-pooling** URL (Neon: `POSTGRES_URL_NON_POOLING`); same value as `DATABASE_URL` if unpooled. Required by `prisma migrate deploy` at build time — builds fail fast without it |
| `APP_BASE_URL` | Public base URL of the web app (used to build absolute signed URLs) |
| `STORAGE_SIGNING_SECRET` | HMAC secret for signed artifact download URLs (set per environment) |
| Optional storage vars | `BLOB_READ_WRITE_TOKEN` or `S3_*` — only if object storage is enabled; otherwise the local-disk fallback is used |

Names must match `.env.example`. Sources are defined in the Env contract comments on the Jira tickets (MAG-9). If a required var or its source is missing, DevOps stops and asks — do not guess secrets.

## Triggering deploys manually

- **Preview / production from git (preferred):** open a PR or push/merge to `main` — Vercel deploys automatically.
- **Vercel CLI (optional):**
  ```sh
  npx vercel                # preview deployment
  npx vercel --prod         # production deployment
  ```
  Requires a Vercel token with access to the project. Prefer the git-driven path so CI and previews stay in sync.

## Failing checks and debugging

- CI failures: see the Actions run linked from the PR checks; workspace build errors are attached as `::error` annotations.
- Vercel build failures (incl. missing env / migration errors): open the deployment from the `vercel[bot]` PR comment or the project's Deployments page for full logs.
