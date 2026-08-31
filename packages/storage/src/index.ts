/**
 * Object storage abstraction shared by the API (signed download URLs) and the
 * worker (artifact uploads).
 *
 * Driver selection (see getStorage):
 *  1. Vercel Blob  — when BLOB_READ_WRITE_TOKEN is set
 *  2. S3-compatible — when S3_ENDPOINT + S3_BUCKET are set
 *  3. Local disk   — fallback for v1/dev; artifacts live under LOCAL_STORAGE_DIR
 *                    and downloads are served by the web app's /api/files route
 *                    using HMAC-signed, short-lived URLs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";

export interface PutResult {
  key: string;
  bytes: number;
}

export interface SignedUrlOptions {
  contentType?: string;
  /** Content-Disposition: attachment when true. */
  download?: boolean;
  /** TTL for short-lived signed URLs. Default 300s. */
  ttlSeconds?: number;
}

export interface ObjectStorage {
  readonly driver: "local" | "s3" | "vercel-blob";
  put(key: string, data: Buffer, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string>;
}

const DEFAULT_TTL_SECONDS = 300;

/* ------------------------------------------------------------------ */
/* Local disk driver                                                   */
/* ------------------------------------------------------------------ */

function localSigningSecret(): string {
  const secret = process.env.STORAGE_SIGNING_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STORAGE_SIGNING_SECRET is required in production for the local storage driver");
    }
    return "maggybox-insecure-dev-secret";
  }
  return secret;
}

function signPayload(key: string, expires: number): string {
  return createHmac("sha256", localSigningSecret())
    .update(`${key}:${expires}`)
    .digest("hex");
}

export function verifyLocalSignature(key: string, expires: string | null, signature: string | null): boolean {
  if (!expires || !signature) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signPayload(key, exp);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Resolve the monorepo root so web (cwd: apps/web) and worker (cwd: apps/worker)
 * share the same on-disk artifact store. Relative LOCAL_STORAGE_DIR values are
 * interpreted from this root, not from process.cwd().
 */
function repoRoot(): string {
  const isRoot = (dir: string): boolean =>
    existsSync(path.join(dir, "packages", "storage")) && existsSync(path.join(dir, "apps", "web"));

  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (isRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function localRoot(): string {
  const raw = process.env.LOCAL_STORAGE_DIR ?? "./.data/artifacts";
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot(), raw);
}

const localDriver: ObjectStorage = {
  driver: "local",
  async put(key, data) {
    const file = path.join(localRoot(), key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return { key, bytes: data.byteLength };
  },
  async get(key) {
    try {
      return await readFile(path.join(localRoot(), key));
    } catch {
      return null;
    }
  },
  async delete(key) {
    try {
      await unlink(path.join(localRoot(), key));
    } catch {
      /* already gone */
    }
  },
  async getSignedUrl(key, opts) {
    const ttl = opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expires = Date.now() + ttl * 1000;
    const signature = signPayload(key, expires);
    const params = new URLSearchParams({ expires: String(expires), signature });
    if (opts?.download) params.set("dl", "1");
    // Relative URL: served by the web app's /api/files/[...key] route.
    return `/api/files/${key.split("/").map(encodeURIComponent).join("/")}?${params.toString()}`;
  },
};

/* ------------------------------------------------------------------ */
/* S3-compatible driver (aws4fetch SigV4 presigned GET)                */
/* ------------------------------------------------------------------ */

function s3Config() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required for the S3 storage driver");
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for the S3 storage driver");
  }
  const endpoint = process.env.S3_ENDPOINT; // e.g. https://accountid.r2.cloudflarestorage.com
  const region = process.env.S3_REGION ?? "auto";
  const urlStyle = (process.env.S3_URL_STYLE ?? "path").toLowerCase();
  return { bucket, accessKeyId, secretAccessKey, endpoint, region, urlStyle };
}

function s3Client(cfg: ReturnType<typeof s3Config>): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: "s3",
  });
}

function s3ObjectUrl(cfg: ReturnType<typeof s3Config>, key: string): URL {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (cfg.endpoint) {
    if (cfg.urlStyle === "virtual-host" || cfg.urlStyle === "virtual_host") {
      const endpoint = new URL(cfg.endpoint);
      return new URL(`${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`);
    }
    // Path-style for S3-compatible providers (R2, MinIO, …).
    return new URL(`${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}/${encodedKey}`);
  }
  return new URL(`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${encodedKey}`);
}

const s3Driver: ObjectStorage = {
  driver: "s3",
  async put(key, data, contentType) {
    const cfg = s3Config();
    const res = await s3Client(cfg).fetch(s3ObjectUrl(cfg, key), {
      method: "PUT",
      body: new Uint8Array(data),
      headers: { "Content-Type": contentType },
    });
    if (!res.ok) {
      throw new Error(`S3 put failed for key ${key}: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return { key, bytes: data.byteLength };
  },
  async get(key) {
    const cfg = s3Config();
    const res = await s3Client(cfg).fetch(s3ObjectUrl(cfg, key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 get failed for key ${key}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async delete(key) {
    const cfg = s3Config();
    await s3Client(cfg).fetch(s3ObjectUrl(cfg, key), { method: "DELETE" });
  },
  async getSignedUrl(key, opts) {
    const cfg = s3Config();
    const url = s3ObjectUrl(cfg, key);
    const ttl = opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    // Presign: all query params must be present BEFORE signing so they are
    // part of the canonical request (post-sign mutation would break the
    // signature).
    url.searchParams.set("X-Amz-Expires", String(ttl));
    if (opts?.download) {
      url.searchParams.set(
        "response-content-disposition",
        `attachment; filename="${key.split("/").pop() ?? "download"}"`,
      );
    }
    const signed = await s3Client(cfg).sign(url, {
      aws: { signQuery: true },
    });
    return signed.toString();
  },
};

/* ------------------------------------------------------------------ */
/* Vercel Blob driver                                                  */
/* ------------------------------------------------------------------ */

const blobDriver: ObjectStorage = {
  driver: "vercel-blob",
  async put(key, data, contentType) {
    const { put } = await import("@vercel/blob");
    await put(key, data, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });
    return { key, bytes: data.byteLength };
  },
  async get(key) {
    try {
      const { head } = await import("@vercel/blob");
      const meta = await head(key);
      const res = await fetch(meta.url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  },
  async delete(key) {
    const { del } = await import("@vercel/blob");
    await del(key);
  },
  async getSignedUrl(key) {
    // Vercel Blob public URLs are already unguessable and CDN-served; there is
    // no private presign API in v1, so we return the public URL directly.
    const { head } = await import("@vercel/blob");
    const meta = await head(key);
    return meta.url;
  },
};

/* ------------------------------------------------------------------ */

let cached: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (cached) return cached;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    cached = blobDriver;
  } else if (process.env.S3_ENDPOINT && process.env.S3_BUCKET) {
    cached = s3Driver;
  } else {
    cached = localDriver;
  }
  return cached;
}
