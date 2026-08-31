import { NextResponse } from "next/server";
import {
  CreateTranscriptionRequest,
  makeError,
  type TranscriptionListResponse,
} from "@maggybox/contracts";
import { prisma } from "@maggybox/db";
import { toDTO } from "@/lib/dto";
import { extractVideoId } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/**
 * POST /api/transcriptions — validate a YouTube URL, create a queued job.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(makeError("INVALID_URL", "Request body must be JSON"), { status: 400 });
  }

  const parsed = CreateTranscriptionRequest.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid YouTube URL";
    return NextResponse.json(makeError("INVALID_URL", message), { status: 400 });
  }

  const videoId = extractVideoId(parsed.data.youtubeUrl);
  if (!videoId) {
    return NextResponse.json(
      makeError("INVALID_URL", "Could not extract a YouTube video id from the URL"),
      { status: 400 },
    );
  }

  const created = await prisma.transcription.create({
    data: {
      youtubeUrl: parsed.data.youtubeUrl,
      videoId,
      status: "queued",
    },
  });

  // 422 VIDEO_UNAVAILABLE is surfaced by the worker pipeline when the video
  // cannot actually be fetched; at create time the job is accepted as queued.
  return NextResponse.json(toDTO(created), { status: 201 });
}

/**
 * GET /api/transcriptions — most recent 50 jobs, newest first.
 */
export async function GET(): Promise<NextResponse> {
  const rows = await prisma.transcription.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const payload: TranscriptionListResponse = { items: rows.map(toDTO) };
  return NextResponse.json(payload, { status: 200 });
}
