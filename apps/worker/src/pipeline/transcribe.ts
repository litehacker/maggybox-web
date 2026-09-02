/**
 * Stage B — transcribing.
 *
 * A fixed MDX vocal separator improves Spotify Basic Pitch (ICASSP 2022)
 * lead candidates. Candidates are deterministically split into Lead Melody
 * and Lower Accompaniment tracks. Full-mix Basic Pitch and pYIN are fallbacks.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import { PipelineError, resolveTool } from "./extract.js";

export interface TranscribeResult {
  midi: Buffer;
  method: "two-voice-decoder" | "librosa-pyin";
}

function pythonDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "python");
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 30 * 60 * 1000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FFMPEG_BIN: resolveTool("ffmpeg"),
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
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

async function runPythonScript(
  scriptName: string,
  wavPath: string,
  outPath: string,
): Promise<Buffer> {
  const scriptPath = path.join(pythonDir(), scriptName);
  const { code, stderr } = await run(config.pythonBin, [scriptPath, wavPath, outPath]);
  if (code !== 0) {
    const detail = stderr.slice(-300).trim() || `exit ${code}`;
    throw new PipelineError("TRANSCRIPTION_FAILED", `${scriptName} failed: ${detail}`);
  }
  return readFile(outPath);
}

async function melodyDecoder(
  wavPath: string,
  workDir: string,
): Promise<TranscribeResult> {
  const hasLibrosa = await pythonHasModule(config.pythonBin, "librosa");
  const hasPrettyMidi = await pythonHasModule(config.pythonBin, "pretty_midi");
  if (!hasLibrosa || !hasPrettyMidi) {
    throw new PipelineError(
      "TRANSCRIPTION_FAILED",
      "Melody decoder requires librosa + pretty_midi",
    );
  }
  const midi = await runPythonScript(
    "melody_transcribe.py",
    wavPath,
    path.join(workDir, "melody.mid"),
  );
  return { midi, method: "two-voice-decoder" };
}

async function librosaFallback(wavPath: string, workDir: string): Promise<Buffer> {
  const hasLibrosa = await pythonHasModule(config.pythonBin, "librosa");
  const hasPrettyMidi = await pythonHasModule(config.pythonBin, "pretty_midi");
  if (!hasLibrosa || !hasPrettyMidi) {
    throw new PipelineError(
      "TRANSCRIPTION_FAILED",
      "No transcription backend available: install librosa + pretty_midi",
    );
  }
  return runPythonScript("fallback_transcribe.py", wavPath, path.join(workDir, "fallback.mid"));
}

export async function transcribeToMidi(
  wavPath: string,
  workDir: string,
): Promise<TranscribeResult> {
  try {
    return await melodyDecoder(wavPath, workDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[worker] melody decoder failed, trying pYIN fallback:", message);
  }

  try {
    const midi = await librosaFallback(wavPath, workDir);
    return { midi, method: "librosa-pyin" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(
      "TRANSCRIPTION_FAILED",
      `Two-voice decoder and pYIN fallback failed: ${message}`,
    );
  }
}
