"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CreateTranscriptionRequest, ErrorEnvelope, TranscriptionDTO, type ErrorCode, type JobStatus } from "@maggybox/contracts";
import { AlertCircle, Check, Download, Music2, RotateCcw, Sparkles } from "lucide-react";
import { MidiPlayer } from "@/components/midi-player";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

const STATUS: Record<JobStatus, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Your video is waiting for an available transcriber." },
  extracting: { label: "Extracting audio", detail: "We’re separating the music from the video." },
  transcribing: { label: "Transcribing", detail: "Turning the audio into playable MIDI notes." },
  generating_cylinder: { label: "Building your cylinder", detail: "Laying out notes on a printable music-box cylinder." },
  done: { label: "Ready", detail: "Your MIDI and printable cylinder are ready." },
  failed: { label: "Transcription failed", detail: "We couldn’t complete this transcription." },
};

const ERROR_COPY: Record<ErrorCode, string> = {
  INVALID_URL: "Enter a valid public YouTube URL.", VIDEO_TOO_LONG: "This video is too long for the current limit.", VIDEO_UNAVAILABLE: "This video is private, unavailable, or region-restricted.", DOWNLOAD_FAILED: "We couldn’t extract audio from this video.", TRANSCRIPTION_FAILED: "We couldn’t turn this audio into MIDI.", CYLINDER_FAILED: "The MIDI was created, but the cylinder could not be generated.", NOT_READY: "Your files are still being prepared.", NOT_FOUND: "This transcription could not be found.", INTERNAL: "Something went wrong on our side. Please try again.",
};

type Screen = "form" | "working" | "done" | "error";

async function readError(response: Response): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  const parsed = ErrorEnvelope.safeParse(data);
  return parsed.success ? ERROR_COPY[parsed.data.error.code] || parsed.data.error.message : "The service is unavailable. Please try again.";
}

export function Transcriber() {
  const [url, setUrl] = useState("");
  const [screen, setScreen] = useState<Screen>("form");
  const [job, setJob] = useState<TranscriptionDTO | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionWarning, setConnectionWarning] = useState(false);
  const failures = useRef(0);

  const poll = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/transcriptions/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const parsed = TranscriptionDTO.safeParse(await response.json());
      if (!parsed.success) throw new Error("The service returned an unexpected response.");
      failures.current = 0;
      setConnectionWarning(false);
      setJob(parsed.data);
      if (parsed.data.status === "done") setScreen("done");
      if (parsed.data.status === "failed") { setMessage(parsed.data.errorMessage || STATUS.failed.detail); setScreen("error"); }
    } catch (error) {
      failures.current += 1;
      setConnectionWarning(true);
      if (failures.current >= 3) { setMessage(error instanceof Error ? error.message : "Can’t reach the service."); setScreen("error"); }
    }
  }, []);

  useEffect(() => {
    if (screen !== "working" || !job) return;
    const timer = window.setInterval(() => void poll(job.id), 2000);
    return () => window.clearInterval(timer);
  }, [job, poll, screen]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const request = CreateTranscriptionRequest.safeParse({ youtubeUrl: url.trim() });
    if (!request.success) { setMessage("Paste a valid YouTube link, such as youtube.com/watch?v=…"); return; }
    setScreen("working");
    try {
      const response = await fetch("/api/transcriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.data) });
      if (!response.ok) throw new Error(await readError(response));
      const parsed = TranscriptionDTO.safeParse(await response.json());
      if (!parsed.success) throw new Error("The service returned an unexpected response.");
      setJob(parsed.data);
      if (parsed.data.status === "done") setScreen("done");
      else if (parsed.data.status === "failed") { setMessage(parsed.data.errorMessage || STATUS.failed.detail); setScreen("error"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Can’t reach the service."); setScreen("error"); }
  }

  function reset() { failures.current = 0; setUrl(""); setJob(null); setMessage(null); setConnectionWarning(false); setScreen("form"); }
  const midiUrl = job?.midiUrl || (job ? `/api/transcriptions/${job.id}/midi` : "");
  const stlUrl = job?.stlUrl || (job ? `/api/transcriptions/${job.id}/stl` : "");

  return <Card className="w-full max-w-2xl overflow-hidden">
    {screen === "form" && <><CardHeader className="pb-4"><div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Music2 /></div><CardTitle>Make your music box</CardTitle><CardDescription>Paste a YouTube link. We’ll transcribe the music and create a printable cylinder.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-4"><label htmlFor="youtube-url" className="text-sm font-semibold">YouTube URL</label><Input id="youtube-url" type="url" inputMode="url" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(event) => setUrl(event.target.value)} aria-invalid={Boolean(message)} aria-describedby={message ? "url-error" : undefined} autoFocus />{message && <p id="url-error" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{message}</p>}<Button className="w-full" size="lg" type="submit"><Sparkles className="h-4 w-4" />Create MIDI & cylinder</Button><p className="text-center text-xs text-muted-foreground">Processing usually takes a few minutes. No account needed.</p></form></CardContent></>}
    {screen === "working" && <><CardHeader><div className="flex items-center gap-3"><div className="h-3 w-3 animate-pulse rounded-full bg-primary" /><CardTitle>{job ? STATUS[job.status].label : "Starting transcription"}</CardTitle></div><CardDescription>{job ? STATUS[job.status].detail : "Sending your video to the transcriber…"}</CardDescription></CardHeader><CardContent className="space-y-5"><Progress value={job?.progress ?? 0} /><div className="flex justify-between text-sm"><span className="text-muted-foreground">{job?.title || "YouTube video"}</span><span className="font-semibold">{job?.progress ?? 0}%</span></div>{connectionWarning && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Connection interrupted. Retrying automatically…</p>}<p className="text-sm text-muted-foreground">You can keep this tab open while we work. Longer videos may take several minutes.</p></CardContent></>}
    {screen === "done" && job && <><CardHeader><div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Check /></div><CardTitle>Your music box is ready</CardTitle><CardDescription>{job.title || "Your transcription completed successfully."}</CardDescription></CardHeader><CardContent className="space-y-5"><div className="rounded-xl border bg-muted/40 p-4"><p className="mb-3 text-sm font-semibold">Listen before you download</p><MidiPlayer url={midiUrl} /></div><div className="grid gap-3 sm:grid-cols-2"><Button asChild><a href={midiUrl} download><Download className="h-4 w-4" />Download MIDI</a></Button><Button asChild variant="outline"><a href={stlUrl} download><Download className="h-4 w-4" />Download STL cylinder</a></Button></div><Button className="w-full" variant="ghost" onClick={reset}><RotateCcw className="h-4 w-4" />Transcribe another video</Button></CardContent></>}
    {screen === "error" && <><CardHeader><div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-destructive"><AlertCircle /></div><CardTitle>We hit a snag</CardTitle><CardDescription>{message || "We couldn’t complete your transcription."}</CardDescription></CardHeader><CardContent className="flex gap-3"><Button onClick={reset}>Try another video</Button>{job && <Button variant="outline" onClick={() => { failures.current = 0; setScreen("working"); void poll(job.id); }}>Retry</Button>}</CardContent></>}
  </Card>;
}
