import { prisma, type Transcription } from "@maggybox/db";
import type { ErrorCode } from "@maggybox/contracts";

/**
 * Atomically claim the oldest queued job.
 *
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple workers (or restarts)
 * never double-claim: the row is locked at read time, other pollers skip it,
 * and we immediately stamp `lockedAt` + move status to `extracting`.
 */
export async function claimJob(): Promise<Transcription | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Transcription"
      WHERE "status" = 'queued'
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return null;

    const now = new Date();
    return tx.transcription.update({
      where: { id: rows[0].id },
      data: {
        status: "extracting",
        lockedAt: now,
        startedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    });
  });
}

/** Coarse progress + status update (best-effort). */
export async function setProgress(
  id: string,
  status: "extracting" | "transcribing" | "generating_cylinder",
  progress: number,
): Promise<void> {
  await prisma.transcription.update({
    where: { id },
    data: { status, progress },
  });
}

/** Persist extraction metadata alongside progress. */
export async function setMetadata(
  id: string,
  data: { title?: string | null; durationSec?: number | null },
): Promise<void> {
  await prisma.transcription.update({ where: { id }, data });
}

/** Persist a stored MIDI artifact reference. */
export async function setMidiArtifact(id: string, midiKey: string, midiBytes: number): Promise<void> {
  await prisma.transcription.update({ where: { id }, data: { midiKey, midiBytes } });
}

/** Terminal success. */
export async function completeJob(
  id: string,
  data: {
    stlKey: string;
    stlBytes: number;
    cylinderSpecId: string;
  },
): Promise<void> {
  await prisma.transcription.update({
    where: { id },
    data: {
      ...data,
      status: "done",
      progress: 100,
      completedAt: new Date(),
      lockedAt: null,
    },
  });
}

/** Terminal failure with a contract error code. */
export async function failJob(id: string, code: ErrorCode, message: string): Promise<void> {
  await prisma.transcription.update({
    where: { id },
    data: {
      status: "failed",
      errorCode: code,
      errorMessage: message.slice(0, 1000),
      completedAt: new Date(),
      lockedAt: null,
    },
  });
}
