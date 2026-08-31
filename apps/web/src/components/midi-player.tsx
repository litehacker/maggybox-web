"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MidiPlayer({ src }: { src: string }) {
  const audioRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function stop() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    void audioRef.current?.close();
    audioRef.current = null;
    setPlaying(false);
  }

  useEffect(() => stop, []);

  async function play() {
    setLoading(true);
    setError(null);
    try {
      const [{ Midi }, response] = await Promise.all([import("@tonejs/midi"), fetch(src)]);
      if (!response.ok) throw new Error("MIDI is not ready yet.");
      const midi = new Midi(await response.arrayBuffer());
      const context = new AudioContext();
      audioRef.current = context;
      const startAt = context.currentTime + 0.08;
      const previewSeconds = Math.min(midi.duration, 30);

      for (const track of midi.tracks) {
        for (const note of track.notes) {
          if (note.time > previewSeconds) continue;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const begins = startAt + note.time;
          const ends = begins + Math.min(note.duration, 2.5);
          oscillator.type = "triangle";
          oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);
          gain.gain.setValueAtTime(0.0001, begins);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.015, note.velocity * 0.12), begins + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, ends);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(begins);
          oscillator.stop(ends + 0.02);
        }
      }

      setPlaying(true);
      timerRef.current = window.setTimeout(stop, (previewSeconds + 0.2) * 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview this MIDI file.");
      stop();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border bg-muted/40 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-semibold">MIDI preview</p>
          <p className="text-sm text-muted-foreground">Listen to the first 30 seconds in your browser.</p>
        </div>
        <Button type="button" variant="outline" onClick={playing ? stop : play} disabled={loading} aria-label={playing ? "Stop MIDI preview" : "Play MIDI preview"}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {loading ? "Loading…" : playing ? "Stop" : "Play"}
        </Button>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
