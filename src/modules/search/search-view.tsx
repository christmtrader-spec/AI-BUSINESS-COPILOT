"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { ApiClientError } from "@/lib/api-client";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_Q_MIN,
  useSearchQuery,
} from "./search-api";
import { SEARCH_TYPE_ICONS, formatSearchDate } from "./search-icons";
import { entityViewFromSearchItem } from "../entities/entity-route";
import { fmtCount } from "../finance-shared/finance-kit";
import type { SearchEntityType, SearchResultItem } from "@/lib/search/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Closed filter vocabulary (§13.1) — never arbitrary values. */
const FILTER_ALL = "ALL" as const;
type FilterValue = typeof FILTER_ALL | SearchEntityType;
const FILTER_TYPES: FilterValue[] = [
  FILTER_ALL,
  "CUSTOMER",
  "SUPPLIER",
  "PRODUCT",
  "SALE",
  "EXPENSE",
  "PAYMENT",
  // Prompt 41 (§152) — purchase-order results group + filter chip.
  "PURCHASE_ORDER",
];

/**
 * Prompt 33 §13 — Search Results Center (#/search, #/search?q=…).
 *
 * Read-only discovery surface: professional loading/empty/error states,
 * debounced input synced to the URL hash (§33), allowlisted type filters,
 * grouped results with closed-token badges, and click-through navigation
 * into the owning module. No mutation action exists here (§1).
 */
export function SearchCenterView() {
  const tSearch = useTranslations("search");
  const tCommon = useTranslations("common");
  const locale = useAppStore((s) => s.locale);
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const viewQuery = view.kind === "search" ? (view.query ?? "") : "";

  const [input, setInput] = useState(viewQuery);
  const [debounced, setDebounced] = useState(viewQuery);
  const [filter, setFilter] = useState<FilterValue>(FILTER_ALL);
  const inputRef = useRef<HTMLInputElement>(null);

  // §12.6 — debounce (200–300 ms) for hash pushes AND fetches.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // §33 — persist the query in the hash on every settled (debounced) change.
  // navigate() is an external-system update (zustand + history), allowed here.
  useEffect(() => {
    const current = useAppStore.getState().view;
    const currentQuery = current.kind === "search" ? (current.query ?? "") : "";
    if (debounced !== currentQuery) {
      navigate({ kind: "search", query: debounced || undefined });
    }
  }, [debounced, navigate]);

  // Store → input re-sync (back/forward, palette deep link, our own push).
  // Render-phase state adjustment — the React-sanctioned pattern: compare
  // against the last seen store value and adjust local state during render.
  // Our own push lands here with debounced === viewQuery, so it is a no-op;
  // an EXTERNAL hash change re-enters input + debounce deterministically.
  const [syncedQuery, setSyncedQuery] = useState(viewQuery);
  if (viewQuery !== syncedQuery) {
    setSyncedQuery(viewQuery);
    setInput(viewQuery);
    setDebounced(viewQuery);
  }

  // §13.1 — autofocus when entering the Search Center.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = debounced;
  const tooShort = q.length > 0 && q.length < SEARCH_Q_MIN;
  const types = filter === FILTER_ALL ? null : [filter];
  const search = useSearchQuery({ q, types, enabled: true });

  const groups = search.data?.groups ?? [];
  const total = search.data?.total ?? 0;
  const truncated = search.data?.truncated ?? false;

  function openResult(item: SearchResultItem) {
    // Prompt 34 §33 — type+id resolve through the CLOSED entity vocabulary
    // (lib/entity-routes) to the exact entity detail. The server still only
    // returns the allowlisted type + id; no URL is ever built from data.
    navigate(entityViewFromSearchItem(item));
  }

  function clearSearch() {
    setInput("");
    inputRef.current?.focus();
  }

  return (
    <section aria-labelledby="search-center-title" className="flex flex-col gap-4">
      {/* Header: title + live result count */}
      <div className="flex flex-col gap-1">
        <h1 id="search-center-title" className="text-xl font-semibold sm:text-2xl">
          {tSearch("title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {tSearch("description")}
        </p>
      </div>

      {/* Search input — large, labeled, clearable, autofocus (§13.1) */}
      <div className="relative">
        <label htmlFor="search-center-input" className="sr-only">
          {tSearch("inputLabel")}
        </label>
        <Search
          className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          id="search-center-input"
          ref={inputRef}
          type="text"
          inputMode="search"
          autoComplete="off"
          enterKeyHint="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") clearSearch();
          }}
          placeholder={tSearch("placeholder")}
          maxLength={64}
          className="bg-background ring-border focus:ring-ring h-12 w-full rounded-lg border-0 ps-10 pe-10 text-base shadow-sm outline-none ring-1 transition-shadow focus:ring-2 sm:text-lg"
          dir="auto"
        />
        {input.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={clearSearch}
            aria-label={tSearch("clearSearch")}
            className="absolute end-1 top-1/2 size-10 -translate-y-1/2"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {/* Filters — allowlisted only; horizontally scrollable on mobile */}
      <div
        role="group"
        aria-label={tSearch("filters")}
        className="flex items-center gap-1.5 overflow-x-auto pb-1"
      >
        {FILTER_TYPES.map((value) => {
          const active = filter === value;
          const label =
            value === FILTER_ALL
              ? tSearch("allResults")
              : tSearch(`groups.${value}`);
          return (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={active}
              className={cn(
                "ring-border focus-visible:ring-ring min-h-11 shrink-0 cursor-pointer rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2",
                active
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "bg-background text-foreground hover:bg-accent",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* States */}
      {tooShort ? (
        <EmptyState
          icon={<Search className="size-5" aria-hidden="true" />}
          text={tSearch("minChars")}
        />
      ) : q.length === 0 ? (
        <EmptyState
          icon={<Search className="size-5" aria-hidden="true" />}
          text={tSearch("prompt")}
        />
      ) : search.isFetching && !search.data ? (
        <EmptyState
          icon={<Loader2 className="size-5 animate-spin" aria-hidden="true" />}
          text={tSearch("loading")}
        />
      ) : search.isError ? (
        <EmptyState
          icon={<AlertTriangle className="text-destructive size-5" aria-hidden="true" />}
          text={
            search.error instanceof ApiClientError &&
            search.error.code === "RATE_LIMITED"
              ? tSearch("rateLimited")
              : tSearch("error")
          }
          retry={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void search.refetch()}
            >
              {tCommon("retry")}
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Search className="size-5" aria-hidden="true" />}
          text={tSearch("empty")}
        />
      ) : (
        <>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {tSearch("resultCount", { count: total })}
            {truncated ? ` · ${tSearch("truncated")}` : ""}
          </p>
          <div className="flex flex-col gap-4">
            {groups.map((group) => {
              const Icon = SEARCH_TYPE_ICONS[group.type];
              const groupLabel = tSearch(`groups.${group.type}`);
              return (
                <section
                  key={group.type}
                  aria-label={groupLabel}
                  className="bg-card rounded-xl border"
                >
                  <h2 className="text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{groupLabel}</span>
                    <Badge variant="secondary" className="ms-auto">
                      {fmtCount(locale, group.count)}
                    </Badge>
                  </h2>
                  <ul className="divide-y">
                    {group.items.map((item) => (
                      <li key={`${item.type}-${item.id}`}>
                        <button
                          type="button"
                          onClick={() => openResult(item)}
                          className="hover:bg-accent focus-visible:bg-accent flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-start outline-none"
                        >
                          <Icon
                            className="text-muted-foreground size-4 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-sm font-medium" dir="auto">
                              {item.title}
                            </span>
                            {item.subtitle ? (
                              <span
                                className="text-muted-foreground truncate text-xs"
                                dir="auto"
                              >
                                {item.subtitle}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                            {item.status ? (
                              <Badge variant="outline">
                                {tSearch(`status.${item.status}`)}
                              </Badge>
                            ) : null}
                            {item.method ? (
                              <Badge variant="outline">
                                {tSearch(`method.${item.method}`)}
                              </Badge>
                            ) : null}
                            {item.direction ? (
                              <Badge variant="outline">
                                {tSearch(`direction.${item.direction}`)}
                              </Badge>
                            ) : null}
                            {item.date ? (
                              <span className="text-muted-foreground text-xs">
                                {formatSearchDate(item.date, locale)}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Localized status row (loading/empty/error/validation) — never raw data. */
function EmptyState({
  icon,
  text,
  retry,
}: {
  icon: React.ReactNode;
  text: string;
  retry?: React.ReactNode;
}) {
  return (
    <div className="text-muted-foreground bg-card flex flex-col items-center justify-center gap-3 rounded-xl border px-6 py-12 text-center text-sm">
      <span className="flex size-10 items-center justify-center rounded-full border">
        {icon}
      </span>
      <p>{text}</p>
      {retry}
    </div>
  );
}
