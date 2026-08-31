"use client";

import { useEffect, useState } from "react";
import { MidiPlayer } from "@/components/midi-player";

export default function PianoRollPreviewPage() {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;

    async function build() {
      const { Midi } = await import("@tonejs/midi");
      const midi = new Midi();
      midi.header.setTempo(120);
      const track = midi.addTrack();
      track.instrument.number = 0;
      const scale = [60, 62, 64, 65, 67, 69, 71, 72];
      scale.forEach((pitch, index) => {
        track.addNote({
          midi: pitch,
          time: index * 0.45,
          duration: 0.4,
          velocity: 0.55 + (index % 4) * 0.1,
        });
      });
      for (let i = 0; i < 3; i += 1) {
        track.addNote({ midi: 60, time: 3.8 + i * 0.28, duration: 0.18, velocity: 0.85 });
      }
      const encoded = midi.toArray();
      const blob = new Blob([encoded as BlobPart], { type: "audio/midi" });
      objectUrl = URL.createObjectURL(blob);
      if (!cancelled) setSrc(objectUrl);
    }

    void build();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-10">
      <h1 className="text-2xl font-bold">Piano roll preview</h1>
      <p className="text-sm text-muted-foreground">
        Generated C major scale for sampled-piano playback. Not part of the public product flow.
      </p>
      {src ? <MidiPlayer src={src} durationSec={4.8} /> : <p className="text-sm text-muted-foreground">Building MIDI…</p>}
    </main>
  );
}
