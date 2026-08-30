import type { TranscriptionDTO } from "@maggybox/contracts";
import type { Transcription } from "@maggybox/db";

/** Map a Transcription row to the frozen TranscriptionDTO contract. */
export function toDTO(t: Transcription): TranscriptionDTO {
  return {
    id: t.id,
    youtubeUrl: t.youtubeUrl,
    videoId: t.videoId,
    title: t.title,
    status: t.status,
    progress: t.progress,
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
    // MIDI is downloadable as soon as its artifact key exists.
    midiUrl: t.midiKey ? `/api/transcriptions/${t.id}/midi` : null,
    // STL is downloadable once the whole job is done.
    stlUrl: t.status === "done" ? `/api/transcriptions/${t.id}/stl` : null,
    cylinderSpecId: t.cylinderSpecId,
    durationSec: t.durationSec,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
  };
}
