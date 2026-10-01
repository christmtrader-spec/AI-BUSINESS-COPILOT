"use client";

/**
 * Prompt 34 — shared EntityHeader (§24/§76).
 * Back button + breadcrumb + icon + title + type badge + actions slot +
 * copy-deep-link quick action (the URL bar is the shareable deep link).
 * Responsive (stacks on mobile), RTL-safe (logical utilities only).
 */

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** Copies the current hash deep link (§38/§39) to the clipboard. */
function useCopyDeepLink() {
  const t = useTranslations("entityDetail");
  return async function copyDeepLink() {
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Clipboard API unavailable (older WebView / insecure context):
        // fall back to a transient textarea + execCommand.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: t("linkCopied") });
    } catch {
      // Never destructive — just report the copy failed.
      toast({ title: t("linkCopied"), description: url, variant: "destructive" });
    }
  };
}

export function EntityHeader({
  icon: Icon,
  title,
  subtitle,
  badge,
  backLabel,
  onBack,
  avatarInitials,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** Small line under the title (e.g. contact info). */
  subtitle?: string | null;
  /** Optional status badge node (already localized). */
  badge?: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  /** 2-letter avatar initials (parties); omit to show the plain icon. */
  avatarInitials?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  const tCommon = useTranslations("common");
  const tEntity = useTranslations("entityDetail");
  const copyDeepLink = useCopyDeepLink();
  return (
    <header className={cn("relative flex flex-col gap-4 sm:flex-row sm:items-start", className)}>
      {/* Back + identity block */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={backLabel}
          className="text-muted-foreground hover:text-foreground -ms-2 w-fit"
        >
          <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {backLabel}
        </Button>
        <div className="flex items-start gap-3">
          {avatarInitials ? (
            <Avatar className="size-11 ring-1 ring-border">
              <AvatarFallback className="bg-emerald-500/10 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                {avatarInitials}
              </AvatarFallback>
            </Avatar>
          ) : (
            <span className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-lg">
              <Icon className="size-5" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold sm:text-2xl" dir="auto">
                {title}
              </h1>
              {badge}
            </div>
            <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate" dir="auto">
                {subtitle}
              </span>
            </p>
          </div>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void copyDeepLink()}
        aria-label={tEntity("copyLink")}
        title={tEntity("copyLink")}
        className="text-muted-foreground hover:text-foreground absolute end-3 top-3 size-8 sm:static sm:end-auto sm:top-auto sm:size-8"
      >
        <Link2 className="size-4" aria-hidden="true" />
      </Button>
      <span className="sr-only">{tCommon("appName")}</span>
    </header>
  );
}

/** Breadcrumb trail (§24) — list module › record. Non-navigating parents
 *  are plain text; the trail complements (not replaces) the back button. */
export function EntityBreadcrumb({
  listLabel,
  title,
}: {
  listLabel: string;
  title: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <li className="max-w-40 truncate">{listLabel}</li>
        <li aria-hidden="true">/</li>
        <li className="text-foreground max-w-48 truncate" dir="auto">
          {title}
        </li>
      </ol>
    </nav>
  );
}

/** Entity-type badge next to the title (not color-only — §46). */
export function EntityTypeBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 font-medium">
      {label}
    </Badge>
  );
}
