"use client";

/**
 * Prompt 34 — localized, state-distinguishing error view (§49).
 * Maps the ApiClientError code to a safe, localized message. Never
 * exposes Prisma errors, stacks, or internal details (§49/§66).
 */

import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ApiClientError } from "@/lib/api-client";

export function EntityError({
  error,
  onRetry,
  backToList,
  onBackToList,
}: {
  error: unknown;
  onRetry: () => void;
  backToList: string;
  onBackToList: () => void;
}) {
  const t = useTranslations("entityDetail");
  const code = error instanceof ApiClientError ? error.code : null;
  const status = error instanceof ApiClientError ? error.status : null;

  let text: string;
  if (code === "PERMISSION_DENIED" || status === 403) {
    text = t("unauthorized");
  } else if (code === "RATE_LIMITED") {
    text = t("rateLimited");
  } else if (status === 401 || code === "UNAUTHENTICATED" || code === "SESSION_INVALIDATED") {
    text = t("unauthorized");
  } else {
    text = t("loadFailed");
  }

  const retryable = code !== "PERMISSION_DENIED" && status !== 403 && status !== 401;

  return (
    <div
      role="alert"
      className="bg-card text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-xl border px-6 py-12 text-center text-sm"
    >
      <span className="flex size-10 items-center justify-center rounded-full border">
        {status === 403 || code === "PERMISSION_DENIED" ? (
          <ShieldAlert className="text-amber-600 dark:text-amber-400 size-5" aria-hidden="true" />
        ) : (
          <AlertTriangle className="text-destructive size-5" aria-hidden="true" />
        )}
      </span>
      <p>{text}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBackToList}>
          {backToList}
        </Button>
        {retryable ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {status === 429 ? <Loader2 className="size-4" aria-hidden="true" /> : null}
            {t("retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
