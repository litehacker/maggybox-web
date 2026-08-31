import { NextResponse } from "next/server";
import { makeError, type ErrorCode } from "@maggybox/contracts";

/** Spec-conformant JSON error envelope. */
export function errorResponse(status: number, code: ErrorCode, message: string): NextResponse {
  return NextResponse.json(makeError(code, message), { status });
}

export function notFound(): NextResponse {
  return errorResponse(404, "NOT_FOUND", "Transcription not found");
}

export function notReady(artifact: string): NextResponse {
  return errorResponse(409, "NOT_READY", `${artifact} is not ready yet`);
}

export function internal(message = "Internal error"): NextResponse {
  return errorResponse(500, "INTERNAL", message);
}
