/** Worker configuration — everything comes from the environment. */

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
  pythonBin: process.env.PYTHON_BIN ?? "python3",
  /** Lowest MIDI note on the reference music-box comb (C3). */
  combLowMidi: intFromEnv("MUSIC_BOX_COMB_LOW_MIDI", 48),
} as const;
