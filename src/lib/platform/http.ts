/**
 * Platform HTTP helpers — Prompt 28 (§36/§69/§70/§71/§86/§136).
 *
 * Every platform LIST endpoint is paginated with an explicit maximum page
 * size, stable sort and total/hasNext metadata. Sort/filter fields always
 * come from EXPLICIT allowlists — an arbitrary request string can never
 * become a Prisma field name (§71).
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { platformError } from "./auth";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export type Pagination = { page: number; pageSize: number; skip: number };

export function parsePagination(searchParams: URLSearchParams): Pagination {
  const rawPage = Number(searchParams.get("page") ?? "1");
  const rawSize = Number(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, 10_000) : 1;
  const pageSize =
    Number.isInteger(rawSize) && rawSize >= 1 ? Math.min(rawSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export function pageMeta(p: Pagination, total: number): PageMeta {
  return {
    page: p.page,
    pageSize: p.pageSize,
    total,
    hasNext: p.skip + p.pageSize < total,
    hasPrev: p.page > 1,
  };
}

/** Parse + validate a JSON body with zod (platform-flavored errors). */
export async function parsePlatformBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw platformError(400, "PLATFORM_INVALID_OPERATION", "Request body must be valid JSON.");
  }
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw platformError(422, "PLATFORM_INVALID_OPERATION", "The submitted data is invalid.", {
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw error;
  }
}

/** Pick the FIRST query value of a param (no arrays) and bound its length. */
export function queryFilter(searchParams: URLSearchParams, key: string, maxLen = 128): string | undefined {
  const value = searchParams.get(key)?.trim();
  if (!value) return undefined;
  return value.slice(0, maxLen);
}

/** Parse an ISO-date query param (`to` gets end-of-day semantics). */
export function queryDate(searchParams: URLSearchParams, key: string, endOfDay = false): Date | undefined {
  const raw = searchParams.get(key)?.trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Consistent envelope for platform routes ({ ok, data } like tenant APIs).
 *  BigInt-safe: ledger amounts (nano-minor) are BigInt end-to-end — they are
 *  stringified here so a response can never explode JSON.stringify (§37). */
function bigIntSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigIntSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, bigIntSafe(v)]),
    );
  }
  return value;
}

export function platformOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data: bigIntSafe(data) }, { status });
}
