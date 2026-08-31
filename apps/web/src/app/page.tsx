import { Transcriber } from "@/components/transcriber";

export default function Home() {
  return (
    <main className="relative flex min-h-screen items-start justify-center overflow-x-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(262_83%_58%_/_0.12),transparent_35%),radial-gradient(circle_at_bottom_right,hsl(38_92%_50%_/_0.12),transparent_35%)]" />
      <div className="relative z-10 flex w-full justify-center"><Transcriber /></div>
    </main>
  );
}
