/**
 * Stage C — generating_cylinder.
 *
 * Reads the transcribed MIDI, quantizes notes onto the reference music-box
 * comb, and emits a printable pinned-drum STL. Ported from the legacy
 * litehacker/maggybox MaggyBox-stl-maker.c with the same physical parameters:
 *
 *   RADIUS 5 mm, HEIGHT 63 mm, EDGES 40 (max pins per song / time slots),
 *   61-pitch comb mapping, pins offset +2 mm from the drum base and 1 mm
 *   wide (legacy pin_needed(i)+2 … +3), radial protrusion 1 mm (r → r+1).
 *
 * Mapping:
 *   time  → cylinder rotation angle (slot index, EDGES around the drum)
 *   pitch → axial pin position (comb index from the drum base)
 */
import { parseMidi } from "midi-file";
import { createHash } from "node:crypto";

import { config } from "../config.js";
import { PipelineError } from "./extract.js";

/** Physical parameters from the legacy C generator (mm). */
export const CYLINDER = {
  RADIUS: 5,
  HEIGHT: 63,
  EDGES: 40,
  PITCHES: 61,
  PIN_BASE_OFFSET: 2, // axial offset of pin base from bottom (legacy +2)
  PIN_AXIAL_WIDTH: 1, // axial pin width (legacy +2 → +3)
  PIN_PROTRUSION: 1, // radial protrusion (legacy r → r+1)
  SLOT_COVERAGE: 0.6, // fraction of a slot's angle occupied by a pin
} as const;

export interface ParsedNote {
  midiNote: number;
  startSec: number;
  endSec: number;
}

export interface CylinderPin {
  slot: number;
  combIndex: number;
  midiNote: number;
  startSec: number;
}

export interface CylinderSpec {
  id: string;
  version: string;
  radiusMm: number;
  heightMm: number;
  edges: number;
  pitches: number;
  combLowMidi: number;
  durationSec: number;
  pins: CylinderPin[];
}

/* ------------------------------------------------------------------ */
/* MIDI parsing                                                        */
/* ------------------------------------------------------------------ */

interface TempoChange {
  tick: number;
  usPerQuarter: number;
}

/**
 * The midi-file typings omit `tick` — parseMidi adds it at runtime — so the
 * parsed events are widened to a local shape that carries it explicitly
 * (fixes the TS2339/TS2352 build errors on the unparsed event union).
 */
interface MidiEvent {
  type: string;
  tick: number;
  microsecondsPerQuarter?: number;
  velocity?: number;
  noteNumber?: number;
  channel?: number;
}

export function parseMidiNotes(data: Buffer): ParsedNote[] {
  const parsed = parseMidi(data);
  const ticksPerBeat = parsed.header.ticksPerBeat || 480;
  const tracks = parsed.tracks as unknown as MidiEvent[][];

  // Collect tempo changes across all tracks, sorted by absolute tick.
  const tempos: TempoChange[] = [{ tick: 0, usPerQuarter: 500_000 }]; // default 120 BPM
  for (const track of tracks) {
    for (const ev of track) {
      if (ev.type === "setTempo" && typeof ev.microsecondsPerQuarter === "number") {
        tempos.push({ tick: ev.tick, usPerQuarter: ev.microsecondsPerQuarter });
      }
    }
  }
  tempos.sort((a, b) => a.tick - b.tick);

  // Absolute tick → seconds via the tempo map.
  function tickToSec(tick: number): number {
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      const startTick = tempos[i].tick;
      const endTick = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
      if (tick <= startTick) break;
      const segEnd = Math.min(tick, endTick);
      sec += ((segEnd - startTick) * tempos[i].usPerQuarter) / (ticksPerBeat * 1_000_000);
      if (tick <= endTick) break;
    }
    return sec;
  }

  const notes: ParsedNote[] = [];
  for (const track of tracks) {
    const open = new Map<string, { tick: number; note: number; velocity: number }>();
    for (const ev of track) {
      if (typeof ev.noteNumber !== "number") continue;
      const note = ev.noteNumber;
      const velocity = ev.velocity ?? 90;
      const isNoteOn = ev.type === "noteOn" && velocity > 0;
      const isNoteOff =
        ev.type === "noteOff" || (ev.type === "noteOn" && velocity === 0);
      const ch = ev.channel ?? 0;
      const key = `${ch}:${note}`;

      if (isNoteOn) {
        open.set(key, { tick: ev.tick, note, velocity });
      } else if (isNoteOff) {
        const onEv = open.get(key);
        if (onEv) {
          open.delete(key);
          const startSec = tickToSec(onEv.tick);
          const endSec = Math.max(tickToSec(ev.tick), startSec + 0.01);
          notes.push({ midiNote: note, startSec, endSec });
        }
      }
    }
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Quantization: MIDI → comb + slots                                   */
/* ------------------------------------------------------------------ */

export function buildCylinderSpec(notes: ParsedNote[], durationSec: number): CylinderSpec {
  if (notes.length === 0) {
    throw new PipelineError("CYLINDER_FAILED", "Transcription produced no notes — cannot generate cylinder");
  }

  const combLowMidi = config.combLowMidi;
  const edges = CYLINDER.EDGES;
  const totalSec = durationSec > 0 ? durationSec : Math.max(...notes.map((n) => n.endSec));

  const byKey = new Map<string, CylinderPin>();
  for (const n of notes) {
    const combIndex = n.midiNote - combLowMidi;
    if (combIndex < 0 || combIndex >= CYLINDER.PITCHES) continue; // outside comb range
    const slot = Math.min(edges - 1, Math.floor((n.startSec / totalSec) * edges));
    const key = `${slot}:${combIndex}`;
    if (!byKey.has(key)) {
      byKey.set(key, { slot, combIndex, midiNote: n.midiNote, startSec: Number(n.startSec.toFixed(3)) });
    }
  }

  const pins = [...byKey.values()].sort((a, b) => a.slot - b.slot || a.combIndex - b.combIndex);
  if (pins.length === 0) {
    throw new PipelineError(
      "CYLINDER_FAILED",
      `No notes fall inside the ${CYLINDER.PITCHES}-pitch comb (MIDI ${combLowMidi}–${combLowMidi + CYLINDER.PITCHES - 1})`,
    );
  }

  const hash = createHash("sha1").update(JSON.stringify(pins)).digest("hex").slice(0, 12);
  return {
    id: `mbc-v1-${hash}`,
    version: "mbc-v1",
    radiusMm: CYLINDER.RADIUS,
    heightMm: CYLINDER.HEIGHT,
    edges,
    pitches: CYLINDER.PITCHES,
    combLowMidi,
    durationSec: Math.round(totalSec),
    pins,
  };
}

/* ------------------------------------------------------------------ */
/* STL generation                                                      */
/* ------------------------------------------------------------------ */

type Vec3 = readonly [number, number, number];

const DEG = Math.PI / 180;

function vertex(radius: number, thetaDeg: number, z: number): Vec3 {
  return [radius * Math.cos(thetaDeg * DEG), radius * Math.sin(thetaDeg * DEG), z];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

class StlBuilder {
  private readonly chunks: string[] = ["solid maggybox-cylinder\n"];

  triangle(a: Vec3, b: Vec3, c: Vec3): void {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    const f = (v: Vec3) => `vertex ${v[0]} ${v[1]} ${v[2]}\n`;
    this.chunks.push(
      `facet normal ${n[0]} ${n[1]} ${n[2]}\n outer loop\n ${f(a)} ${f(b)} ${f(c)} endloop\nendfacet\n`,
    );
  }

  /** Two triangles for a quad (a,b,c,d) ordered counter-clockwise from outside. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  finish(): Buffer {
    this.chunks.push("endsolid maggybox-cylinder\n");
    return Buffer.from(this.chunks.join(""), "utf8");
  }
}

function buildDrumBody(stl: StlBuilder): void {
  const { RADIUS, HEIGHT, EDGES } = CYLINDER;
  const step = 360 / EDGES;

  for (let i = 0; i < EDGES; i++) {
    const t0 = i * step;
    const t1 = (i + 1) * step;
    const b0 = vertex(RADIUS, t0, 0);
    const b1 = vertex(RADIUS, t1, 0);
    const t0v = vertex(RADIUS, t0, HEIGHT);
    const t1v = vertex(RADIUS, t1, HEIGHT);

    // Side wall (outward radial normal).
    stl.quad(b0, b1, t1v, t0v);
    // Bottom cap (normal -z).
    stl.triangle([0, 0, 0], b1, b0);
    // Top cap (normal +z).
    stl.triangle([0, 0, HEIGHT], t0v, t1v);
  }
}

function buildPin(stl: StlBuilder, slot: number, combIndex: number): void {
  const { RADIUS, EDGES, PIN_BASE_OFFSET, PIN_AXIAL_WIDTH, PIN_PROTRUSION, SLOT_COVERAGE } = CYLINDER;

  const stepDeg = 360 / EDGES;
  const halfWidth = (SLOT_COVERAGE / 2) * stepDeg;
  const center = (slot + 0.5) * stepDeg;
  const t0 = center - halfWidth;
  const t1 = center + halfWidth;

  const r0 = RADIUS;
  const r1 = RADIUS + PIN_PROTRUSION;
  const z0 = PIN_BASE_OFFSET + combIndex;
  const z1 = z0 + PIN_AXIAL_WIDTH;

  const a0 = vertex(r0, t0, z0); // inner-bottom-left
  const a1 = vertex(r0, t1, z0); // inner-bottom-right
  const b0 = vertex(r1, t0, z0); // outer-bottom-left
  const b1 = vertex(r1, t1, z0); // outer-bottom-right
  const c0 = vertex(r0, t0, z1); // inner-top-left
  const c1 = vertex(r0, t1, z1); // inner-top-right
  const d0 = vertex(r1, t0, z1); // outer-top-left
  const d1 = vertex(r1, t1, z1); // outer-top-right

  stl.quad(a0, a1, b1, b0); // bottom (-z)
  stl.quad(b0, b1, d1, d0); // outer (radial out)
  stl.quad(a1, a0, c0, c1); // inner
  stl.quad(a0, b0, d0, c0); // side at t0 (-tangential)
  stl.quad(a1, c1, d1, b1); // side at t1 (+tangential)
  stl.quad(b0, b1, a1, a0); // top (+z)
}

/** Render the pinned drum as an ASCII STL (units: mm). */
export function generateCylinderStl(spec: CylinderSpec): Buffer {
  const stl = new StlBuilder();
  buildDrumBody(stl);
  for (const pin of spec.pins) buildPin(stl, pin.slot, pin.combIndex);
  return stl.finish();
}
