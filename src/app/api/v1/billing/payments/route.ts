/**
 * GET /api/v1/billing/payments — subscription payment history (Prompt 22).
 *
 * Read-only history of PaymentTransactions for the caller's business.
 * Any member may view (informational — same posture as the subscription
 * read); the server applies lazy expiry to stale PENDING sessions first
 * so history and session status never disagree.
 *
 * `?format=csv` streams the same rows as a BOM+CRLF CSV download
 * (formula-injection-guarded via csvCell — same serialization as every
 * other export in the app).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { listPayments } from "@/lib/payments";
import { csvCell } from "@/lib/csv";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  const url = new URL(req.url);
  const take = Math.min(Math.max(Number(url.searchParams.get("take") ?? 50) || 50, 1), 200);

  const { items, total } = await listPayments(ctx.businessId, { take });

  if (url.searchParams.get("format") === "csv") {
    const limit = rateLimit(`payments-export:${ctx.userId}`, 10, 5 * 60_000);
    if (!limit.allowed) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many exports in a short time. Please wait a moment.",
        { retryAfterMs: limit.retryAfterMs },
      );
    }

    const lines: string[] = [];
    lines.push(
      csvRow([
        "processed_at",
        "status",
        "plan_code",
        "billing_period",
        "amount_minor",
        "currency",
        "provider",
        "checkout_session_id",
      ]),
    );
    for (const p of items) {
      lines.push(
        csvRow([
          p.processedAt,
          p.status,
          p.planCode,
          p.billingPeriod,
          p.amountMinor,
          p.currency,
          p.provider,
          p.checkoutSessionId,
        ]),
      );
    }

    const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `payments-${stamp}.csv`;

    void audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data.export",
      entityType: "PaymentsCSV",
      entityId: null,
      after: { format: "csv", rows: items.length },
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  return ok({ items, total });
});
