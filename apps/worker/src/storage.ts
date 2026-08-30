/**
 * Worker-facing entry to the storage abstraction.
 *
 * The implementation lives in @maggybox/storage so that the API routes can
 * generate signed download URLs from the same configuration. Driver selection:
 * Vercel Blob (BLOB_READ_WRITE_TOKEN) → S3-compatible (S3_ENDPOINT + S3_BUCKET)
 * → local disk fallback.
 */
export { getStorage, verifyLocalSignature, type ObjectStorage } from "@maggybox/storage";
