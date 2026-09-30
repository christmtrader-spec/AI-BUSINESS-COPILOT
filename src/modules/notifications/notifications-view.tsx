"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Archive, BellOff, CheckCheck, MailOpen, RotateCcw } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  NotificationItemRow,
  useMarkAllReadMutation,
  useUnreadCount,
} from "./notification-bell";
import type { ListNotificationsResult, NotificationDTO } from "./types";

/**
 * Full notification page (#/notifications) — Prompt 32 §109-§118/§366/§367.
 *
 * - Category filters are allowlisted (All/Unread/Security/Billing/AI/
 *   Business/System, §366); newest first (§367); lazy "load more" (§108).
 * - Read state changes never block navigation (§105) and never fire
 *   merely because the list loaded (§117).
 * - Date grouping (Today/Yesterday/Earlier) is localized (§116).
 * - Archive is a UX state — history is preserved (§118).
 */

const PAGE_SIZE = 20;

const FILTERS = ["all", "unread", "SECURITY", "BILLING", "AI", "BUSINESS", "SYSTEM"] as const;
type Filter = (typeof FILTERS)[number];

function filterQuery(filter: Filter, page: number): string {
  const base = `page=${page}&pageSize=${PAGE_SIZE}`;
  if (filter === "unread") return `${base}&unread=true`;
  if (filter === "all") return base;
  return `${base}&category=${filter}`;
}

function groupKeyOf(iso: string): "today" | "yesterday" | "earlier" {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "earlier";
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return "earlier";
}

export function NotificationsView() {
  const t = useTranslations("notifications");
  const locale = useAppStore((s) => s.locale);
  const queryClient = useQueryClient();
  const [filter, setFilterState] = useState<Filter>("all");
  const { data: unreadCount } = useUnreadCount(true);
  const markAllRead = useMarkAllReadMutation();

  const query = useInfiniteQuery<ListNotificationsResult>({
    queryKey: ["notifications", "page", filter],
    queryFn: async ({ pageParam }) => {
      const page = typeof pageParam === "number" ? pageParam : 1;
      return api<ListNotificationsResult>(`/api/v1/me/notifications?${filterQuery(filter, page)}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last, allPages) =>
      allPages.reduce((sum, p) => sum + p.items.length, 0) < last.total
        ? allPages.length + 1
        : undefined,
  });

  const items = useMemo(
    () => (query.data ? query.data.pages.flatMap((p) => p.items) : []),
    [query.data],
  );

  const grouped = useMemo(() => {
    const groups: Record<"today" | "yesterday" | "earlier", NotificationDTO[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const item of items) groups[groupKeyOf(item.createdAt)].push(item);
    return groups;
  }, [items]);

  async function markOneRead(id: string) {
    const res = await fetch(`/api/v1/me/notifications/${id}/read`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return true;
  }

  async function markOneUnread(id: string) {
    const res = await fetch(`/api/v1/me/notifications/${id}/unread`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return true;
  }

  async function archiveOne(id: string) {
    const res = await fetch(`/api/v1/me/notifications/${id}/archive`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return true;
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markRead = useMutation({ mutationFn: markOneRead, onSettled: invalidate });
  const markUnread = useMutation({ mutationFn: markOneUnread, onSettled: invalidate });
  const archive = useMutation({ mutationFn: archiveOne, onSettled: invalidate });

  return (
    <div className="space-y-4" data-testid="notifications-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("page.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("page.subtitle")}</p>
        </div>
        {typeof unreadCount === "number" && unreadCount > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            data-testid="page-mark-all"
          >
            <CheckCheck className="me-1.5 size-4" aria-hidden="true" />
            {t("markAllRead")}
          </Button>
        ) : null}
      </div>

      <Tabs
        value={filter}
        onValueChange={(value) => setFilterState(value as Filter)}
      >
        <TabsList className="h-auto flex-wrap justify-start gap-1" aria-label={t("panelTitle")}>
          {FILTERS.map((f) => (
            <TabsTrigger key={f} value={f} className="text-xs sm:text-sm">
              {t(`filters.${f}` as "filters.all")}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {query.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          {t("errorTitle")}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RotateCcw className="me-1.5 size-3.5" aria-hidden="true" />
              {t("loadMore") === "" ? "retry" : t("offlineRetry")}
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div
          className="text-muted-foreground rounded-lg border border-dashed p-10 text-center"
          data-testid="notifications-empty"
        >
          <BellOff className="mx-auto mb-3 size-8 opacity-50" aria-hidden="true" />
          <p className="text-sm">{filter === "all" ? t("empty") : t("emptyFiltered")}</p>
        </div>
      ) : (
        <div className="space-y-5">
          {(["today", "yesterday", "earlier"] as const).map((group) =>
            grouped[group].length === 0 ? null : (
              <section key={group} aria-label={t(`groups.${group}` as "groups.today")}>
                <h2 className="text-muted-foreground mb-1.5 px-1 text-xs font-medium uppercase tracking-wide">
                  {t(`groups.${group}` as "groups.today")}
                </h2>
                <ul className="overflow-hidden rounded-lg border">
                  {grouped[group].map((item) => (
                    <li key={item.id} className="border-b last:border-b-0">
                      <div className="flex items-stretch">
                        <div className="min-w-0 flex-1">
                          <NotificationItemRow
                            item={item}
                            locale={locale}
                            onNavigate={(n) => {
                              // §104 — the destination performs its own
                              // authorization; this click grants nothing.
                              if (n.action) window.location.hash = n.action.route;
                            }}
                          />
                        </div>
                        <div className="flex items-center gap-1 pe-2">
                          {item.readAt === null ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t("markRead")}
                              onClick={() => markRead.mutate(item.id)}
                            >
                              <MailOpen className="size-3.5" aria-hidden="true" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t("markUnread")}
                              onClick={() => markUnread.mutate(item.id)}
                            >
                              <RotateCcw className="size-3.5" aria-hidden="true" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground size-7"
                            aria-label={t("archive")}
                            onClick={() => archive.mutate(item.id)}
                          >
                            <Archive className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? t("loading") : t("loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
