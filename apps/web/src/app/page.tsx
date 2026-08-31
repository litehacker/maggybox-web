"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { CreateTranscriptionRequest, ErrorEnvelope, TranscriptionDTO, type ErrorCode, type JobStatus, type TranscriptionDTO as Transcription } from "@maggybox/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

const STATUS: Record<JobStatus, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Your transcription is waiting to start." },
  extracting: { label: "Extracting audio", detail: "We’re preparing the audio from your video." },
  transcribing: { label: "Transcribing notes", detail: "We’re listening for the melody and creating MIDI." },
  generating_cylinder: { label: "Building the cylinder", detail: "MIDI is ready. We’re generating your printable STL." },
  done: { label: "Your music box is ready", detail: "Preview the melody or download both files." },
  failed: { label: "We couldn’t finish this transcription", detail: "Try again, or use a different video." },
};

const ERROR_COPY: Record<ErrorCode, string> = {
  INVALID_URL: "Paste a valid public YouTube video URL.",
  VIDEO_TOO_LONG: "This video is too long. Try a shorter video.",
  VIDEO_UNAVAILABLE: "This video is private, unavailable, or region restricted.",
  DOWNLOAD_FAILED: "We couldn’t extract audio from this video.",
  TRANSCRIPTION_FAILED: "We couldn’t turn this audio into MIDI.",
  CYLINDER_FAILED: "The MIDI is ready, but the printable cylinder could not be generated.",
  NOT_READY: "Your files are still being prepared.",
  NOT_FOUND: "This transcription could not be found.",
  INTERNAL: "Something went wrong on our side. Please try again.",
};

function readError(value: unknown, fallback: string) {
  const parsed = ErrorEnvelope.safeParse(value);
  return parsed.success ? ERROR_COPY[parsed.data.error.code] || parsed.data.error.message : fallback;
}

async function getJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function MidiPreview({ url }: { url: string }) {
  const audioRef = useRef<AudioContext | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");

  const stop = () => {
    if (audioRef.current) void audioRef.current.close();
    audioRef.current = null;
    setState("idle");
  };

  useEffect(() => stop, []);

  const play = async () => {
    setState("loading");
    try {
      const [{ Midi }, response] = await Promise.all([import("@tonejs/midi"), fetch(url)]);
      if (!response.ok) throw new Error("MIDI unavailable");
      const midi = new Midi(await response.arrayBuffer());
      const AudioContextClass = window.AudioContext;
      const audio = new AudioContextClass();
      audioRef.current = audio;
      const start = audio.currentTime + 0.08;
      let end = start;
      for (const track of midi.tracks) {
        for (const note of track.notes) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const noteStart = start + note.time;
          const noteEnd = noteStart + Math.max(0.04, note.duration);
          oscillator.type = "triangle";
          oscillator.frequency.value = 440 * Math.pow(2, (note.midi - 69) / 12);
          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.03, note.velocity * 0.18), noteStart + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
          oscillator.connect(gain).connect(audio.destination);
          oscillator.start(noteStart);
          oscillator.stop(noteEnd + 0.02);
          end = Math.max(end, noteEnd);
        }
      }
      setState("playing");
      window.setTimeout(() => { if (audioRef.current === audio) stop(); }, Math.max(100, (end - audio.currentTime) * 1000));
    } catch {
      setState("error");
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-4">
        <div><p className="font-medium">MIDI preview</p><p className="text-sm text-muted-foreground">Synthesized in your browser</p></div>
        {state === "playing" ? <Button variant="outline" onClick={stop}>Stop</Button> : <Button variant="outline" onClick={play} disabled={state === "loading"}>{state === "loading" ? "Loading…" : "Play MIDI"}</Button>}
      </div>
      {state === "error" && <p className="mt-3 text-sm text-destructive" role="alert">Preview unavailable. You can still download the MIDI file.</p>}
    </div>
  );
}

export default function Home() {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [job, setJob] = useState<Transcription | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionIssue, setConnectionIssue] = useState(false);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/transcriptions/${job.id}`, { cache: "no-store" });
        const body = await getJson(response);
        if (!response.ok) throw new Error(readError(body, "Status is temporarily unavailable."));
        const next = TranscriptionDTO.parse(body);
        if (!cancelled) { failures = 0; setConnectionIssue(false); setJob(next); }
      } catch (reason) {
        failures += 1;
        if (!cancelled) {
          setConnectionIssue(true);
          if (failures >= 3) setError(reason instanceof Error ? reason.message : "Can’t reach the service. Please try again.");
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, job?.status]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const input = CreateTranscriptionRequest.safeParse({ youtubeUrl: youtubeUrl.trim() });
    if (!input.success) { setError("Paste a valid YouTube video URL."); return; }
    setSubmitting(true);
    try {
      const response = await fetch("/api/transcriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data) });
      const body = await getJson(response);
      if (!response.ok) { setError(readError(body, "We couldn’t start the transcription.")); return; }
      setJob(TranscriptionDTO.parse(body));
    } catch {
      setError("Can’t reach the service. Check your connection and try again.");
    } finally { setSubmitting(false); }
  };

  const reset = () => { setJob(null); setError(null); setConnectionIssue(false); setYoutubeUrl(""); };
  const isDone = job?.status === "done";
  const isFailed = job?.status === "failed";

  return (
    <main className="container flex min-h-screen max-w-3xl flex-col justify-center py-12 sm:py-20">
      <header className="mb-8 text-center">
        <div className="mb-4 inline-flex rounded-full border border-primary/20 bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">MaggyBox</div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Turn a video into a music box</h1>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">Paste a YouTube link. We’ll create a playable MIDI and a 3D-printable music-box cylinder.</p>
      </header>

      {!job ? (
        <Card>
          <CardHeader><CardTitle>Choose a YouTube video</CardTitle><CardDescription>Use a public video with a clear melody for the best result.</CardDescription></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <label htmlFor="youtube-url" className="text-sm font-medium">YouTube URL</label>
              <Input id="youtube-url" type="url" inputMode="url" autoComplete="url" placeholder="https://www.youtube.com/watch?v=…" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} disabled={submitting} aria-invalid={Boolean(error)} aria-describedby={error ? "url-error" : undefined} />
              {error && <p id="url-error" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="w-full sm:w-auto" disabled={submitting}>{submitting ? "Starting…" : "Create music box"}</Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-primary"><span className={`h-2.5 w-2.5 rounded-full ${isFailed ? "bg-destructive" : isDone ? "bg-emerald-500" : "animate-pulse bg-primary"}`} />{STATUS[job.status].label}</div>
            <CardTitle>{job.title || "Your YouTube transcription"}</CardTitle>
            <CardDescription>{STATUS[job.status].detail}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!isDone && !isFailed && <><Progress value={job.progress} /><div className="flex justify-between text-xs text-muted-foreground"><span>This may take a few minutes. You can keep this tab open.</span><span>{job.progress}%</span></div></>}
            {connectionIssue && !error && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">Connection interrupted. We’ll keep trying automatically.</p>}
            {(error || isFailed) && <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive" role="alert"><p className="font-semibold">Transcription failed</p><p className="mt-1">{error || job.errorMessage || STATUS.failed.detail}</p></div>}
            {isDone && <>
              <MidiPreview url={`/api/transcriptions/${job.id}/midi`} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Button asChild><a href={`/api/transcriptions/${job.id}/midi`} download>Download MIDI</a></Button>
                <Button asChild variant="outline"><a href={`/api/transcriptions/${job.id}/stl`} download>Download STL cylinder</a></Button>
              </div>
            </>}
            {(isDone || isFailed || error) && <Button type="button" variant="ghost" className="w-full" onClick={reset}>Transcribe another video</Button>}
          </CardContent>
        </Card>
      )}
      <p className="mt-6 text-center text-xs text-muted-foreground">Audio processing can take several minutes. Files are generated from the source video you provide.</p>
    </main>
  );
}
