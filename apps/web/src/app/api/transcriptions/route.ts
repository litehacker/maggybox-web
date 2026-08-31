import { NextResponse } from "next/server";
import {
  CreateTranscriptionRequest,
  makeError,
  type TranscriptionListResponse,
} from "@maggybox/contracts";
import { Prisma, prisma } from "@maggybox/db";
import { toDTO } from "@/lib/dto";
import { extractVideoId } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/**
 * MAG-19: log Prisma failures with their error code (e.g. P1001 = unreachable
 * database, P2021 = missing table) so deployment/config problems are visible
 * in the server logs. Connection strings are redacted — never log secrets.
 */
function logPrismaFailure(operation: string, error: unknown): void {
  const redact = (message: string): string =>
    message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]");

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(
      `[transcriptions] Prisma failure on ${operation}: code=${error.code} message=${redact(error.message)}`,
    );
  } else if (error instanceof Prisma.PrismaClientInitializationError) {
    console.error(
      `[transcriptions] Prisma init failure on ${operation}: code=${error.errorCode ?? "unknown"} message=${redact(error.message)}`,
    );
  } else if (error instanceof Error) {
    console.error(`[transcriptions] Unexpected failure on ${operation}: ${redact(error.message)}`);
  } else {
    console.error(`[transcriptions] Unexpected failure on ${operation}:`, error);
  }
}

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

  try {
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
  } catch (error) {
    // MAG-19: a failed Prisma create (unreachable DB, missing table, etc.) is a
    // deployment/configuration problem, not a client error. Log the Prisma
    // error code and return the frozen INTERNAL envelope (MAG-7 §4) instead of
    // an unhandled 500.
    logPrismaFailure("transcription.create", error);
    return NextResponse.json(
      makeError("INTERNAL", "Internal server error while creating the transcription job"),
      { status: 500 },
    );
  }
}

/**
 * GET /api/transcriptions — most recent 50 jobs, newest first.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const rows = await prisma.transcription.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const payload: TranscriptionListResponse = { items: rows.map(toDTO) };
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    logPrismaFailure("transcription.findMany", error);
    return NextResponse.json(
      makeError("INTERNAL", "Internal server error while listing transcription jobs"),
      { status: 500 },
    );
  }
}
