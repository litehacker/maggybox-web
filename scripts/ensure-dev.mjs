/**
 * Local-dev bootstrap: env files, Postgres, migrations, worker Python tools.
 * Invoked as `predev` so `npm run dev` is enough to start the full stack.
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const LOCAL_DATABASE_URL = "postgresql://maggybox:maggybox@localhost:5432/maggybox";

const LOCAL_ENV = `# Local development — Postgres via Docker
DATABASE_URL=${LOCAL_DATABASE_URL}
DIRECT_URL=${LOCAL_DATABASE_URL}

LOCAL_STORAGE_DIR=./.data/artifacts
STORAGE_SIGNING_SECRET=local-dev-signing-secret

WORKER_POLL_INTERVAL_MS=2000
MAX_VIDEO_SECONDS=600
PYTHON_BIN=python

APP_BASE_URL=http://localhost:3000
`;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    ...opts,
  });
  return result.status === 0;
}

function silent(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "ignore" });
  return result.status === 0;
}

function ensureEnvFiles() {
  const rootEnv = resolve(root, ".env");
  if (!existsSync(rootEnv)) {
    const example = resolve(root, ".env.example");
    if (existsSync(example)) copyFileSync(example, rootEnv);
    else writeFileSync(rootEnv, LOCAL_ENV);
  }

  const webEnv = resolve(root, "apps/web/.env.local");
  if (!existsSync(webEnv)) {
    writeFileSync(
      webEnv,
      [
        `DATABASE_URL=${LOCAL_DATABASE_URL}`,
        `DIRECT_URL=${LOCAL_DATABASE_URL}`,
        "LOCAL_STORAGE_DIR=./.data/artifacts",
        "STORAGE_SIGNING_SECRET=local-dev-signing-secret",
        "APP_BASE_URL=http://localhost:3000",
        "",
      ].join("\n"),
    );
  }
}

function ensurePostgres() {
  if (silent("docker", ["start", "maggybox-postgres"])) {
    console.log("[dev] Postgres container started");
  } else if (!run("docker", ["compose", "up", "-d", "postgres"])) {
    console.error("[dev] Could not start Postgres. Is Docker Desktop running?");
    process.exit(1);
  }

  for (let i = 0; i < 30; i += 1) {
    if (silent("docker", ["exec", "maggybox-postgres", "pg_isready", "-U", "maggybox", "-d", "maggybox"])) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  console.error("[dev] Postgres did not become ready");
  process.exit(1);
}

function ensurePythonTools() {
  if (silent("python", ["-c", "import yt_dlp, yt_dlp_ejs, basic_pitch, librosa, pretty_midi, soundfile"])) {
    return;
  }
  console.log("[dev] Installing worker Python packages (yt-dlp, librosa, pretty_midi)…");
  if (!run("python", ["-m", "pip", "install", "-r", "apps/worker/python/requirements.txt"])) {
    console.warn(
      "[dev] Python worker deps failed. Transcription will not run until you install:\n" +
        "  python -m pip install -r apps/worker/python/requirements.txt",
    );
  }
}

ensureEnvFiles();
ensurePostgres();

if (
  !run("npx", [
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "packages/db/prisma/schema.prisma",
  ])
) {
  process.exit(1);
}

ensurePythonTools();
console.log("[dev] Local stack is ready");
