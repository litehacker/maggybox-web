import { z } from "zod";

/**
 * FROZEN shared contract for the MaggyBox backend/frontend API.
 * Do not change shapes without updating the architect's spec first.
 */

export const JobStatus = z.enum([
  "queued",
  "extracting",
  "transcribing",
  "generating_cylinder",
  "done",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatus>;
export const JOB_STATUSES = JobStatus.options;

export const ErrorCode = z.enum([
  "INVALID_URL",
  "VIDEO_TOO_LONG",
  "VIDEO_UNAVAILABLE",
  "DOWNLOAD_FAILED",
  "TRANSCRIPTION_FAILED",
  "CYLINDER_FAILED",
  "NOT_READY",
  "NOT_FOUND",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ERROR_CODES = ErrorCode.options;

/** Response shape for every GET endpoint (status poll, list items). */
export const TranscriptionDTO = z.object({
  id: z.string(),
  youtubeUrl: z.string(),
  videoId: z.string(),
  title: z.string().nullable(),
  status: JobStatus,
  progress: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  midiUrl: z.string().nullable(),
  stlUrl: z.string().nullable(),
  cylinderSpecId: z.string().nullable(),
  durationSec: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type TranscriptionDTO = z.infer<typeof TranscriptionDTO>;

/** Body for POST /api/transcriptions. */
export const CreateTranscriptionRequest = z.object({
  youtubeUrl: z
    .string()
    .min(1)
    .url()
    .refine((url) => {
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, "");
        return (
          host === "youtube.com" ||
          host === "m.youtube.com" ||
          host === "music.youtube.com" ||
          host === "youtu.be" ||
          host === "youtube-nocookie.com"
        );
      } catch {
        return false;
      }
    }, "Must be a YouTube URL"),
});
export type CreateTranscriptionRequest = z.infer<typeof CreateTranscriptionRequest>;

/** Envelope for all error responses. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export function makeError(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

/** Response for GET /api/transcriptions. */
export const TranscriptionListResponse = z.object({
  items: z.array(TranscriptionDTO),
});
export type TranscriptionListResponse = z.infer<typeof TranscriptionListResponse>;
