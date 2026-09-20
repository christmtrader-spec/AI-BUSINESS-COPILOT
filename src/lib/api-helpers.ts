/**
 * API pipeline helpers — Constitution §7 (API principles).
 * Every route returns a predictable envelope:
 *   { ok: true, data } | { ok: false, error: { code, message } }
 * Internal details (stack traces, DB errors) are never leaked.
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data } satisfies ApiEnvelope<T>, { status });
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, details } } satisfies ApiEnvelope<never>,
    { status },
  );
}

/** Map any thrown error to a safe response. Unknown errors are logged server-side only. */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    return fail(422, "VALIDATION_ERROR", "The submitted data is invalid.", error.issues);
  }
  console.error("[api] unhandled error:", error);
  return fail(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}

/** Wrap a route handler with consistent error mapping. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** Parse + validate a JSON body with zod. */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "BAD_JSON", "Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
