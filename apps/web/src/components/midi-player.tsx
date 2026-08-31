"use client";

import { useEffect, useRef, useState } from "react";
import { Midi } from "@tonejs/midi";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MidiPlayer({ url }: { url: string }) {
  const [midi, setMidi] = useState<Midi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    let active = true;
    fetch(url).then((response) => {
      if (!response.ok) throw new Error("MIDI preview is not ready yet.");
      return response.arrayBuffer();
    }).then((buffer) => { if (active) setMidi(new Midi(buffer)); }).catch(() => { if (active) setError("Preview unavailable. You can still download the MIDI file."); });
    return () => { active = false; void audio.current?.close(); };
  }, [url]);

  function stop() {
    void audio.current?.close();
    audio.current = null;
    setPlaying(false);
  }

  async function play() {
    if (!midi) return;
    const context = new AudioContext();
    audio.current = context;
    await context.resume();
    const start = context.currentTime + 0.05;
    for (const track of midi.tracks) for (const note of track.notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);
      gain.gain.setValueAtTime(0, start + note.time);
      gain.gain.linearRampToValueAtTime(Math.max(0.025, note.velocity * 0.12), start + note.time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + note.time + Math.max(0.08, note.duration));
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + note.time);
      oscillator.stop(start + note.time + Math.max(0.1, note.duration) + 0.02);
    }
    setPlaying(true);
    window.setTimeout(stop, Math.ceil((midi.duration + 0.25) * 1000));
  }

  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  return <Button type="button" variant="outline" onClick={playing ? stop : play} disabled={!midi}>{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{midi ? (playing ? "Stop preview" : "Preview MIDI") : "Loading preview…"}</Button>;
}
