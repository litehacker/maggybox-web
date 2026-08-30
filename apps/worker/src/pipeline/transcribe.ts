/**
 * Stage B — transcribing.
 *
 * Preferred engine: Spotify basic-pitch (Apache-2.0, polyphonic, CPU, emits
 * MIDI directly), invoked as a Python subprocess.
 *
 * Fallback for melody-dominant material: librosa pyin monophonic pitch track
 * → note segmentation → pretty_midi. Both engines preserve absolute note
 * pitch and timing.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import { PipelineError } from "./extract.js";

export interface TranscribeResult {
  midi: Buffer;
  method: "basic-pitch" | "librosa-pyin";
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 30 * 60 * 1000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function pythonHasModule(pythonBin: string, moduleName: string): Promise<boolean> {
  try {
    const { code } = await run(pythonBin, ["-c", `import ${moduleName}`], 30_000);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * basic-pitch CLI (spotify/basic-pitch): `basic-pitch <output-dir> <audio>`,
 * writes `<name>_basic_pitch.mid` into the output dir. The console script may
 * not be on PATH in all environments, so try it, then `python -m basic_pitch`.
 */
async function basicPitch(wavPath: string, workDir: string): Promise<Buffer | null> {
  const pythonBin = config.pythonBin;
  if (!(await pythonHasModule(pythonBin, "basic_pitch"))) return null;

  const outDir = path.join(workDir, "basic-pitch");
  await mkdir(outDir, { recursive: true });

  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "basic-pitch", args: [outDir, wavPath] },
    { cmd: pythonBin, args: ["-m", "basic_pitch", outDir, wavPath] },
  ];

  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      const { code, stderr } = await run(attempt.cmd, attempt.args);
      if (code === 0) {
        const files = await readdir(outDir);
        const midiFile = files.find((f) => f.toLowerCase().endsWith(".mid"));
        if (!midiFile) {
          throw new PipelineError("TRANSCRIPTION_FAILED", "basic-pitch produced no MIDI file");
        }
        return readFile(path.join(outDir, midiFile));
      }
      lastError = `${attempt.cmd} exited ${code}: ${stderr.slice(-300).trim()}`;
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      // ENOENT etc. — try the next invocation form.
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new PipelineError("TRANSCRIPTION_FAILED", `basic-pitch failed: ${lastError ?? "unknown error"}`);
}

async function librosaFallback(wavPath: string, workDir: string): Promise<Buffer> {
  const pythonBin = config.pythonBin;
  const hasLibrosa = await pythonHasModule(pythonBin, "librosa");
  const hasPrettyMidi = await pythonHasModule(pythonBin, "pretty_midi");
  if (!hasLibrosa || !hasPrettyMidi) {
    throw new PipelineError(
      "TRANSCRIPTION_FAILED",
      "No transcription backend available: install basic-pitch, or librosa + pretty_midi",
    );
  }

  const scriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "python",
    "fallback_transcribe.py",
  );
  const outPath = path.join(workDir, "fallback.mid");
  const { code, stderr } = await run(pythonBin, [scriptPath, wavPath, outPath]);
  if (code !== 0) {
    throw new PipelineError("TRANSCRIPTION_FAILED", `librosa transcription failed: ${stderr.slice(-300).trim()}`);
  }
  return readFile(outPath);
}

export async function transcribeToMidi(wavPath: string, workDir: string): Promise<TranscribeResult> {
  try {
    const midi = await basicPitch(wavPath, workDir);
    if (midi) return { midi, method: "basic-pitch" };
    console.log("[worker] basic-pitch not installed — falling back to librosa pyin");
  } catch (err) {
    if (err instanceof PipelineError && err.code === "TRANSCRIPTION_FAILED") {
      console.error("[worker] basic-pitch failed, trying librosa fallback:", err.message);
    } else {
      throw err;
    }
  }
  return { midi: await librosaFallback(wavPath, workDir), method: "librosa-pyin" };
}
