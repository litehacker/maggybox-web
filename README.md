# MaggyBox

**MaggyBox is an online YouTube → MIDI transcriber that also produces a 3D-printable pinned cylinder for a music box.**

Paste a YouTube URL and MaggyBox extracts the audio, transcribes it to a downloadable MIDI file, and generates a printable pinned-cylinder STL that can be printed and used in a physical music box to replay the transcribed melody — in one flow, without an account.

> Product goal & scope: **Jira MAG-13**. Architecture spec: **Jira MAG-7**.

## Core flow (v1)
`YouTube URL → extract audio → transcribe to MIDI → generate pinned-cylinder STL → preview & download`
Job progress states: `queued → extracting → transcribing → generating_cylinder → done` (or `failed`).

## In scope for v1
1. YouTube URL input; server-side audio extraction and transcription to MIDI.
2. Job model with visible progress states, persisted in Postgres via Prisma.
3. MIDI preview (in-browser) and MIDI download.
4. 3D pinned-cylinder generation from the MIDI (notes → pin layout), downloadable as STL.
5. Web UI (Next.js).
6. Production deployment on Vercel with CI/CD from GitHub.

## Out of scope for v1
- User accounts, sign-in, payments/monetization.
- MIDI editing — playback and download only.
- Non-YouTube sources (file upload, Spotify, etc.).
- Multi-instrument / arrangement support (v1 targets melody-dominant, monophonic-friendly).
- Physical printing/laser-cutting services or hardware.

## Architecture (summary)
- Web (Vercel): Next.js UI + thin API routes.
- Worker (off-Vercel, always-on): yt-dlp + ffmpeg, audio→MIDI (Spotify basic-pitch), MIDI→STL cylinder generation.
- Postgres (+ Prisma): job/state store and v1 job queue (SKIP LOCKED).
- Object storage: MIDI + STL artifacts (DB holds keys only).

Full spec (API contract, data model, deploy topology, env vars): **Jira MAG-7**.

## Local development

```sh
npm install
npm run dev
```

That single command starts Postgres (Docker), applies migrations, installs worker Python tools if needed, then runs the web app and queue worker together. Open http://localhost:3000.

Requires **Docker Desktop**, **Node 20+**, and **Python 3**. ffmpeg is bundled via npm; yt-dlp and the librosa transcription fallback come from `apps/worker/python/requirements.txt`.

Use `npm run dev:web` or `npm run dev:worker` to run one side on its own.

## Repo layout (npm workspaces)

```
maggybox-web/
  apps/
    web/            # Next.js App Router (Vercel): UI + thin API route handlers
    worker/         # off-Vercel container: queue consumer (Node; calls Python subprocess)
  packages/
    db/             # Prisma schema + generated client
    contracts/      # shared TS types + zod schemas: DTOs, status enum, error codes
  .github/workflows/ # CI (install → prisma generate → typecheck → per-workspace build)
```

## Relationship to the legacy `maggybox` repo
`litehacker/maggybox` (2018 C project) generates a custom music-box drum STL from a note matrix (61-note mapping; time → rotation angle; pitch → axial pin position). Preserved as reference/archive — nothing deleted or rewritten. Its geometry algorithm is the starting reference for MaggyBox v1's MIDI→STL step.
