/**
 * Stage A — extracting.
 *
 * yt-dlp pulls bestaudio (no YouTube Data API key required), then ffmpeg
 * transcodes to 16 kHz mono WAV for the melody decoder. MAX_VIDEO_SECONDS is
 * enforced against the stream metadata before download.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { ErrorCode } from "@maggybox/contracts";
import { config } from "../config.js";

const require = createRequire(import.meta.url);

function optionalStringModule(id: string): string | null {
  try {
    const mod = require(id) as unknown;
    return typeof mod === "string" ? mod : null;
  } catch {
    return null;
  }
}

function optionalPathModule(id: string): string | null {
  try {
    const mod = require(id) as { path?: string };
    return typeof mod?.path === "string" ? mod.path : null;
  } catch {
    return null;
  }
}

/** Resolve CLI tools from env, npm-bundled binaries, or PATH. */
export function resolveTool(name: "yt-dlp" | "ffmpeg" | "ffprobe"): string {
  if (name === "ffmpeg") {
    return process.env.FFMPEG_BIN || optionalStringModule("ffmpeg-static") || "ffmpeg";
  }
  if (name === "ffprobe") {
    return process.env.FFPROBE_BIN || optionalPathModule("ffprobe-static") || "ffprobe";
  }
  return process.env.YTDLP_BIN || "yt-dlp";
}

/** Drop playlist/radio params so yt-dlp fetches the single public watch URL. */
function canonicalWatchUrl(youtubeUrl: string): string {
  try {
    const parsed = new URL(youtubeUrl);
    const id = parsed.searchParams.get("v");
    if (id) return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    // keep the original string
  }
  return youtubeUrl;
}

/**
 * YouTube now requires a JS challenge solver (EJS). Node is already on the
 * worker host; pass it explicitly so yt-dlp does not fall back to a player
 * client that reports public videos as UNPLAYABLE.
 */
function ytDlpArgs(...extra: string[]): string[] {
  const args = ["--js-runtimes", `node:${process.execPath}`, "--no-playlist", "--no-warnings"];
  const ffmpeg = resolveTool("ffmpeg");
  if (ffmpeg !== "ffmpeg") args.push("--ffmpeg-location", ffmpeg);
  args.push(...extra);
  return args;
}

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
  /this video is private|private video|members-only|removed by the uploader|age.?restricted|not available in your country|premieres? in|account associated with this video has been terminated/i;

function classifyDownloadFailure(stderr: string): PipelineError {
  // "This video is not available" is also what yt-dlp prints when the JS
  // challenge solver is missing — that is DOWNLOAD_FAILED, not a private video.
  const challengeFailed = /js runtime|challenge solver|ejs|player response playability status: unplayable/i.test(
    stderr,
  );
  if (!challengeFailed && VIDEO_UNAVAILABLE_RE.test(stderr)) {
    return new PipelineError("VIDEO_UNAVAILABLE", "Video is unavailable or access-restricted");
  }
  if (!challengeFailed && /video unavailable|video is not available/i.test(stderr)) {
    return new PipelineError("VIDEO_UNAVAILABLE", "Video is unavailable or access-restricted");
  }
  return new PipelineError("DOWNLOAD_FAILED", `yt-dlp failed: ${stderr.slice(-300).trim()}`);
}

async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      resolveTool("ffprobe"),
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
  const watchUrl = canonicalWatchUrl(youtubeUrl);

  // 1) Metadata + duration (also fails fast for unavailable/private videos).
  let info: { duration?: number; title?: string };
  try {
    const { stdout } = await run(
      resolveTool("yt-dlp"),
      ytDlpArgs("--dump-single-json", watchUrl),
      120_000,
    );
    info = JSON.parse(stdout) as { duration?: number; title?: string };
  } catch (err) {
    if (err instanceof PipelineError && /yt-dlp/i.test(err.message)) {
      throw classifyDownloadFailure(err.message);
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
    await run(
      resolveTool("yt-dlp"),
      ytDlpArgs("-f", "bestaudio/best", "-o", path.join(workDir, "source.%(ext)s"), watchUrl),
    );
  } catch (err) {
    if (err instanceof PipelineError && /yt-dlp/i.test(err.message)) {
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

  // 3) Transcode to 16 kHz mono WAV (CREPE / melody decoder native rate).
  const wavPath = path.join(workDir, "audio.wav");
  try {
    await run(resolveTool("ffmpeg"), ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", wavPath], 10 * 60 * 1000);
  } catch (err) {
    if (err instanceof PipelineError) {
      throw new PipelineError("DOWNLOAD_FAILED", `ffmpeg transcode failed: ${err.message}`);
    }
    throw err;
  }

  return { wavPath, durationSec, title: info.title ?? null };
}
