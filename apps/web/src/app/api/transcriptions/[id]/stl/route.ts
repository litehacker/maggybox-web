import { NextResponse } from "next/server";
import { getStorage } from "@maggybox/storage";
import { prisma } from "@maggybox/db";
import { notFound, notReady } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/transcriptions/{id}/stl — 302 to a short-lived signed URL for the
 * generated cylinder STL.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const job = await prisma.transcription.findUnique({
    where: { id: params.id },
    select: { id: true, stlKey: true },
  });
  if (!job) return notFound();
  if (!job.stlKey) return notReady("STL");

  const storage = getStorage();
  const location = await storage.getSignedUrl(job.stlKey, {
    contentType: "model/stl",
    download: true,
  });

  return NextResponse.redirect(new URL(location, req.url), {
    status: 302,
    headers: {
      "Content-Type": "model/stl",
      "Content-Disposition": `attachment; filename="${job.id}.stl"`,
    },
  });
}
