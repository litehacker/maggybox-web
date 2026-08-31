"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildPianoRoll,
  isBlackKey,
  midiToName,
  type PianoRoll,
  type SourceNote,
} from "@/lib/piano-roll";
import { getSampledPiano, scheduleOscillatorNotes, type PianoSynth } from "@/lib/piano-synth";

type MidiPlayerProps = {
  src: string;
  durationSec?: number | null;
};

function collectNotes(midi: {
  tracks: Array<{ notes: Array<{ midi: number; time: number; duration: number; velocity?: number }> }>;
}): SourceNote[] {
  const notes: SourceNote[] = [];
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.push({
        midi: note.midi,
        startSec: note.time,
        endSec: note.time + note.duration,
        velocity: note.velocity,
      });
    }
  }
  return notes;
}

function drawRoll(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  model: PianoRoll,
  playheadSec: number | null,
) {
  const left = 44;
  const bottom = 22;
  const top = 8;
  const right = 8;
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, height - top - bottom);
  const rows = model.maxMidi - model.minMidi + 1;
  const cellH = plotH / rows;
  const duration = Math.max(model.durationSec, 0.001);

  ctx.clearRect(0, 0, width, height);

  for (let midi = model.minMidi; midi <= model.maxMidi; midi += 1) {
    const rowFromTop = model.maxMidi - midi;
    const y = top + rowFromTop * cellH;
    ctx.fillStyle = isBlackKey(midi) ? "hsl(240 12% 92%)" : "hsl(40 33% 98%)";
    ctx.fillRect(left, y, plotW, cellH);
    if (midi % 12 === 0) {
      ctx.fillStyle = "hsl(240 12% 88%)";
      ctx.fillRect(left, y + cellH - 1, plotW, 1);
    }
  }

  ctx.fillStyle = "hsl(240 12% 88%)";
  ctx.fillRect(left, top, 1, plotH);

  for (const note of model.notes) {
    const rowFromTop = model.maxMidi - note.midi;
    const x = left + (note.startSec / duration) * plotW;
    const w = Math.max(3, ((note.endSec - note.startSec) / duration) * plotW);
    const y = top + rowFromTop * cellH;
    const active =
      playheadSec !== null && playheadSec >= note.startSec && playheadSec < note.endSec;
    ctx.fillStyle = active ? "hsl(262 70% 48%)" : "hsl(262 55% 62%)";
    ctx.beginPath();
    ctx.roundRect(x, y + 1, w, Math.max(2, cellH - 2), 2);
    ctx.fill();
  }

  if (playheadSec !== null) {
    const x = left + (Math.min(playheadSec, duration) / duration) * plotW;
    ctx.strokeStyle = "hsl(262 70% 40%)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
  }

  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let midi = model.minMidi; midi <= model.maxMidi; midi += 1) {
    if (midi % 12 !== 0) continue;
    const rowFromTop = model.maxMidi - midi;
    ctx.fillStyle = "hsl(230 10% 42%)";
    ctx.fillText(midiToName(midi), left - 6, top + (rowFromTop + 0.5) * cellH);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "hsl(230 10% 42%)";
  const ticks = Math.min(8, Math.max(2, Math.ceil(duration)));
  for (let i = 0; i <= ticks; i += 1) {
    const t = (i / ticks) * duration;
    ctx.fillText(`${t.toFixed(0)}s`, left + (t / duration) * plotW, top + plotH + 6);
  }
}

export function MidiPlayer({ src, durationSec }: MidiPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const pianoRef = useRef<PianoSynth | null>(null);
  const rafRef = useRef<number | null>(null);
  const startAtRef = useRef(0);
  const wallStartRef = useRef(0);
  const modelRef = useRef<PianoRoll | null>(null);
  const midiNotesRef = useRef<SourceNote[]>([]);

  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<PianoRoll | null>(null);
  const [nowSec, setNowSec] = useState(0);

  function paint(playheadSec: number | null) {
    const canvas = canvasRef.current;
    const roll = modelRef.current;
    if (!canvas || !roll) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoll(ctx, width, height, roll, playheadSec);
  }

  function elapsedSec(): number {
    if (pianoRef.current) return pianoRef.current.now() - startAtRef.current;
    if (audioRef.current) return audioRef.current.currentTime - startAtRef.current;
    return (performance.now() - wallStartRef.current) / 1000;
  }

  function stop() {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pianoRef.current?.stopAll();
    void audioRef.current?.close();
    audioRef.current = null;
    setPlaying(false);
    setNowSec(0);
    paint(null);
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function load() {
      setError(null);
      try {
        const [{ Midi }, response] = await Promise.all([import("@tonejs/midi"), fetch(src, { signal: controller.signal })]);
        if (!response.ok) throw new Error("MIDI is not ready yet.");
        const midi = new Midi(await response.arrayBuffer());
        const notes = collectNotes(midi);
        const next = buildPianoRoll(notes, durationSec ?? midi.duration);
        if (!active) return;
        midiNotesRef.current = notes;
        modelRef.current = next;
        setModel(next);
        requestAnimationFrame(() => paint(null));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load this MIDI file.");
      }
    }

    void load();
    return () => {
      active = false;
      controller.abort();
      stop();
    };
  }, [src, durationSec]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const playhead = playing ? elapsedSec() : null;
      paint(playhead !== null && playhead >= 0 ? playhead : null);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [model, playing]);

  async function play() {
    const roll = modelRef.current;
    if (!roll) return;
    setLoading(true);
    setError(null);
    try {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      pianoRef.current?.stopAll();
      void audioRef.current?.close();
      audioRef.current = null;

      let piano: PianoSynth | null = null;
      try {
        piano = await getSampledPiano();
      } catch {
        piano = null;
      }

      wallStartRef.current = performance.now();
      if (piano) {
        pianoRef.current = piano;
        const startAt = piano.now() + 0.08;
        startAtRef.current = startAt;
        for (const note of midiNotesRef.current) {
          piano.keyDown({ midi: note.midi, time: startAt + note.startSec, velocity: note.velocity });
          piano.keyUp({ midi: note.midi, time: startAt + Math.max(note.endSec, note.startSec + 0.05) });
        }
      } else {
        pianoRef.current = null;
        const context = new AudioContext();
        audioRef.current = context;
        try {
          if (context.state === "suspended") await context.resume();
        } catch {
          // Autoplay policies can keep the context suspended; the grid still runs on wall clock.
        }
        const audioReady = context.state === "running";
        const startAt = audioReady ? context.currentTime + 0.08 : 0;
        startAtRef.current = startAt;
        if (audioReady) scheduleOscillatorNotes(context, midiNotesRef.current, startAt);
      }

      setPlaying(true);

      const tick = () => {
        const elapsed = elapsedSec();
        if (elapsed >= roll.durationSec) {
          stop();
          return;
        }
        setNowSec(Math.max(0, elapsed));
        paint(elapsed >= 0 ? elapsed : 0);
        rafRef.current = window.requestAnimationFrame(tick);
      };
      rafRef.current = window.requestAnimationFrame(tick);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview this MIDI file.");
      stop();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold">Piano roll</p>
          <p className="text-sm text-muted-foreground">
            {model
              ? `${model.notes.length} pin${model.notes.length === 1 ? "" : "s"} · vertical is the piano key, horizontal is when it is pressed`
              : "Loading the transcribed notes…"}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={playing ? stop : play} disabled={loading || !model} aria-label={playing ? "Stop MIDI preview" : "Play MIDI preview"}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {loading ? "Loading piano…" : playing ? "Stop" : "Play"}
        </Button>
      </div>

      <div ref={wrapRef} className="relative h-56 w-full sm:h-72">
        <canvas ref={canvasRef} className="h-full w-full" role="img" aria-label="Piano roll: pitch on the vertical axis, press time on the horizontal axis" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {playing
            ? `${nowSec.toFixed(1)}s / ${model?.durationSec.toFixed(1) ?? "0.0"}s`
            : model
              ? `${midiToName(model.minMidi)} – ${midiToName(model.maxMidi)}`
              : ""}
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" /> pin
        </span>
      </div>

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
