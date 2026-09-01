/**
 * MaggyBox transcription worker.
 *
 * Single long-lived Node process, concurrency = 1. Polls Postgres for the
 * oldest queued job (SKIP LOCKED claim), then runs:
 *   A. extracting          — yt-dlp bestaudio → ffmpeg 22.05 kHz mono WAV
 *   B. transcribing        — Basic Pitch → deterministic melody MIDI
 *   C. generating_cylinder — MIDI → quantized pinned-drum STL
 *
 * Source audio is transient and deleted after transcription; only MIDI + STL
 * artifacts are persisted to object storage.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ErrorCode } from "@maggybox/contracts";
import { getStorage } from "./storage.js";
import { config } from "./config.js";
import {
  claimJob,
  completeJob,
  failJob,
  setMetadata,
  setMidiArtifact,
  setProgress,
} from "./queue.js";
import { extractAudio, PipelineError, resolveTool } from "./pipeline/extract.js";
import { transcribeToMidi } from "./pipeline/transcribe.js";
import { buildCylinderSpec, generateCylinderStl, parseMidiNotes } from "./pipeline/cylinder.js";

async function processJob(jobId: string, youtubeUrl: string): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), `maggybox-${jobId}-`));
  try {
    // ---- Stage A: extracting -------------------------------------------
    await setProgress(jobId, "extracting", 10);
    const audio = await extractAudio(youtubeUrl, workDir);
    await setMetadata(jobId, { title: audio.title, durationSec: audio.durationSec });
    await setProgress(jobId, "extracting", 25);

    // ---- Stage B: transcribing -----------------------------------------
    await setProgress(jobId, "transcribing", 35);
    const { midi, method } = await transcribeToMidi(audio.wavPath, workDir);
    console.log(`[worker] job ${jobId}: transcribed via ${method} (${midi.byteLength} bytes)`);

    const storage = getStorage();
    const midiKey = `midi/${jobId}.mid`;
    await storage.put(midiKey, midi, "audio/midi");
    await setMidiArtifact(jobId, midiKey, midi.byteLength);
    await setProgress(jobId, "transcribing", 60);

    // ---- Stage C: generating_cylinder ----------------------------------
    await setProgress(jobId, "generating_cylinder", 70);
    const notes = parseMidiNotes(midi);
    const spec = buildCylinderSpec(notes, audio.durationSec);
    const stl = generateCylinderStl(spec);
    const stlKey = `stl/${jobId}.stl`;
    await storage.put(stlKey, stl, "model/stl");

    await completeJob(jobId, {
      stlKey,
      stlBytes: stl.byteLength,
      cylinderSpecId: spec.id,
    });
    console.log(`[worker] job ${jobId}: done (${spec.pins.length} pins)`);
  } finally {
    // Source audio is transient — never persisted.
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runJob(job: { id: string; youtubeUrl: string }): Promise<void> {
  try {
    await processJob(job.id, job.youtubeUrl);
  } catch (err) {
    const code: ErrorCode = err instanceof PipelineError ? err.code : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${job.id} failed: ${code} — ${message}`);
    await failJob(job.id, code, message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  console.log(
    `[worker] started (poll=${config.pollIntervalMs}ms, maxVideo=${config.maxVideoSeconds}s, storage=${getStorage().driver})`,
  );
  console.log(
    `[worker] tools yt-dlp=${resolveTool("yt-dlp")} ffmpeg=${resolveTool("ffmpeg")} python=${config.pythonBin}`,
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let job: { id: string; youtubeUrl: string } | null = null;
    try {
      job = await claimJob();
    } catch (err) {
      console.error("[worker] claim failed:", err instanceof Error ? err.message : err);
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!job) {
      await sleep(config.pollIntervalMs);
      continue;
    }
    // Concurrency = 1: process synchronously before polling again.
    await runJob(job);
  }
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
