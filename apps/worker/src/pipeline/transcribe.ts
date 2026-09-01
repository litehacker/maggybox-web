/**
 * Stage B — transcribing.
 *
 * Preferred engine: Spotify Basic Pitch (ICASSP 2022) with deterministic
 * accompaniment filtering. pYIN and the basic-pitch CLI remain fallbacks.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import { PipelineError } from "./extract.js";

export interface TranscribeResult {
  midi: Buffer;
  method: "melody-decoder" | "librosa-pyin" | "basic-pitch";
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
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
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

/**
 * basic-pitch CLI (spotify/basic-pitch): `basic-pitch <output-dir> <audio>`,
 * writes `<name>_basic_pitch.mid` into the output dir. Last-resort only.
 */
async function basicPitch(wavPath: string, workDir: string): Promise<Buffer | null> {
  const pythonBin = config.pythonBin;
  if (!(await pythonHasModule(pythonBin, "basic_pitch"))) return null;

  const outDir = path.join(workDir, "basic-pitch");
  await mkdir(outDir, { recursive: true });

  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: pythonBin, args: ["-m", "basic_pitch.predict", "--model-serialization", "onnx", outDir, wavPath] },
    { cmd: "basic-pitch", args: ["--model-serialization", "onnx", outDir, wavPath] },
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
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new PipelineError("TRANSCRIPTION_FAILED", `basic-pitch failed: ${lastError ?? "unknown error"}`);
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
  return { midi, method: "melody-decoder" };
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
    console.error("[worker] pYIN fallback failed, trying basic-pitch:", message);
  }

  const midi = await basicPitch(wavPath, workDir);
  if (!midi) {
    throw new PipelineError(
      "TRANSCRIPTION_FAILED",
      "No transcription backend available: melody decoder, pYIN, and basic-pitch all failed",
    );
  }
  return { midi, method: "basic-pitch" };
}
