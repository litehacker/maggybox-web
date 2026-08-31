/**
 * Sampled piano for MIDI preview (Salamander Grand via @tonejs/piano).
 * Lazy-loaded once per page and reused across play/stop.
 */

export type ScheduledNote = {
  midi: number;
  startSec: number;
  endSec: number;
  velocity?: number;
};

export type PianoSynth = {
  now: () => number;
  keyDown: (note: { midi: number; time?: number; velocity?: number }) => void;
  keyUp: (note: { midi: number; time?: number }) => void;
  stopAll: () => void;
};

let pianoPromise: Promise<PianoSynth> | null = null;

function clampVelocity(velocity: number | undefined): number {
  if (velocity == null || Number.isNaN(velocity)) return 0.7;
  const unit = velocity > 1 ? velocity / 127 : velocity;
  return Math.min(1, Math.max(0.05, unit));
}

export async function getSampledPiano(): Promise<PianoSynth> {
  if (!pianoPromise) {
    pianoPromise = loadPiano().catch((err) => {
      pianoPromise = null;
      throw err;
    });
  }
  return pianoPromise;
}

async function loadPiano(): Promise<PianoSynth> {
  const Tone = await import("tone");
  const { Piano } = await import("@tonejs/piano");
  await Tone.start();
  const piano = new Piano({ velocities: 1, release: true, pedal: false, minNote: 36, maxNote: 96 });
  piano.toDestination();
  await piano.load();
  return {
    now: () => Tone.now(),
    keyDown: (note) => {
      piano.keyDown({ midi: note.midi, time: note.time, velocity: clampVelocity(note.velocity) });
    },
    keyUp: (note) => {
      piano.keyUp({ midi: note.midi, time: note.time });
    },
    stopAll: () => {
      piano.stopAll();
    },
  };
}

/** Cheap triangle fallback if Salamander samples fail to load. */
export function scheduleOscillatorNotes(
  context: AudioContext,
  notes: ScheduledNote[],
  startAt: number,
): void {
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const begins = startAt + note.startSec;
    const ends = startAt + Math.max(note.endSec, note.startSec + 0.05);
    const peak = 0.04 + 0.05 * clampVelocity(note.velocity);
    oscillator.type = "triangle";
    oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);
    gain.gain.setValueAtTime(0.0001, begins);
    gain.gain.exponentialRampToValueAtTime(peak, begins + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ends);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(begins);
    oscillator.stop(ends + 0.02);
  }
}
