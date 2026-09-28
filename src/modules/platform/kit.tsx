"use client";

/**
 * Platform view kit — shared primitives for the console views (§88/§92/
 * §98/§117/§137): status badges that never rely on color alone, bounded
 * pagination controls, the reauthentication dialog used by EVERY sensitive
 * mutation (§56), and a safe error → message mapper (§86/§137 — no stack
 * traces, no raw Prisma text).
 */
import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api-client";

/* ------------------------------ status badges ----------------------------- */

export type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info";

const TONE_CLASS: Record<BadgeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warning: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
  info: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

/** Map a raw status token to a tone — labels come from i18n at the caller. */
export function toneOf(status: string): BadgeTone {
  switch (status) {
    case "ACTIVE":
    case "SUCCEEDED":
    case "READY":
    case "CONFIGURED":
    case "KNOWN":
    case "COMPARABLE":
    case "RESOLVED":
      return "success";
    case "TRIALING":
    case "PENDING":
    case "PAST_DUE":
    case "RECONCILIATION_REQUIRED":
    case "NOT_CONFIGURED":
    case "UNKNOWN":
    case "OPEN":
    case "UNDER_REVIEW":
      return "warning";
    case "EXPIRED":
    case "FAILED":
    case "BLOCKED":
    case "CANCELED":
    case "CRITICAL":
    case "PLATFORM_OPERATOR_INACTIVE":
      return "danger";
    case "PAUSED":
    case "DISABLED":
    case "ACKNOWLEDGED":
    case "INFO":
    case "PARTIAL":
    case "PARTIAL_TOKEN_DATA":
      return "info";
    default:
      return "neutral";
  }
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge variant="outline" className={`${TONE_CLASS[toneOf(status)]} whitespace-nowrap`}>
      {label}
    </Badge>
  );
}

/* ------------------------------- pagination ------------------------------- */

export function PaginationBar({
  page,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("platform");
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-muted-foreground text-xs">
        {t("pagination.page", { page })}
      </span>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={onPrev}>
        {t("pagination.prev")}
      </Button>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
        {t("pagination.next")}
      </Button>
    </div>
  );
}

/* ----------------------------- reauth dialog ------------------------------ */

export type ReauthDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** i18n key under platform.dialogs for the title. */
  titleKey: string;
  /** i18n key under platform.dialogs for the description. */
  descriptionKey: string;
  values?: Record<string, string | number>;
  /** Extra typed confirmation (e.g. "RECONCILE") — when required (§46). */
  typedConfirmation?: { expected: string };
  submitting: boolean;
  error?: string | null;
  onSubmit: (payload: { reason: string; password: string; confirmation: string; note?: string }) => void;
  /** Show the note textarea (bounded, safe internal note). */
  note?: boolean;
};

export function ReauthDialog({
  open,
  onOpenChange,
  titleKey,
  descriptionKey,
  values,
  typedConfirmation,
  submitting,
  error,
  onSubmit,
  note,
}: ReauthDialogProps) {
  const t = useTranslations("platform");
  const [reason, setReason] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [noteText, setNoteText] = React.useState("");

  // Exit-animation safety: Radix keeps DialogContent mounted briefly after
  // the caller clears its target state. Remember the last non-null values so
  // the title/description interpolate without a FORMATTING_ERROR during that
  // transient render. Uses the React-sanctioned "adjust state during render"
  // pattern (no setState-in-effect, no ref reads while rendering).
  const [lastValues, setLastValues] = React.useState(values);
  if (values !== undefined && values !== lastValues) {
    setLastValues(values);
  }
  const renderValues = (values ?? lastValues ?? {}) as Record<string, string | number>;

  React.useEffect(() => {
    if (open) {
      setReason("");
      setPassword("");
      setConfirmation("");
      setNoteText("");
    }
  }, [open]);

  const confirmationOk =
    !typedConfirmation ||
    confirmation.trim().toUpperCase() === typedConfirmation.expected.toUpperCase();

  const canSubmit =
    reason.trim().length >= 3 && password.length > 0 && confirmationOk && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(titleKey as Parameters<typeof t>[0], renderValues)}</DialogTitle>
          <DialogDescription>{t(descriptionKey as Parameters<typeof t>[0], renderValues)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="platform-reason">{t("dialogs.reason")}</Label>
            <Textarea
              id="platform-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder={t("dialogs.reasonPlaceholder")}
            />
          </div>
          {note ? (
            <div className="space-y-2">
              <Label htmlFor="platform-note">{t("dialogs.note")}</Label>
              <Textarea
                id="platform-note"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                maxLength={500}
              />
            </div>
          ) : null}
          {typedConfirmation ? (
            <div className="space-y-2">
              <Label htmlFor="platform-confirm">
                {t("dialogs.typedConfirmation", { word: typedConfirmation.expected })}
              </Label>
              <Input
                id="platform-confirm"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                dir="ltr"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="platform-password">{t("dialogs.currentPassword")}</Label>
            <Input
              id="platform-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <p className="text-muted-foreground text-xs">{t("dialogs.reauthHint")}</p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                reason: reason.trim(),
                password,
                confirmation: confirmation.trim().toUpperCase(),
                ...(note ? { note: noteText } : {}),
              })
            }
          >
            {submitting ? t("common.working") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- misc bits ------------------------------- */

/** Field label + value row (detail grids). */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground border-border/60 rounded-md border border-dashed p-8 text-center text-sm">
      {label}
    </div>
  );
}

/** Map an ApiClientError to a localized, safe message (§86/§137). */
export function usePlatformErrorText() {
  const tErr = useTranslations("platform.errors");
  return React.useCallback(
    (error: unknown): string => {
      if (error instanceof ApiClientError) {
        const code = error.code;
        const knownKeys = [
          "PLATFORM_UNAUTHENTICATED",
          "PLATFORM_FORBIDDEN",
          "PLATFORM_OPERATOR_INACTIVE",
          "PLATFORM_PERMISSION_DENIED",
          "PLATFORM_REAUTH_REQUIRED",
          "PLATFORM_REAUTH_FAILED",
          "PLATFORM_LAST_ADMIN_PROTECTED",
          "PLATFORM_INVALID_OPERATION",
          "PLATFORM_PAYMENT_REVERIFY_REQUIRED",
          "PLATFORM_PRICEBOOK_INVALID",
          "PLATFORM_AI_RATE_INVALID",
          "PLATFORM_RECONCILIATION_BLOCKED",
          "SUBSCRIPTION_NOT_FOUND",
          "INVALID_SUBSCRIPTION_STATE",
          "INVALID_PLAN",
          "TRIAL_DISABLED",
          "BUSINESS_NOT_ELIGIBLE",
          "SESSION_INVALIDATED",
        ];
        if ((knownKeys as string[]).includes(code)) {
          return tErr(code as Parameters<typeof tErr>[0]);
        }
        return error.message || tErr("PLATFORM_INVALID_OPERATION");
      }
      return tErr("PLATFORM_INVALID_OPERATION");
    },
    [tErr],
  );
}

/** Format an integer minor-unit amount with its explicit currency (§89). */
export function formatMinor(amountMinor: number, currency: string): string {
  const digits = currency === "IRR" ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor / 10 ** digits} ${currency}`;
  }
}

/** Compact label for a big integer (counts). */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 99_999 ? "compact" : "standard" }).format(value);
}

export function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}
