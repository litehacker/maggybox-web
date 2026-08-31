import { NextResponse } from "next/server";
import { getStorage, verifyLocalSignature } from "@maggybox/storage";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  mid: "audio/midi",
  midi: "audio/midi",
  stl: "model/stl",
  wav: "audio/wav",
};

/**
 * GET /api/files/{key...} — local-storage-driver artifact server.
 * Only reachable via the HMAC-signed, short-lived URLs produced by
 * @maggybox/storage's local driver (see packages/storage).
 */
export async function GET(
  req: Request,
  { params }: { params: { key: string[] } },
): Promise<NextResponse> {
  const key = params.key.map(decodeURIComponent).join("/");
  const url = new URL(req.url);

  if (!verifyLocalSignature(key, url.searchParams.get("expires"), url.searchParams.get("signature"))) {
    // Do not leak artifact existence for invalid or expired signatures.
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  const storage = getStorage();
  const data = await storage.get(key);
  if (!data) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const filename = key.split("/").pop() ?? "download";
  const disposition = url.searchParams.get("dl") === "1" ? "attachment" : "inline";

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
