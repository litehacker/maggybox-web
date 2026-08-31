import { NextResponse } from "next/server";
import { prisma } from "@maggybox/db";
import { toDTO } from "@/lib/dto";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/transcriptions/{id} — status poll endpoint (client polls every 2s).
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const job = await prisma.transcription.findUnique({
    where: { id: params.id },
  });
  if (!job) return notFound();
  return NextResponse.json(toDTO(job), { status: 200 });
}
