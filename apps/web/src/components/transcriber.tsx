"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  Library,
  LoaderCircle,
  Music2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
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

const HISTORY_KEY = "maggybox-transcription-history";
const HISTORY_LIMIT = 20;

const statusCopy: Record<JobStatus, { title: string; detail: string }> = {
  queued: { title: "Queued", detail: "Your track is waiting for a worker." },
  extracting: { title: "Extracting audio", detail: "Preparing the audio from your YouTube video." },
  transcribing: { title: "Transcribing notes", detail: "Separating the lead melody and lower accompaniment into MIDI tracks." },
  generating_cylinder: { title: "Building the cylinder", detail: "Laying out the pins for your printable music-box cylinder." },
  done: { title: "Your music box is ready", detail: "Preview the two-track MIDI, then download both files." },
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

function readHistoryIds(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string").slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeHistoryIds(ids: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(ids.slice(0, HISTORY_LIMIT)));
  } catch {
    // Browsing can continue when local storage is disabled.
  }
}

function rememberHistoryId(id: string): void {
  writeHistoryIds([id, ...readHistoryIds().filter((savedId) => savedId !== id)]);
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "Duration unavailable";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function Transcriber() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<Transcription | null>(null);
  const [savedJobs, setSavedJobs] = useState<Transcription[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    if (!id) return;
    rememberHistoryId(id);
    let cancelled = false;
    fetch(`/api/transcriptions/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        const parsed = TranscriptionDTO.safeParse(data);
        if (!cancelled && parsed.success) setJob(parsed.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const ids = readHistoryIds();
    Promise.all(
      ids.map(async (id) => {
        try {
          const response = await fetch(`/api/transcriptions/${encodeURIComponent(id)}`, {
            cache: "no-store",
          });
          if (!response.ok) return null;
          const parsed = TranscriptionDTO.safeParse(await response.json());
          return parsed.success && parsed.data.status === "done" ? parsed.data : null;
        } catch {
          return null;
        }
      }),
    ).then((items) => {
      if (!active) return;
      const completed = items.filter((item): item is Transcription => item !== null);
      setSavedJobs(completed);
      writeHistoryIds(completed.map((item) => item.id));
      setLoadingHistory(false);
    });
    return () => {
      active = false;
    };
  }, []);

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

  useEffect(() => {
    if (!job || job.status !== "done") return;
    rememberHistoryId(job.id);
    setSavedJobs((current) => [
      job,
      ...current.filter((saved) => saved.id !== job.id),
    ].slice(0, HISTORY_LIMIT));
  }, [job]);

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
      rememberHistoryId(parsed.data.id);
      window.history.replaceState(null, "", `?job=${encodeURIComponent(parsed.data.id)}`);
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
    window.history.replaceState(null, "", window.location.pathname);
  }

  function openSaved(saved: Transcription) {
    setError(null);
    setJob(saved);
    rememberHistoryId(saved.id);
    window.history.replaceState(null, "", `?job=${encodeURIComponent(saved.id)}`);
  }

  function forgetSaved(id: string) {
    const remaining = savedJobs.filter((saved) => saved.id !== id);
    setSavedJobs(remaining);
    writeHistoryIds(remaining.map((saved) => saved.id));
  }

  const status = job ? statusCopy[job.status] : null;
  const failed = job?.status === "failed";
  const done = job?.status === "done";

  return (
    <Card className={`w-full overflow-hidden ${done ? "max-w-4xl" : "max-w-2xl"}`}>
      <CardHeader className="border-b bg-white/60">
        <div className="flex items-center gap-3 text-sm font-semibold text-primary">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-primary-foreground"><Music2 className="h-5 w-5" /></span>
          MAGGYBOX
        </div>
        <h1 className="pt-3 text-3xl font-bold tracking-tight sm:text-4xl">Turn a YouTube melody into a music box.</h1>
        <p className="max-w-xl text-muted-foreground">Paste a video link. We’ll create a playable lead-and-accompaniment MIDI and a cylinder ready for 3D printing.</p>
      </CardHeader>

      <CardContent className="pt-6 sm:pt-8">
        {!job ? (
          <div className="space-y-6">
            {loadingHistory || savedJobs.length > 0 ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Library className="h-4 w-4 text-primary" />
                  <div>
                    <h2 className="font-semibold">Your saved transcriptions</h2>
                    <p className="text-xs text-muted-foreground">History saved only in this browser.</p>
                  </div>
                </div>
                {loadingHistory ? (
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                    Loading your saved music…
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {savedJobs.map((saved) => (
                      <div key={saved.id} className="flex items-center gap-2 rounded-lg border bg-white/50 p-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                          onClick={() => openSaved(saved)}
                        >
                          <span className="block truncate text-sm font-semibold">
                            {saved.title || "Untitled transcription"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatDuration(saved.durationSec)} · Open MIDI
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Forget ${saved.title || "transcription"}`}
                          onClick={() => forgetSaved(saved.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <form onSubmit={submit} className="space-y-4 border-t pt-6">
              <div className="space-y-2">
                <label htmlFor="youtube-url" className="text-sm font-semibold">Add another YouTube URL</label>
                <Input id="youtube-url" type="url" inputMode="url" autoComplete="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-invalid={Boolean(error)} disabled={submitting} />
              </div>
              {error ? <p className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
              <Button className="w-full" size="lg" disabled={submitting || !url.trim()}>
                {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {submitting ? "Starting transcription…" : "Create my music box"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">Public YouTube videos only. Processing may take several minutes.</p>
            </form>
          </div>
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
                <MidiPlayer src={assetUrl(job, "midi")} durationSec={job.durationSec} />
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
