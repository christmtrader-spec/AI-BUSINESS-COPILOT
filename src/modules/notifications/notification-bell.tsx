"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bell, CheckCircle2, Info, Settings2, TriangleAlert, XCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { NotificationDTO, ListNotificationsResult } from "./types";

/**
 * Notification bell + drawer — Prompt 32 §106/§107/§108/§113/§373/§374.
 *
 * - The unread count is a BOUNDED query polled conservatively (§179) and
 *   paused while the tab is hidden (§416/§417); no websockets, no
 *   service workers (§180/§181).
 * - The badge caps the VISUAL display at 99+ (§107) while the API returns
 *   the exact count.
 * - Fully keyboard accessible: the trigger is a labeled button, items are
 *   buttons, Escape closes (Radix), the drawer has a dialog role (§373/§374).
 * - Unread state NEVER relies on color alone: dot + bold + aria (§111).
 * - Severity uses icons + text, never color alone (§112).
 */

export const unreadCountQueryKey = ["notifications", "unread-count"] as const;
export const notificationsQueryKey = (category: string) => ["notifications", "list", category] as const;

const SEVERITY_ICON: Record<string, typeof Info> = {
  INFO: Info,
  SUCCESS: CheckCircle2,
  WARNING: TriangleAlert,
  ERROR: XCircle,
};

export function timeAgoLabel(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale === "fa" ? "fa" : "en", { numeric: "auto" });
  if (minutes < 1) return rtf.format(0, "minute");
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
    dateStyle: "medium",
  }).format(new Date(iso));
}

export function useUnreadCount(enabled: boolean) {
  return useQuery<number>({
    queryKey: unreadCountQueryKey,
    queryFn: async () => {
      const res = await fetch("/api/v1/me/notifications/unread-count", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const body = (await res.json()) as { data: { count: number } };
      return body.data.count;
    },
    enabled,
    refetchInterval: 45_000,
    // §416/§417 — never poll aggressively while the tab is hidden.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
    staleTime: 15_000,
  });
}

export function useMarkReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/me/notifications/${id}/read`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return true;
    },
    // §414 — invalidate both the lists and the unread count.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useMarkAllReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/v1/me/notifications/read-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return true;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function NotificationItemRow({
  item,
  locale,
  onNavigate,
  compact,
}: {
  item: NotificationDTO;
  locale: string;
  onNavigate?: (item: NotificationDTO) => void;
  compact?: boolean;
}) {
  const t = useTranslations("notifications");
  const markRead = useMarkReadMutation();
  const Icon = SEVERITY_ICON[item.severity] ?? Info;
  const unread = item.readAt === null;

  return (
    <button
      type="button"
      onClick={() => {
        // §105 — read state never blocks navigation: fire-and-forget.
        if (unread) markRead.mutate(item.id);
        onNavigate?.(item);
      }}
      className={cn(
        "hover:bg-accent/60 focus-visible:bg-accent/60 flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-start transition-colors motion-reduce:transition-none",
        unread && "bg-accent/30",
      )}
      aria-label={item.title}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          item.severity === "SUCCESS" && "text-emerald-600 dark:text-emerald-400",
          item.severity === "WARNING" && "text-amber-600 dark:text-amber-400",
          item.severity === "ERROR" && "text-red-600 dark:text-red-400",
          item.severity === "INFO" && "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {unread ? (
            <span
              aria-label={t("unreadDotLabel")}
              role="img"
              className="bg-primary size-2 shrink-0 rounded-full"
            />
          ) : (
            <span className="w-2 shrink-0" />
          )}
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-normal")}>
            {item.title}
          </span>
        </span>
        <span className={cn("text-muted-foreground mt-0.5 block text-xs leading-relaxed", compact ? "line-clamp-2" : "line-clamp-3")}>
          {item.body}
        </span>
        <span className="text-muted-foreground/80 mt-1 block text-[11px]">
          {timeAgoLabel(item.createdAt, locale)}
          {item.businessName ? ` · ${t("businessContext", { name: item.businessName })}` : ""}
        </span>
      </span>
    </button>
  );
}

function BellPanelContent({
  onItemNavigate,
  close,
}: {
  onItemNavigate: (item: NotificationDTO) => void;
  close: () => void;
}) {
  const t = useTranslations("notifications");
  const locale = useAppStore((s) => s.locale);
  const navigate = useAppStore((s) => s.navigate);
  const markAllRead = useMarkAllReadMutation();

  const { data, isLoading, isError } = useQuery<ListNotificationsResult>({
    queryKey: notificationsQueryKey("recent"),
    queryFn: () => api<ListNotificationsResult>("/api/v1/me/notifications?pageSize=10"),
    staleTime: 10_000,
  });

  function go(item: NotificationDTO) {
    onItemNavigate(item);
    close();
  }

  return (
    <div className="flex max-h-[70vh] flex-col" data-testid="notification-panel">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-sm font-semibold">{t("panelTitle")}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={markAllRead.isPending || (data?.items.length ?? 0) === 0}
          onClick={() => markAllRead.mutate()}
          data-testid="notification-mark-all"
        >
          {t("markAllRead")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isLoading ? (
          <div className="space-y-2 p-3">
            <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
            <div className="bg-muted h-3 w-full animate-pulse rounded" />
            <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
          </div>
        ) : isError ? (
          <p className="text-muted-foreground p-4 text-sm">{t("errorTitle")}</p>
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">{t("empty")}</p>
        ) : (
          data?.items.map((item) => (
            <NotificationItemRow key={item.id} item={item} locale={locale} onNavigate={go} compact />
          ))
        )}
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            navigate({ kind: "notifications" });
            close();
          }}
        >
          {t("viewAll")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 text-xs"
          onClick={() => {
            navigate({ kind: "settings:notifications" });
            close();
          }}
        >
          <Settings2 className="me-1 size-3.5" aria-hidden="true" />
          {t("settings")}
        </Button>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const t = useTranslations("notifications");
  const { isMobile } = useSidebar();
  const [open, setOpen] = useState(false);

  const { data: unread } = useUnreadCount(true);
  const count = unread ?? 0;
  const display = count > 99 ? "99+" : String(count);

  const button = (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={t("bell")}
      data-testid="notification-bell"
    >
      <Bell className="size-4" aria-hidden="true" />
      {count > 0 ? (
        <>
          <span
            className="bg-primary text-primary-foreground absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
            aria-hidden="true"
          >
            {display}
          </span>
          {/* §177 — the count is announced politely for screen readers */}
          <span aria-live="polite" className="sr-only">
            {t("unreadBadge", { count: display })}
          </span>
        </>
      ) : null}
    </Button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {/* MUST be a real trigger: the raw child left the Sheet without an
            anchor so the drawer never showed for taps on the bell. */}
        <SheetTrigger asChild>{button}</SheetTrigger>
        <SheetContent side="bottom" className="h-[75vh] rounded-t-2xl p-0" role="dialog" aria-label={t("panelTitle")}>
          <SheetHeader className="sr-only">
            <SheetTitle>{t("panelTitle")}</SheetTitle>
          </SheetHeader>
          <BellPanelContent
            onItemNavigate={(item) => {
              // §104 — the destination re-authorizes; the click itself
              // never grants anything (§398-§401).
              if (item.action) {
                window.location.hash = item.action.route;
              }
            }}
            close={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* MUST be a real trigger: without it Radix has no anchor — the panel
          rendered detached from the bell (effectively invisible) and the
          click appeared dead. The controlled open state is driven purely by
          onOpenChange now (no custom onClick — that would double-toggle). */}
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0" role="dialog" aria-label={t("panelTitle")}>
        <BellPanelContent
          onItemNavigate={(item) => {
            if (item.action) {
              window.location.hash = item.action.route;
            }
          }}
          close={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
