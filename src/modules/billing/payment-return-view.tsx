"use client";

/**
 * Payment return view — Prompt 23 §41-§44, §139.
 *
 * The page a user lands on after a redirect-based provider sends them back
 * (callback API → 302 → /?payment_return=<sessionId>). HARD RULES:
 * - It NEVER asserts "payment successful" from URL/query state (§42) —
 *   every pixel renders the SERVER's normalized session status.
 * - While the outcome is unknown it says "verifying…" / "being verified"
 *   (§44) — never "failed" unless the server confirmed failure (§43).
 * - Verification is triggered through the rate-limited verify endpoint
 *   (§68 bounded) — once automatically, then only by explicit user action.
 * - RECONCILIATION_REQUIRED is honest and calm: "additional processing",
 *   support can investigate — no scary "failed", no fake success (§139).
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock3,
  CreditCard,
  Loader2,
  XCircle,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { formatMinor } from "@/lib/payments/pricing";
import { useAppStore } from "@/store/app-store";
import {
  useCheckoutSession,
  useInvalidateBilling,
  useVerifyCheckout,
} from "@/hooks/use-billing";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

function formatWhen(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function PaymentReturnView({
  sessionId,
  onDone,
}: {
  sessionId: string;
  /** Clears ?payment_return from the URL and returns to the workspace. */
  onDone: () => void;
}) {
  const t = useTranslations("billing.return");
  const tCheckout = useTranslations("billing.checkout");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const invalidateBilling = useInvalidateBilling();
  const verify = useVerifyCheckout();

  // Reuse the session query (polls every 3s while PENDING — §41 "then query
  // the server for normalized status").
  const sessionQ = useCheckoutSession(sessionId, true);
  const session = sessionQ.data?.checkoutSession ?? null;
  const status = session?.status ?? null;

  // One AUTOMATIC verification attempt for redirect-based providers
  // (§68: bounded — the endpoint itself rate-limits to 10/min/user).
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !session) return;
    autoTried.current = true;
    if (session.status === "PENDING" && session.provider !== "mock") {
      verify.mutate(
        { id: session.id },
        {
          onSuccess: (res) => {
            if (res.session) {
              queryClient.setQueryData(["billing", "checkout", sessionId], {
                checkoutSession: res.session,
              });
            }
          },
        },
      );
    }
  }, [session?.id, session?.status, session?.provider]);

  // Invalidate billing data once a terminal state is visible.
  useEffect(() => {
    if (status === "SUCCEEDED") {
      invalidateBilling();
      void queryClient.invalidateQueries({ queryKey: ["billing", "payments"] });
    }
  }, [status]);

  const amount = session ? formatMinor(session.amountMinor, session.currency, locale) : "";

  const onVerifyNow = () => {
    if (!session) return;
    verify.mutate(
      { id: session.id },
      {
        onSuccess: (res) => {
          if (res.session) {
            queryClient.setQueryData(["billing", "checkout", sessionId], {
              checkoutSession: res.session,
            });
          }
        },
        onError: (error) => {
          toast({
            title:
              error instanceof ApiClientError && error.code === "RATE_LIMITED"
                ? t("rateLimited")
                : t("verifyFailed"),
            description: error.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  const goBilling = () => {
    // Clears ?payment_return (onDone), then navigates through the store so
    // the URL hash is synced by the app's own router logic (never raw hash
    // assignment, which can race the URL cleanup).
    onDone();
    useAppStore.getState().navigate({ kind: "settings:billing" });
  };

  // §41-§44 — title/body derive ONLY from server state; while unknown the
  // copy says "verifying" (never "failed").
  let icon = <Loader2 className="text-muted-foreground size-10 animate-spin" aria-hidden="true" />;
  let title = t("verifyingTitle");
  let body = t("verifyingBody") as string;
  if (session && !sessionQ.isLoading) {
    switch (status) {
      case "SUCCEEDED":
        icon = <CheckCircle2 className="size-10 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />;
        title = t("successTitle");
        body = t("successBody");
        break;
      case "FAILED":
        icon = <XCircle className="text-destructive size-10" aria-hidden="true" />;
        title = t("failedTitle");
        body = t("failedBody");
        break;
      case "EXPIRED":
        icon = <Clock3 className="size-10 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
        title = t("expiredTitle");
        body = t("expiredBody");
        break;
      case "RECONCILIATION_REQUIRED":
        icon = <AlertTriangle className="size-10 text-violet-600 dark:text-violet-400" aria-hidden="true" />;
        title = t("reconciliationTitle");
        body = t("reconciliationBody");
        break;
      case "CANCELED":
        icon = <CreditCard className="text-muted-foreground size-10" aria-hidden="true" />;
        title = t("canceledTitle");
        body = t("canceledBody");
        break;
      default:
        icon = <Loader2 className="text-muted-foreground size-10 animate-spin" aria-hidden="true" />;
        title = t("pendingTitle");
        body =
          session.expiresAt
            ? t("pendingBody", { date: formatWhen(session.expiresAt, locale) })
            : t("pendingBody", { date: "—" });
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-8">
      <div
        className="bg-card w-full max-w-md rounded-xl border shadow-sm"
        data-testid="payment-return"
      >
        <div className="flex flex-col items-center gap-3 px-6 pt-8 text-center">
          {icon}
          <h2 className="text-lg font-semibold" data-testid="payment-return-title">
            {title}
          </h2>
          <p
            className="text-muted-foreground max-w-sm text-sm"
            role="status"
            aria-live="polite"
            data-testid="payment-return-status"
          >
            {body}
          </p>
        </div>

        {session ? (
          <div className="px-6 pt-4">
            <Separator />
            <dl className="grid gap-x-6 gap-y-2 py-4 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("business")}</dt>
                <dd className="font-medium" data-testid="payment-return-business">
                  {session.businessName}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("plan")}</dt>
                <dd className="font-medium">{session.planCode}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{tCheckout("amount")}</dt>
                <dd className="text-base font-semibold" data-testid="payment-return-amount">
                  {amount}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("provider")}</dt>
                <dd className="font-medium capitalize">{session.provider}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="space-y-2 px-6 pt-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2 px-6 pb-6 pt-2">
          {status === "PENDING" && session && session.provider !== "mock" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onVerifyNow}
              disabled={verify.isPending}
              data-testid="payment-return-verify"
            >
              {verify.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRightLeft className="size-4" aria-hidden="true" />
              )}
              {t("verifyNow")}
            </Button>
          ) : null}
          <Button size="sm" onClick={goBilling} data-testid="payment-return-billing">
            {t("goBilling")}
          </Button>
        </div>
      </div>
    </div>
  );
}
