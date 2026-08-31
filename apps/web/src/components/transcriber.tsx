"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, Download, LoaderCircle, Music2, RefreshCw, Sparkles } from "lucide-react";
import {
  CreateTranscriptionRequest,
  ErrorEnvelope,
  TranscriptionDTO,
  type JobStatus,
  type TranscriptionDTO as Transcription,
} from "@maggybox/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { MidiPlayer } from "@/components/midi-player";

const statusCopy: Record<JobStatus, { title: string; detail: string }> = {
  queued: { title: "Queued", detail: "Your track is waiting for a worker." },
  extracting: { title: "Extracting audio", detail: "Preparing the audio from your YouTube video." },
  transcribing: { title: "Transcribing notes", detail: "Turning the melody into a MIDI arrangement." },
  generating_cylinder: { title: "Building the cylinder", detail: "Laying out the pins for your printable music-box cylinder." },
  done: { title: "Your music box is ready", detail: "Preview the MIDI, then download both files." },
  failed: { title: "We couldn’t finish this track", detail: "Try again or use another YouTube video." },
};

const friendlyErrors: Record<string, string> = {
  INVALID_URL: "Paste a valid public YouTube URL.",
  VIDEO_TOO_LONG: "This video is too long. Choose a shorter track and try again.",
  VIDEO_UNAVAILABLE: "This video is unavailable or private. Choose a public video.",
  DOWNLOAD_FAILED: "We couldn’t retrieve the video audio. Please try again.",
  TRANSCRIPTION_FAILED: "We couldn’t turn this track into MIDI. Try another recording.",
  CYLINDER_FAILED: "The MIDI is ready, but the cylinder could not be generated.",
  NOT_READY: "The file is still being prepared. Please wait a moment.",
  NOT_FOUND: "This transcription could not be found. Start a new one.",
  INTERNAL: "Something went wrong on our side. Please try again.",
};

async function messageFrom(response: Response) {
  try {
    const parsed = ErrorEnvelope.safeParse(await response.json());
    if (parsed.success) return friendlyErrors[parsed.data.error.code] ?? parsed.data.error.message;
  } catch {}
  return "We couldn’t reach the transcription service. Please try again.";
}

function assetUrl(job: Transcription, kind: "midi" | "stl") {
  const supplied = kind === "midi" ? job.midiUrl : job.stlUrl;
  return supplied || `/api/transcriptions/${job.id}/${kind}`;
}

export function Transcriber() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<Transcription | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    let active = true;
    const controller = new AbortController();

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/transcriptions/${job.id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await messageFrom(response));
        const parsed = TranscriptionDTO.safeParse(await response.json());
        if (!parsed.success) throw new Error("The service returned an unexpected response.");
        failures.current = 0;
        if (active) setJob(parsed.data);
      } catch (cause) {
        if (controller.signal.aborted) return;
        failures.current += 1;
        if (active && failures.current >= 3) {
          setError(cause instanceof Error ? cause.message : "Connection lost. Please try again.");
        }
      }
    }, 2000);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsedInput = CreateTranscriptionRequest.safeParse({ youtubeUrl: url.trim() });
    if (!parsedInput.success) {
      setError("Paste a valid YouTube URL, for example https://youtube.com/watch?v=…");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedInput.data),
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const parsed = TranscriptionDTO.safeParse(await response.json());
      if (!parsed.success) throw new Error("The service returned an unexpected response.");
      failures.current = 0;
      setJob(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Can’t reach the service. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    failures.current = 0;
    setJob(null);
    setError(null);
    setUrl("");
  }

  const status = job ? statusCopy[job.status] : null;
  const failed = job?.status === "failed";
  const done = job?.status === "done";

  return (
    <Card className="w-full max-w-2xl overflow-hidden">
      <CardHeader className="border-b bg-white/60">
        <div className="flex items-center gap-3 text-sm font-semibold text-primary">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground"><Music2 className="h-5 w-5" /></span>
          MAGGYBOX
        </div>
        <h1 className="pt-3 text-3xl font-bold tracking-tight sm:text-4xl">Turn a YouTube melody into a music box.</h1>
        <p className="max-w-xl text-muted-foreground">Paste a video link. We’ll create a playable MIDI and a cylinder ready for 3D printing.</p>
      </CardHeader>

      <CardContent className="pt-6 sm:pt-8">
        {!job ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="youtube-url" className="text-sm font-semibold">YouTube URL</label>
              <Input id="youtube-url" type="url" inputMode="url" autoComplete="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-invalid={Boolean(error)} disabled={submitting} />
            </div>
            {error ? <p className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
            <Button className="w-full" size="lg" disabled={submitting || !url.trim()}>
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {submitting ? "Starting transcription…" : "Create my music box"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">Public YouTube videos only. Processing may take several minutes.</p>
          </form>
        ) : (
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                {done ? <Check className="h-6 w-6" /> : failed ? <RefreshCw className="h-5 w-5" /> : <LoaderCircle className="h-6 w-6 animate-spin" />}
              </span>
              <div>
                <h2 className="text-xl font-bold">{status?.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{failed && job.errorMessage ? job.errorMessage : status?.detail}</p>
              </div>
            </div>

            {!done && !failed ? (
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span>{job.progress}% complete</span><span className="text-muted-foreground">Keep this tab open</span></div>
                <Progress value={job.progress} />
                {error ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800" role="status">Connection is unstable. We’ll keep retrying automatically.</p> : null}
              </div>
            ) : null}

            {done ? (
              <div className="space-y-4">
                <MidiPlayer src={assetUrl(job, "midi")} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button asChild><a href={assetUrl(job, "midi")} download><Download className="h-4 w-4" />Download MIDI</a></Button>
                  <Button asChild variant="outline"><a href={assetUrl(job, "stl")} download><Download className="h-4 w-4" />Download STL cylinder</a></Button>
                </div>
              </div>
            ) : null}

            {failed ? <p className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{friendlyErrors[job.errorCode ?? ""] ?? job.errorMessage ?? status?.detail}</p> : null}

            {(done || failed) ? <Button type="button" variant="ghost" className="w-full" onClick={reset}>Transcribe another video</Button> : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
