"use client";

/**
 * Platform pricing administration (§34/§35/§36/§37/§94).
 * Displays books/prices from PricingService data — no hard-coded values.
 * IRR (or any currency without an active book) is reported honestly as
 * NOT CONFIGURED (§37) — the UI never invents an IRR price.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { platformMutations, platformQueries, type PlatformPriceBook } from "./platform-api";
import { EmptyState, ListSkeleton, ReauthDialog, StatusBadge, formatDateTime, usePlatformErrorText } from "./kit";

const PLANS = ["STARTER", "BUSINESS", "PRO"];
const PERIODS = ["MONTHLY", "YEARLY"];
const CURRENCIES = ["EUR", "IRR"];

export function PricingView() {
  const t = useTranslations("platform");
  const queryClient = useQueryClient();
  const [activateTarget, setActivateTarget] = React.useState<PlatformPriceBook | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "pricing"],
    queryFn: platformQueries.pricing,
    refetchOnWindowFocus: false,
  });

  if (isLoading) return <ListSkeleton rows={3} />;
  if (isError || !data) return <EmptyState label={t("errors.PLATFORM_INVALID_OPERATION")} />;

  const unconfigured = CURRENCIES.filter(
    (c) => !data.currencyCoverage.some((x) => x.currency === c && x.activeBook),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden="true" />
          {t("pricing.createVersion")}
        </Button>
        {unconfigured.map((c) => (
          <Badge key={c} variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400">
            {t("pricing.notConfigured", { currency: c })}
          </Badge>
        ))}
      </div>

      {data.books.length === 0 ? (
        <EmptyState label={t("pricing.empty")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.books.map((book) => (
            <Card key={book.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="font-mono text-sm" dir="ltr">
                    {book.code} · {book.version}
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    {book.currentlyEffective ? (
                      <StatusBadge status="READY" label={t("pricing.effective")} />
                    ) : book.active ? (
                      <StatusBadge status="ACTIVE" label={t("pricing.active")} />
                    ) : (
                      <StatusBadge status="NOT_CONFIGURED" label={t("pricing.inactive")} />
                    )}
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  {book.currency} · {formatDateTime(book.effectiveFrom)} →{" "}
                  {book.effectiveTo ? formatDateTime(book.effectiveTo) : "∞"}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  {book.prices.map((p) => (
                    <div key={`${p.planCode}-${p.billingPeriod}`} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs">
                        {p.planCode}/{p.billingPeriod === "MONTHLY" ? "mo" : "yr"}
                      </span>
                      <span className="tabular-nums" dir="ltr">
                        {new Intl.NumberFormat(undefined, {
                          minimumFractionDigits: book.currency === "IRR" ? 0 : 2,
                        }).format(p.amountMinor / (book.currency === "IRR" ? 1 : 100))}{" "}
                        {book.currency}
                      </span>
                    </div>
                  ))}
                </div>
                <Separator />
                {!book.active ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setActivateTarget(book)}
                  >
                    <ShieldCheck className="size-3.5" aria-hidden="true" />
                    {t("pricing.activate")}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {activateTarget ? (
        <ActivateBookDialog
          book={activateTarget}
          onClose={() => setActivateTarget(null)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "pricing"] })}
        />
      ) : null}
      {createOpen ? (
        <CreateBookDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ["platform", "pricing"] })}
        />
      ) : null}
    </div>
  );
}

function ActivateBookDialog({ book, onClose, onDone }: { book: PlatformPriceBook; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <ReauthDialog
      open
      onOpenChange={(open) => !open && onClose()}
      titleKey="dialogs.activateBookTitle"
      descriptionKey="dialogs.activateBookBody"
      values={{ code: book.code, version: book.version, currency: book.currency }}
      submitting={submitting}
      error={error}
      onSubmit={({ reason, password }) => {
        setSubmitting(true);
        setError(null);
        platformMutations
          .activatePriceBook(book.id, { reason, password })
          .then(() => {
            toast.success(t("pricing.activateSuccess"));
            onDone();
            onClose();
          })
          .catch((e) => setError(tError(e)))
          .finally(() => setSubmitting(false));
      }}
    />
  );
}

/** Create-version dialog: two steps (rows → reauth). All inputs validated
 *  again server-side by createPriceBookVersion (§35). */
function CreateBookDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations("platform");
  const tError = usePlatformErrorText();
  const [step, setStep] = React.useState<"rows" | "reauth">("rows");
  const [code, setCode] = React.useState("EUR_STANDARD");
  const [version, setVersion] = React.useState("");
  const [currency, setCurrency] = React.useState("EUR");
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const rows = PLANS.flatMap((plan) =>
    PERIODS.map((period) => ({
      planCode: plan,
      billingPeriod: period,
      amountMinor: Number(amounts[`${plan}:${period}`] ?? ""),
    })),
  );
  const complete = rows.every((r) => Number.isSafeInteger(r.amountMinor) && r.amountMinor > 0);

  const submit = () => {
    setSubmitting(true);
    setError(null);
    platformMutations
      .createPriceBook({
        code,
        version,
        currency,
        effectiveFrom: new Date().toISOString(),
        prices: rows,
        reason,
        password,
      })
      .then(() => {
        toast.success(t("pricing.createSuccess"));
        onDone();
        onClose();
      })
      .catch((e) => setError(tError(e)))
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pricing.createTitle")}</DialogTitle>
          <DialogDescription>{t("pricing.createBody")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pf-book-code">{t("pricing.code")}</Label>
              <Input id="pf-book-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-book-version">{t("pricing.version")}</Label>
              <Input id="pf-book-version" dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v2-2026-10" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-book-currency">{t("pricing.currency")}</Label>
            <Input id="pf-book-currency" dir="ltr" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            {PLANS.flatMap((plan) =>
              PERIODS.map((period) => {
                const key = `${plan}:${period}`;
                return (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`pf-amt-${key}`} className="text-xs">
                      {plan}/{period === "MONTHLY" ? "mo" : "yr"} ({t("pricing.amountMinorHint")})
                    </Label>
                    <Input
                      id={`pf-amt-${key}`}
                      dir="ltr"
                      inputMode="numeric"
                      value={amounts[key] ?? ""}
                      onChange={(e) =>
                        setAmounts((a) => ({ ...a, [key]: e.target.value.replace(/[^\d]/g, "") }))
                      }
                    />
                  </div>
                );
              }),
            )}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!complete || !version.trim() || submitting} onClick={() => setStep("reauth")}>
            {t("subscriptions.continue")}
          </Button>
        </DialogFooter>
        {step === "reauth" ? (
          <ReauthDialog
            open
            onOpenChange={(open) => !open && setStep("rows")}
            titleKey="dialogs.createBookTitle"
            descriptionKey="dialogs.createBookBody"
            values={{ code, version, currency }}
            submitting={submitting}
            error={error}
            onSubmit={({ reason: r, password: p }) => {
              setReason(r);
              setPassword(p);
              submit();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
