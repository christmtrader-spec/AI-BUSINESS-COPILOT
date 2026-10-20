/**
 * GET /api/v1/imports/[jobId]/errors — downloadable bounded error report
 * (Prompt 31 §98/§173). Columns: row_number, field, error_code, message.
 * NO passwords, security data, session data or raw row values (§98/§322).
 * Stable error codes (§192); human messages follow the Accept-Language.
 */
import { NextRequest } from "next/server";
import { ApiError, getClientIp, route } from "@/lib/api-helpers";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { buildErrorReportCsv, assertImportRole } from "@/lib/data-portability/import-service";
import { isLocale, type Locale } from "@/i18n/config";

export const dynamic = "force-dynamic";

const MESSAGES: Record<Locale, Record<string, string>> = {
  en: {
    ROW_REQUIRED_FIELD_MISSING: "A required field is empty.",
    ROW_INVALID_EMAIL: "Invalid email format.",
    ROW_INVALID_PHONE: "Invalid phone format.",
    ROW_INVALID_AMOUNT: "Invalid amount (use an exact decimal, e.g. 12.50).",
    ROW_INVALID_NUMBER: "Invalid whole number.",
    ROW_INVALID_BOOLEAN: "Use true or false.",
    ROW_VALUE_TOO_LONG: "Value is too long.",
    ROW_DUPLICATE: "Duplicate of an existing record or an earlier row.",
    ROW_FOREIGN_REFERENCE_NOT_FOUND: "Referenced record not found.",
    ROW_UNSUPPORTED_FIELD: "This field is not importable.",
    ROW_INVALID_DATE: "Invalid date (ISO 8601 or Jalali, e.g. 1404/07/01).",
  },
  fa: {
    ROW_REQUIRED_FIELD_MISSING: "یک فیلد الزامی خالی است.",
    ROW_INVALID_EMAIL: "قالب ایمیل نامعتبر است.",
    ROW_INVALID_PHONE: "قالب شماره تلفن نامعتبر است.",
    ROW_INVALID_AMOUNT: "مبلغ نامعتبر است (عدد دقیق وارد کنید، مانند 12.50).",
    ROW_INVALID_NUMBER: "عدد صحیح نامعتبر است.",
    ROW_INVALID_BOOLEAN: "از true یا false استفاده کنید.",
    ROW_VALUE_TOO_LONG: "مقدار بیش از حد طولانی است.",
    ROW_DUPLICATE: "تکراریِ یک رکورد موجود یا یک ردیف قبلی است.",
    ROW_FOREIGN_REFERENCE_NOT_FOUND: "رکورد ارجاع‌شده یافت نشد.",
    ROW_UNSUPPORTED_FIELD: "این فیلد قابل درون‌ریزی نیست.",
    ROW_INVALID_DATE: "تاریخ نامعتبر است (میلادی ISO 8601 یا شمسی مانند ۱۴۰۴/۰۷/۰۱).",
  },
};

export const GET = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }

  const limit = rateLimit(`imports-errors:${ctx.userId}:${getClientIp(req)}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const accept = req.headers.get("accept-language") ?? "en";
  const locale: Locale = isLocale(accept.split(",")[0]?.split("-")[0]) ? (accept.split(",")[0].split("-")[0] as Locale) : "en";
  const messages = MESSAGES[locale];

  const report = await buildErrorReportCsv(
    ctx.businessId,
    jobId,
    (code, field) => `${code}${field ? ` (${field})` : ""}: ${messages[code] ?? code}`,
  );
  if (!report) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "No error report is available for this import.");
  }
  return new NextResponse(report.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${report.fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
