"use client";

/**
 * Plan-limit banner — Prompt 20 (§42/§89: the UI can indicate that the
 * business is at/over its plan limit). INFORMATIONAL ONLY: the server
 * enforces the same limits on every create (§26) — this banner just makes
 * the structured 422s predictable instead of surprising.
 *
 * Renders for a specific LIMIT entitlement when usage >= limit; includes
 * an Upgrade action that jumps to Settings → Subscription.
 */
import { useTranslations } from "next-intl";
import { CircleAlert, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { useEntitlements } from "@/hooks/use-billing";
import { Button } from "@/components/ui/button";

export function PlanLimitBanner({ code, enabled = true }: { code: string; enabled?: boolean }) {
  const t = useTranslations("billing");
  const navigate = useAppStore((s) => s.navigate);
  const { data, isLoading } = useEntitlements(enabled);

  if (!enabled || isLoading || !data) return null;
  const u = data.usage?.[code];
  if (!u || u.limit === null || u.used < u.limit) return null;

  const over = u.used > u.limit;
  const label = t(`entitlement.${code}` as "entitlement.CUSTOMERS_MAX");

  return (
    <div
      role="status"
      data-testid={`plan-limit-banner-${code}`}
      className={
        over
          ? "flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          : "flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
      }
    >
      <span className="flex items-center gap-2">
        <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
        <span>
          <strong>{over ? t("overLimit") : t("atLimit")}</strong> ·{" "}
          {t("limitReachedDesc", { feature: label, limit: u.limit })}
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate({ kind: "settings:billing" })}
        className="shrink-0"
      >
        {t("upgrade")}
      </Button>
    </div>
  );
}

/** Tiny spinner used by views while the entitlements query warms up. */
export function PlanLimitSpinner() {
  return <Loader2 className="size-4 animate-spin" aria-hidden="true" />;
}
