import { NextResponse } from "next/server";
import { getStorage } from "@maggybox/storage";
import { prisma } from "@maggybox/db";
import { notFound, notReady } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/transcriptions/{id}/midi — 302 to a short-lived signed URL for the
 * transcribed MIDI file.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const job = await prisma.transcription.findUnique({
    where: { id: params.id },
    select: { id: true, midiKey: true },
  });
  if (!job) return notFound();
  if (!job.midiKey) return notReady("MIDI");

  const storage = getStorage();
  const deterministicKey = `midi/${job.id}.deterministic.mid`;
  const midiKey = (await storage.get(deterministicKey)) ? deterministicKey : job.midiKey;
  const location = await storage.getSignedUrl(midiKey, {
    contentType: "audio/midi",
    download: true,
  });

  return NextResponse.redirect(new URL(location, req.url), {
    status: 302,
    headers: {
      "Content-Type": "audio/midi",
      "Content-Disposition": `attachment; filename="${job.id}.mid"`,
    },
  });
}
