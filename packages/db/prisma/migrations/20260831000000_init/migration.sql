-- Initial schema for MaggyBox transcription jobs.

CREATE TYPE "JobStatus" AS ENUM (
  'queued',
  'extracting',
  'transcribing',
  'generating_cylinder',
  'done',
  'failed'
);

CREATE TABLE "Transcription" (
  "id"             TEXT       NOT NULL,
  "youtubeUrl"     TEXT       NOT NULL,
  "videoId"        TEXT       NOT NULL,
  "title"          TEXT,
  "status"         "JobStatus" NOT NULL DEFAULT 'queued',
  "progress"       INTEGER    NOT NULL DEFAULT 0,
  "errorCode"      TEXT,
  "errorMessage"   TEXT,
  "midiKey"        TEXT,
  "midiBytes"      INTEGER,
  "stlKey"         TEXT,
  "stlBytes"       INTEGER,
  "cylinderSpecId" TEXT,
  "durationSec"    INTEGER,
  "lockedAt"       TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "startedAt"      TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),

  CONSTRAINT "Transcription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transcription_status_createdAt_idx"
  ON "Transcription"("status", "createdAt");

CREATE INDEX "Transcription_videoId_idx"
  ON "Transcription"("videoId");
