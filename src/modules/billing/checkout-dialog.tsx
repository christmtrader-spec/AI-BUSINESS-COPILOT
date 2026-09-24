"use client";

/**
 * Sandbox checkout dialog — Prompt 22.
 *
 * The in-app "hosted page" of the MOCK provider. It is explicitly labeled
 * as a sandbox (no real money) and drives the REAL payment pipeline: the
 * buttons call the simulate endpoint, which produces the byte-identical
 * SIGNED webhook a live gateway would POST and pushes it through
 * verification → idempotent fulfillment. Nothing client-side ever asserts
 * "paid" — the dialog only renders server session state (§23/§24).
 */
import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/payments/pricing";
import {
  useCheckoutSession,
  useInvalidateBilling,
  useSimulateCheckout,
} from "@/hooks/use-billing";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

export function CheckoutDialog({
  checkoutId,
  planName,
  onClose,
}: {
  checkoutId: string | null;
  planName: string;
  onClose: () => void;
}) {
  const t = useTranslations("billing.checkout");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const invalidateBilling = useInvalidateBilling();

  const sessionQ = useCheckoutSession(checkoutId, !!checkoutId);
  const simulate = useSimulateCheckout();
  const session = sessionQ.data?.checkoutSession ?? null;
  const status = session?.status ?? null;

  const amount = useMemo(
    () =>
      session ? formatMinor(session.amountMinor, session.currency, locale) : "",
    [session, locale],
  );

  // Toast on terminal transitions (effect keyed on status, not renders).
  useEffect(() => {
    if (!status) return;
    if (status === "SUCCEEDED") {
      toast({ title: t("successToast") });
      invalidateBilling();
      void queryClient.invalidateQueries({ queryKey: ["billing", "payments"] });
    } else if (status === "FAILED") {
      toast({ title: t("failureToast"), variant: "destructive" });
    } else if (status === "EXPIRED") {
      toast({ title: t("expiredToast") });
    } else if (status === "RECONCILIATION_REQUIRED") {
      toast({ title: t("reconciliationToast") });
    }
  }, [status]);

  const busy = simulate.isPending;
  const isRealProvider = !!session && session.provider !== "mock";
  const terminal =
    status === "SUCCEEDED" || status === "FAILED" || status === "EXPIRED" || status === "RECONCILIATION_REQUIRED";

  // Prompt 23 §40 — the frontend may REDIRECT to the provider's hosted
  // checkout (from the server-stored trusted URL), but the success decision
  // always comes back through server verification. The user never edits
  // amount/currency/business here (§111) — every value is read-only from
  // the server-authoritative session.

  const onSimulate = (outcome: "succeeded" | "failed") => {
    if (!checkoutId) return;
    simulate.mutate(
      { id: checkoutId, outcome },
      {
        onSuccess: (res) => {
          // Immediate state update + poll silence once terminal.
          queryClient.setQueryData(["billing", "checkout", checkoutId], res);
          if (outcome === "succeeded") {
            void queryClient.invalidateQueries({ queryKey: ["billing", "payments"] });
          }
        },
        onError: (error) => {
          const code = error instanceof ApiClientError ? error.code : null;
          toast({
            title: code === "CHECKOUT_STATE_CONFLICT" ? t("conflict") : tErrors("generic"),
            description: error.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={!!checkoutId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" data-testid="checkout-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="text-muted-foreground size-4" aria-hidden="true" />
            {t("dialogTitle")}
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <ShieldCheck className="size-3" aria-hidden="true" />
              Sandbox
            </Badge>
          </DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        {sessionQ.isLoading || !session ? (
          <div className="space-y-2 py-2">
            <div className="bg-muted h-5 w-2/3 animate-pulse rounded" />
            <div className="bg-muted h-5 w-1/3 animate-pulse rounded" />
          </div>
        ) : (
          <div className="space-y-4" data-testid="checkout-body">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("business")}</dt>
                <dd className="font-medium" data-testid="checkout-business">
                  {session.businessName}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("amount")}</dt>
                <dd className="text-base font-semibold" data-testid="checkout-amount">
                  {amount}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("choosePeriod")}</dt>
                <dd className="font-medium">
                  {session.billingPeriod === "YEARLY" ? t("periodYearly") : t("periodMonthly")}
                </dd>
              </div>
            </dl>
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("settlement")}
            </p>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="checkout-plan">
                  {planName}
                </Badge>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-medium",
                    status === "SUCCEEDED"
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : status === "FAILED"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : status === "RECONCILIATION_REQUIRED"
                          ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400"
                          : status === "PENDING"
                            ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground border-border bg-muted",
                  )}
                  data-testid="checkout-status"
                >
                  {status === "SUCCEEDED" ? (
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                  ) : status === "FAILED" ? (
                    <XCircle className="size-3" aria-hidden="true" />
                  ) : status === "RECONCILIATION_REQUIRED" ? (
                    <AlertTriangle className="size-3" aria-hidden="true" />
                  ) : null}
                  {t(`status_${status}` as "status_PENDING")}
                </Badge>
              </div>
              <span className="text-muted-foreground text-xs">
                {t("providerLabel")}: {session.provider}
              </span>
            </div>

            {status === "PENDING" ? (
              <p className="text-muted-foreground text-xs">
                {t("expiresAt", { date: formatWhen(session.expiresAt, locale) })}
              </p>
            ) : null}

            <Separator />

            {!terminal && isRealProvider ? (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    // §40 — redirect to the provider-hosted checkout from the
                    // server-stored trusted URL; success is decided ONLY by
                    // server verification after the return.
                    if (session?.redirectUrl) {
                      window.location.assign(session.redirectUrl);
                    }
                  }}
                  disabled={!session?.redirectUrl}
                  data-testid="checkout-go-provider"
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  {t("goToProvider")}
                </Button>
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {t("providerNote")}
                </p>
              </>
            ) : null}

            {!terminal && !isRealProvider ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => onSimulate("succeeded")}
                  disabled={busy}
                  data-testid="checkout-pay"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {t("payNow")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSimulate("failed")}
                  disabled={busy}
                  data-testid="checkout-simulate-fail"
                >
                  {t("simulateFail")}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                  status === "SUCCEEDED"
                    ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : status === "RECONCILIATION_REQUIRED"
                      ? "border border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400"
                      : "border border-destructive/30 bg-destructive/10 text-destructive",
                )}
                role="status"
                data-testid="checkout-terminal"
              >
                {status === "SUCCEEDED" ? (
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                ) : status === "RECONCILIATION_REQUIRED" ? (
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="size-4 shrink-0" aria-hidden="true" />
                )}
                {status === "SUCCEEDED"
                  ? t("successToast")
                  : status === "RECONCILIATION_REQUIRED"
                    ? t("reconciliationToast")
                    : t("failureToast")}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
