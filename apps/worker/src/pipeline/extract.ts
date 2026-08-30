/**
 * Stage A — extracting.
 *
 * yt-dlp pulls bestaudio (no YouTube Data API key required), then ffmpeg
 * transcodes to 22.05 kHz mono WAV for transcription. MAX_VIDEO_SECONDS is
 * enforced against the stream metadata before download.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { ErrorCode } from "@maggybox/contracts";
import { config } from "../config.js";

export class PipelineError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface ExtractResult {
  wavPath: string;
  durationSec: number;
  title: string | null;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 15 * 60 * 1000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new PipelineError("DOWNLOAD_FAILED", `${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new PipelineError("DOWNLOAD_FAILED", `Required tool "${cmd}" is not installed`));
      } else {
        reject(new PipelineError("DOWNLOAD_FAILED", `${cmd} failed to start: ${err.message}`));
      }
    });
    child.on("close", (code_) => {
      clearTimeout(timer);
      if (code_ === 0) resolve({ stdout, stderr });
      else reject(new PipelineError("DOWNLOAD_FAILED", `${cmd} exited with code ${code_}: ${stderr.slice(-500)}`));
    });
  });
}

const VIDEO_UNAVAILABLE_RE =
  /video unavailable|private video|sign in to confirm|members-only|removed by the uploader|age.?restricted|not available in your country|premieres? in/i;

function classifyDownloadFailure(stderr: string): PipelineError {
  if (VIDEO_UNAVAILABLE_RE.test(stderr)) {
    return new PipelineError("VIDEO_UNAVAILABLE", "Video is unavailable or access-restricted");
  }
  return new PipelineError("DOWNLOAD_FAILED", `yt-dlp failed: ${stderr.slice(-300).trim()}`);
}

async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      60_000,
    );
    const d = Number(stdout.trim());
    return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  } catch {
    return null;
  }
}

export async function extractAudio(youtubeUrl: string, workDir: string): Promise<ExtractResult> {
  await mkdir(workDir, { recursive: true });

  // 1) Metadata + duration (also fails fast for unavailable/private videos).
  let info: { duration?: number; title?: string };
  try {
    const { stdout } = await run(
      "yt-dlp",
      ["--dump-single-json", "--no-warnings", "--no-playlist", youtubeUrl],
      120_000,
    );
    info = JSON.parse(stdout) as { duration?: number; title?: string };
  } catch (err) {
    if (err instanceof PipelineError) {
      // Re-classify raw yt-dlp failures; run() tagged them DOWNLOAD_FAILED.
      const isYtdlp = err.message.startsWith("yt-dlp");
      if (isYtdlp && !VIDEO_UNAVAILABLE_RE.test(err.message)) {
        throw classifyDownloadFailure(err.message);
      }
    }
    throw err;
  }

  let durationSec = Number.isFinite(info.duration) ? Math.round(Number(info.duration)) : 0;
  if (durationSec > 0 && durationSec > config.maxVideoSeconds) {
    throw new PipelineError(
      "VIDEO_TOO_LONG",
      `Video is ${durationSec}s long; maximum is ${config.maxVideoSeconds}s`,
    );
  }

  // 2) Download bestaudio to the transient work dir.
  try {
    await run("yt-dlp", [
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      "-o",
      path.join(workDir, "source.%(ext)s"),
      youtubeUrl,
    ]);
  } catch (err) {
    if (err instanceof PipelineError && err.message.startsWith("yt-dlp")) {
      throw classifyDownloadFailure(err.message);
    }
    throw err;
  }

  const entries = await readdir(workDir);
  const source = entries.find((f) => f.startsWith("source.") && !f.endsWith(".part"));
  if (!source) {
    throw new PipelineError("DOWNLOAD_FAILED", "yt-dlp produced no audio file");
  }
  const sourcePath = path.join(workDir, source);

  if (durationSec <= 0) {
    durationSec = (await probeDurationSec(sourcePath)) ?? 0;
    if (durationSec > config.maxVideoSeconds) {
      throw new PipelineError(
        "VIDEO_TOO_LONG",
        `Video is ${durationSec}s long; maximum is ${config.maxVideoSeconds}s`,
      );
    }
  }

  // 3) Transcode to 22.05 kHz mono WAV (transcription input format).
  const wavPath = path.join(workDir, "audio.wav");
  try {
    await run("ffmpeg", ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "22050", wavPath], 10 * 60 * 1000);
  } catch (err) {
    if (err instanceof PipelineError) {
      throw new PipelineError("DOWNLOAD_FAILED", `ffmpeg transcode failed: ${err.message}`);
    }
    throw err;
  }

  return { wavPath, durationSec, title: info.title ?? null };
}
