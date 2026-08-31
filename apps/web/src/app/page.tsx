import { Music2 } from "lucide-react";
import { Transcriber } from "@/components/transcriber";

export default function Home() {
  return <main className="music-grid min-h-screen px-4 py-8 sm:py-14">
    <div className="mx-auto flex max-w-5xl flex-col items-center">
      <header className="mb-8 flex w-full max-w-2xl items-center justify-between">
        <div className="flex items-center gap-2 text-lg font-black tracking-tight"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white"><Music2 className="h-5 w-5" /></span>MaggyBox</div>
        <span className="rounded-full border bg-white/70 px-3 py-1 text-xs font-semibold text-muted-foreground">YouTube → MIDI → STL</span>
      </header>
      <section className="mb-9 max-w-3xl text-center"><p className="mb-3 text-sm font-bold uppercase tracking-[0.2em] text-primary">Your song, made mechanical</p><h1 className="text-balance text-4xl font-black tracking-tight sm:text-6xl">Turn any song into a music box.</h1><p className="mx-auto mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">Create a playable MIDI and a 3D-printable cylinder from one YouTube link.</p></section>
      <Transcriber />
      <footer className="mt-8 text-center text-xs text-muted-foreground">For best results, choose videos with a clear melody and limited background noise.</footer>
    </div>
  </main>;
}
