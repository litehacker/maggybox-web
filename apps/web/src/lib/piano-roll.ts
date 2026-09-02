/**
 * Piano-roll model for transcribed MIDI.
 *
 * The worker writes two internally monophonic MIDI tracks: Lead Melody and
 * Lower Accompaniment. Playback and display intentionally flatten both tracks
 * into one time-ordered collection of piano key presses.
 *
 * Display: vertical = piano key (high notes at the top), horizontal = time.
 * Every transcribed note is a pin. Nothing is dropped or dual-coded.
 */

export const PIANO_LOW_MIDI = 21; // A0
export const PIANO_HIGH_MIDI = 108; // C8

export type SourceNote = {
  midi: number;
  startSec: number;
  endSec: number;
  /** 0–1 gain from MIDI velocity; omitted notes play at a default. */
  velocity?: number;
};

export type RollNote = SourceNote & {
  name: string;
};

export type PianoRoll = {
  durationSec: number;
  notes: RollNote[];
  minMidi: number;
  maxMidi: number;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export function midiToName(midi: number): string {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(midi) % 12) + 12) % 12);
}

export function clampPianoMidi(midi: number): number {
  return Math.min(PIANO_HIGH_MIDI, Math.max(PIANO_LOW_MIDI, Math.round(midi)));
}

export function buildPianoRoll(notes: SourceNote[], durationSec: number): PianoRoll {
  const mapped: RollNote[] = notes.map((n) => {
    const midi = clampPianoMidi(n.midi);
    return {
      midi,
      startSec: Math.max(0, n.startSec),
      endSec: Math.max(n.startSec, n.endSec),
      name: midiToName(midi),
      velocity: n.velocity,
    };
  });

  const totalSec =
    durationSec > 0 ? durationSec : Math.max(1, ...mapped.map((n) => n.endSec), 0);

  const pitches = mapped.map((n) => n.midi);
  const minMidi = pitches.length ? Math.max(PIANO_LOW_MIDI, Math.min(...pitches) - 2) : 60;
  const maxMidi = pitches.length ? Math.min(PIANO_HIGH_MIDI, Math.max(...pitches) + 2) : 72;

  return { durationSec: totalSec, notes: mapped, minMidi, maxMidi };
}
