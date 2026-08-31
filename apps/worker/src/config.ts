/** Worker configuration — everything comes from the environment. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnv(): void {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const files = [
    resolve(here, "../../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

loadEnv();

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  /** Postgres poll interval for the job loop. */
  pollIntervalMs: intFromEnv("WORKER_POLL_INTERVAL_MS", 2000),
  /** Hard cap on source video length in seconds. */
  maxVideoSeconds: intFromEnv("MAX_VIDEO_SECONDS", 600),
  /** Python interpreter used to invoke basic-pitch / librosa. */
  pythonBin: process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
  /** Lowest MIDI note on the reference music-box comb (C3). */
  combLowMidi: intFromEnv("MUSIC_BOX_COMB_LOW_MIDI", 48),
} as const;
