"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowUpRight,
  BarChart3,
  BookMarked,
  Bot,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  Crown,
  Gauge,
  Loader2,
  Download,
  HandCoins,
  History,
  ListTree,
  Lock,
  Medal,
  MessageSquareText,
  Package,
  Pencil,
  PieChart,
  Pin,
  PinOff,
  ReceiptText,
  RefreshCcw,
  Search,
  SearchX,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  TrendingUp,
  TriangleAlert,
  UserRound,
  Wallet,
  Waves,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiClientError } from "@/lib/api-client";
import {
  clearCopilotState,
  createEmptySession,
  dayKeyLocal,
  daySeparatorFor,
  loadCopilotState,
  MAX_SESSIONS,
  newMessageId,
  saveCopilotState,
  sessionMatchesQuery,
  sessionMatchParts,
  titleFromQuestion,
  type CopilotSession,
  type DaySeparator,
  type SessionMatchParts,
} from "@/lib/copilot-sessions";
import type { StreamResumeSnapshot } from "@/lib/ai/stream-resume";
import {
  fetchServerSessions,
  mergeWithServer,
  serverAppendMessage,
  serverClearSessions,
  serverDeleteSession,
  serverUpdateSession,
} from "@/lib/copilot-sync";
import { can, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PageHeader } from "@/components/shared/primitives";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BusinessSummary } from "../shell/types";
import { useAppStore } from "@/store/app-store";
// R102/R103 — the chip tooltips carry the EXACT business money (the
// R99 FORMATTING law: formatted INSIDE the component, never a raw template).
// R143 — the perf chips' cashflow tooltip joins with fmtCount (same law:
// the R140 ONE-locale formatter, never a raw ICU {count}).
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";

/**
 * AI Copilot — Phase 05/06. Read-only Q&A over deterministic, server-computed
 * figures (A11-A13). The client sends ONLY the question + conversation
 * history; all authoritative data is injected server-side.
 *
 * Phase 06: answers stream token-by-token over SSE
 * (`POST /api/v1/copilot/stream`), with a Stop control that aborts the
 * stream and keeps the partial answer.
 */

// R136 — ONE class law for the transcript's status pills (the amber resuming
// pill and the sky restored badge share the shape; only the HUE differs, so
// the pills can never drift apart in geometry — same law as the trend
// panel's trendDeltaCls single hue source).
const statusPillBase =
  "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium";

/**
 * R138 — hour:minute label for a message stamp, formatted through Intl so
 * the FA surface gets Persian digits automatically. Empty string on any
 * formatting failure (the caller then renders no label — never a lie).
 */
function fmtTimeLabel(ts: number, localeTag: string): string {
  try {
    return new Intl.DateTimeFormat(localeTag, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** R138 — creation stamp (epoch ms) from the stored message; old persisted
   *  messages honestly omit it (no time label, no day separator). */
  ts?: number;
  failed?: boolean;
  /** R127 — restored through the stream-resume healing path (R126). */
  healed?: boolean;
  /** Dataset provenance for this answer (first SSE event) — rendered as
   *  citation chips under the bubble so every figure is traceable. */
  meta?: CopilotMeta;
};

type CopilotMetaCounts = {
  sales: number;
  expenses: number;
  openInvoices: number;
  openBills: number;
  activeProducts: number;
  lowStock: number;
  topProducts: number;
  expenseCategories: number;
  timelineDays: number;
  recentPayments: number;
};

type CopilotMeta = {
  days: number;
  generatedAt: string;
  rangeFrom: string;
  rangeTo: string;
  sections: string[];
  counts?: CopilotMetaCounts;
  // R98+ — PROVEN answer facts (server-computed, never model-invented).
  // Optional + tolerant: old persisted metas simply lack them (the pickers
  // must stay honest about that — additive law).
  // R143 DRIFT FIX — the server's TopProductView (src/lib/merch-facts.ts)
  // normalizes its report row to `unitsSold`; the client type used to say
  // `qty` (the raw report field). Same value, honest name — the type now
  // matches the wire contract byte-for-byte. R153 — the view grows the
  // drill id (ADDITIVE optional: old persisted metas honestly omit it;
  // the picker refuses a missing/blank/null id — the R96 mass law).
  topProduct?: { name: string; unitsSold: number; revenueMinor: number; productId?: string | null } | null;
  topExpenseCategory?: { category: string; totalMinor: number } | null;
  topStockProduct?: { id: string; name: string; valueMinor: number } | null;
  // R103 — the podium's rank 2 (additive optional — old persisted metas
  // honestly omit it; the pickers never fabricate it).
  topStockRunnerUp?: { id: string; name: string; valueMinor: number } | null;
  // R147 — the OUTSTANDING leaders with the stable party id: the §16/§18
  // aging drill rides the ID (navigation never rides a name). Optional +
  // nullable — old persisted metas honestly omit them; null partyId =
  // the unassigned mass (carried, but the picker refuses to drill it —
  // there is no party to scope to, the R96 mass-row law).
  topDebtor?: CopilotOutstandingFact | null;
  topCreditor?: CopilotOutstandingFact | null;
};

/** R147 — the client mirror of the server's CopilotOutstandingView. */
type CopilotOutstandingFact = {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
  openItems: number;
};

const WINDOWS = [7, 30, 90] as const;
const nextId = newMessageId;

// ---- Markdown-lite renderer (no deps, no raw HTML — safe by construction) --

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          dir="ltr"
          className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function MarkdownLite({ text, streaming }: { text: string; streaming?: boolean }) {
  const nodes: ReactNode[] = [];
  let bullets: string[] = [];
  let para: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    nodes.push(
      <ul
        key={`ul-${nodes.length}`}
        className="marker:text-muted-foreground/50 my-1 list-disc space-y-1 ps-5"
      >
        {bullets.map((b, i) => (
          <li key={i}>{inline(b, `b${nodes.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flushPara = () => {
    if (para.length === 0) return;
    nodes.push(
      <p key={`p-${nodes.length}`} className="leading-relaxed whitespace-pre-wrap">
        {inline(para.join("\n"), `p${nodes.length}`)}
      </p>,
    );
    para = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(line)) {
      flushPara();
      bullets.push(line.replace(/^\s*[-*•]\s+/, ""));
    } else if (line === "") {
      flushBullets();
      flushPara();
    } else {
      flushBullets();
      para.push(line);
    }
  }
  flushBullets();
  flushPara();

  return (
    <div className="space-y-1.5 text-sm">
      {nodes}
      {streaming ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-emerald-600 align-middle dark:bg-emerald-400"
        />
      ) : null}
    </div>
  );
}

// ---- Citation strip ----------------------------------------------------------

/**
 * Dataset provenance chips rendered under each grounded answer — the UI
 * mirror of the server snapshot: which window, which date range, and how
 * many records the answer is built from. Counts come from the server
 * (deterministic), never from the model.
 */
function CitationStrip({
  meta,
  locale,
  business,
}: {
  meta: CopilotMeta;
  locale: string;
  // R102/W12 — the stock action chips' tooltips need the EXACT business
  // money (fmtMoney) — formatted INSIDE the component, never a raw template.
  business: BusinessSummary;
}) {
  const t = useTranslations("copilot");
  const c = meta.counts;
  const chips: { key: string; icon: typeof ReceiptText; label: string; title?: string }[] = [
    {
      key: "window",
      icon: CalendarClock,
      label: t(`window_${meta.days === 7 ? "7" : meta.days === 30 ? "30" : "90"}`),
    },
    { key: "range", icon: BookMarked, label: `${meta.rangeFrom} → ${meta.rangeTo}` },
    ...(c
      ? [
          { key: "sales", icon: ReceiptText, label: t("citationsSales", { count: c.sales }) },
          { key: "expenses", icon: Wallet, label: t("citationsExpenses", { count: c.expenses }) },
          {
            key: "openInvoices",
            icon: HandCoins,
            label: t("citationsOpenInvoices", { count: c.openInvoices }),
            title: t("citationsAllTime"),
          },
          ...(c.lowStock > 0
            ? [
                {
                  key: "lowStock",
                  icon: Package,
                  label: t("citationsLowStock", { count: c.lowStock }),
                },
              ]
            : []),
          {
            key: "payments",
            icon: ArrowDown,
            label: t("citationsPayments", { count: c.recentPayments }),
          },
        ]
      : []),
  ];

  const generatedLabel = (() => {
    try {
      const time = new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(meta.generatedAt));
      return t("citationsGenerated", { time });
    } catch {
      return null;
    }
  })();

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ps-1"
      data-testid="copilot-citations"
    >
      <span className="text-muted-foreground/80 inline-flex items-center gap-1 text-[11px] font-medium">
        <BookMarked className="size-3" aria-hidden="true" />
        {t("citationsTitle")}
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.title}
          className="border-border/70 bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none transition-colors hover:border-foreground/25 hover:text-foreground motion-reduce:transition-none"
        >
          <chip.icon className="size-3" aria-hidden="true" />
          {chip.key === "range" ? (
            <span dir="ltr" className="tabular-nums">
              {chip.label}
            </span>
          ) : (
            chip.label
          )}
        </span>
      ))}
      {generatedLabel ? (
        <span className="text-muted-foreground/70 text-[11px]">· {generatedLabel}</span>
      ) : null}
    </div>
  );
}

// ---- Stock action chips (R102/R103 — the throne deep-links) -----------------

/**
 * The podium chips under a grounded answer: Crown = rank 1, Medal = rank 2
 * of CURRENT stock value. Each chip gates on ITS OWN proven fact + value > 0
 * (pickStockActionChips — the deterministic rank1→rank2 order); the tooltip
 * formats the EXACT money inside this component (fmtMoney — never a raw ICU
 * template). Both chips land the SAME closed token: reports?inventory=1
 * (the Prompt 51 detailed valuation sub-view). Absent facts → renders null.
 */
function StockActionChips({
  meta,
  business,
}: {
  meta: CopilotMeta;
  business: BusinessSummary;
}) {
  const t = useTranslations("copilot");
  const navigate = useAppStore((s) => s.navigate);
  const chips = pickStockActionChips(meta);
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 ps-1" data-testid="copilot-stock-chips">
      {chips.map((chip) => {
        const crown = chip.key === "actionTopStock";
        const fact = crown ? meta.topStockProduct : meta.topStockRunnerUp;
        if (!fact) return null;
        const tooltip = crown
          ? t("actionTopStockTitle", {
              name: fact.name,
              money: fmtMoney(business, fact.valueMinor),
            })
          : t("actionTopStockRunnerUpTitle", {
              name: fact.name,
              money: fmtMoney(business, fact.valueMinor),
            });
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() =>
              navigate({
                kind: "module",
                module: "reports",
                param: "inventory",
                // R148 — the ROW-LEVEL drill: the stable fact's own name
                // seeds the valuation search box (?inventory=1&q=…), so the
                // crowned table opens ALREADY filtered to this product's
                // row. The seed rides the parser's 80-cap law; the panel's
                // one-seed-per-navigation effect consumes it.
                invQuery: fact.name,
              })
            }
            title={tooltip}
            aria-label={tooltip}
            data-testid={crown ? "copilot-action-topstock" : "copilot-action-topstock-runnerup"}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600",
              crown
                ? "border-sky-600/30 bg-sky-600/5 text-sky-800 dark:text-sky-300 hover:bg-sky-600/10"
                : "border-sky-600/20 bg-sky-600/[0.03] text-sky-700 dark:text-sky-400 hover:bg-sky-600/10",
            )}
          >
            {crown ? (
              <Crown className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <Medal className="size-3 shrink-0" aria-hidden="true" />
            )}
            {t(chip.key)}
            <ChevronDown
              className="size-3 shrink-0 opacity-60 rtl:-scale-x-100"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

// ---- Perf action chips (R143 — the R142 priority (1): the FIRST external
//      producers of the perf deep-link grammar) ------------------------------

/**
 * R143 — the performance action chips under a grounded answer: one chip per
 * PROVEN fact (pickPerfActionChips — r100's deterministic order products →
 * expenses → cashflow), each a REAL control into the R100/R136 perf sub-view
 * landing (#/reports?perf=<token>[&from&to]). Laws:
 * - the chip's window is the meta's OWN range keys — carried ONLY when BOTH
 *   boundaries survived metaWindowOrNull (the parser drops orphan window
 *   fields wholesale, so the navigation must never serialize one);
 * - a dropped window NEVER kills the chip — the panel honestly falls back to
 *   its own last-30-days default (never a fabricated window);
 * - the cashflow chip carries NO direction (no meta fact names IN/OUT — the
 *   panel's honest "all directions" default wins);
 * - tooltips carry the EXACT proven figure (fmtMoney / fmtCount INSIDE the
 *   component — never a raw ICU template; the R99/R140 formatting laws);
 * - absent facts → renders null (honest silence, the StockActionChips law).
 */
function PerfActionChips({
  meta,
  business,
}: {
  meta: CopilotMeta;
  business: BusinessSummary;
}) {
  const t = useTranslations("copilot");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const chips = pickPerfActionChips(meta);
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 ps-1" data-testid="copilot-perf-chips">
      {chips.map((chip) => {
        const productFact = chip.key === "actionPerfProducts" ? meta.topProduct : null;
        const expenseFact = chip.key === "actionPerfExpenses" ? meta.topExpenseCategory : null;
        const tooltip = productFact
          ? t("actionPerfProductsTitle", {
              name: productFact.name,
              money: fmtMoney(business, productFact.revenueMinor),
            })
          : expenseFact
            ? t("actionPerfExpensesTitle", {
                category: expenseFact.category,
                money: fmtMoney(business, expenseFact.totalMinor),
              })
            : t("actionPerfCashflowTitle", {
                count: fmtCount(uiLocale, meta.counts?.recentPayments ?? 0),
              });
        const Icon =
          chip.key === "actionPerfProducts"
            ? TrendingUp
            : chip.key === "actionPerfExpenses"
              ? PieChart
              : Waves;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() =>
              navigate({
                kind: "module",
                module: "reports",
                param: chip.param,
                ...(chip.from && chip.to ? { perfFrom: chip.from, perfTo: chip.to } : {}),
              })
            }
            title={tooltip}
            aria-label={tooltip}
            data-testid={
              chip.param === "perf-sales"
                ? "copilot-action-perf-sales"
                : chip.param === "perf-expenses"
                  ? "copilot-action-perf-expenses"
                  : "copilot-action-perf-cashflow"
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600",
              "border-violet-600/30 bg-violet-600/5 text-violet-800 dark:text-violet-300 hover:bg-violet-600/10",
            )}
          >
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {t(chip.key)}
            <ChevronDown
              className="size-3 shrink-0 opacity-60 rtl:-scale-x-100"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

// ---- Follow-up suggestions ---------------------------------------------------

/**
 * Context-aware follow-up pool. The chips are UI suggestions only — they
 * never touch data. Deterministic: keyword match on the answer text picks
 * the lead chip; the rest rotate by conversation length so repeated
 * answers surface different prompts.
 */
const FOLLOW_UP_KEYS = [
  "followUpOutstanding",
  "followUpLowStock",
  "followUpExpenses",
  "followUpSales",
  "followUpCash",
  "followUpProducts",
  "followUpPayments",
  "followUpSummary",
] as const;

type FollowUpKey = (typeof FOLLOW_UP_KEYS)[number];

const FOLLOW_UP_MATCHERS: Array<{ key: FollowUpKey; re: RegExp }> = [
  { key: "followUpOutstanding", re: /owe|outstanding|receivable|بدهکار|بدهی|طلب/i },
  { key: "followUpLowStock", re: /low.?stock|restock|inventory|موجودی|انبار|شارژ/i },
  { key: "followUpExpenses", re: /expense|spend|cost|هزینه|خرج/i },
  { key: "followUpSales", re: /sale|revenue|invoice|فروش|درآمد|فاکتور/i },
  { key: "followUpCash", re: /cash|payment|collected|نقد|پرداخت|دریافتی/i },
  { key: "followUpProducts", re: /product|best.?seller|top|محصول|پرفروش/i },
];

/** Live server counts (same deterministic aggregates as the dashboard)
 *  used to RANK suggestions — a chip is only proposed when its subject
 *  actually exists in the data (r10: "only propose restock when there is
 *  something to restock"). */
type SummaryLite = {
  kpis?: { salesCount?: number; expensesCount?: number };
  outstanding?: { receivableCount?: number };
  inventory?: { lowStockCount?: number };
  topProducts?: unknown[];
};

function followUpRelevant(
  key: FollowUpKey,
  counts: {
    receivableCount: number;
    lowStockCount: number;
    salesCount: number;
    expensesCount: number;
    topProducts: number;
  } | null,
): boolean {
  if (!counts) return true; // counts not loaded yet — keep the neutral default
  switch (key) {
    case "followUpOutstanding":
      return counts.receivableCount > 0;
    case "followUpLowStock":
      return counts.lowStockCount > 0;
    case "followUpExpenses":
      return counts.expensesCount > 0;
    case "followUpProducts":
      return counts.topProducts > 0;
    case "followUpSales":
      return true;
    case "followUpCash":
    case "followUpPayments":
    case "followUpSummary":
      return true;
  }
}

function pickFollowUps(
  answer: string,
  conversationLength: number,
  counts: Parameters<typeof followUpRelevant>[1] = null,
): FollowUpKey[] {
  const lead = FOLLOW_UP_MATCHERS.find((m) => m.re.test(answer))?.key;
  const pool = FOLLOW_UP_KEYS.filter(
    (k) => k !== lead && followUpRelevant(k, counts),
  );
  const rotate = conversationLength % Math.max(1, pool.length);
  const rotated = [...pool.slice(rotate), ...pool.slice(0, rotate)];
  const picked = rotated.slice(0, lead ? 2 : 3);
  return lead ? [lead, ...picked] : picked;
}

// ---- Action chips (deterministic deep-links from PROVEN facts) ---------------

/**
 * A persisted meta range is usable as a deep-link window ONLY when BOTH
 * boundaries are strict `YYYY-MM-DD` calendar days and the range is not
 * inverted — a half or lying window is dropped WHOLESALE (never one lying
 * boundary — r100 law [1o]/[1n]/[3h]).
 */
function metaWindowOrNull(meta: CopilotMeta): { from: string; to: string } | { from: null; to: null } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(meta.rangeFrom ?? "") || !iso.test(meta.rangeTo ?? "")) {
    return { from: null, to: null };
  }
  const from = new Date(`${meta.rangeFrom}T00:00:00Z`);
  const to = new Date(`${meta.rangeTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from.getTime() > to.getTime()) {
    return { from: null, to: null };
  }
  return { from: meta.rangeFrom, to: meta.rangeTo };
}

export type PerfActionChip = {
  key: "actionPerfProducts" | "actionPerfExpenses" | "actionPerfCashflow";
  param: "perf-sales" | "perf-expenses" | "perf-cashflow";
  from: string | null;
  to: string | null;
};

/**
 * R100 — the performance action chips: one chip per PROVEN fact, in the
 * deterministic order products → expenses → cashflow. Laws (battery-pinned
 * in scripts/r100-deeplink-unit.ts):
 * - a chip exists only when its fact is proven (topProduct / topExpense
 *  Category present; cashflow requires recentPayments > 0 — an empty cash
 *   lane renders no cashflow chip);
 * - old persisted metas without `counts` lose ONLY the cashflow chip;
 * - the chip window is the meta's OWN range keys (one authority) — a
 *   malformed or inverted range drops the WINDOW but never the chip;
 * - no proven fact → honest silence; null/undefined meta → [].
 */
export function pickPerfActionChips(meta: CopilotMeta | null | undefined): PerfActionChip[] {
  if (!meta || typeof meta !== "object") return [];
  const chips: PerfActionChip[] = [];
  if (meta.topProduct) {
    chips.push({ key: "actionPerfProducts", param: "perf-sales", ...(metaWindowOrNull(meta)) });
  }
  if (meta.topExpenseCategory) {
    chips.push({ key: "actionPerfExpenses", param: "perf-expenses", ...(metaWindowOrNull(meta)) });
  }
  if ((meta.counts?.recentPayments ?? 0) > 0) {
    chips.push({ key: "actionPerfCashflow", param: "perf-cashflow", ...(metaWindowOrNull(meta)) });
  }
  return chips;
}

export type StockActionChip = { key: "actionTopStock" | "actionTopStockRunnerUp" };

/**
 * R102/R103 — the stock chip family's gates (the NINTH chip). Laws
 * (batteries: scripts/r102-stock-unit.ts §3, scripts/r103-tile-unit.ts [2]):
 * - TWO chips, deterministic order rank1 (Crown) → rank2 (Medal);
 * - each chip gates on ITS OWN proof + value strictly > 0 — an all-zero
 *   book renders no chip about nothing, a throne of one renders only the
 *   Crown chip, and rank1's zero never blocks rank2's positive fact;
 * - old persisted metas without the fields stay honest ([]);
 * - null/undefined meta → [].
 */
export function pickStockActionChips(meta: CopilotMeta | null | undefined): StockActionChip[] {
  if (!meta || typeof meta !== "object") return [];
  const chips: StockActionChip[] = [];
  if (meta.topStockProduct && meta.topStockProduct.valueMinor > 0) {
    chips.push({ key: "actionTopStock" });
  }
  if (meta.topStockRunnerUp && meta.topStockRunnerUp.valueMinor > 0) {
    chips.push({ key: "actionTopStockRunnerUp" });
  }
  return chips;
}

// ---- Outstanding action chips (R147 — the drill with the stable id) --------

export type OutstandingActionChip = {
  key: "actionDebtor" | "actionCreditor";
  side: "receivables" | "payables";
  partyId: string;
  partyName: string;
  outstandingMinor: number;
  openItems: number;
};

/**
 * R147 — the outstanding drill's gates. LAWS (battery-pinned in
 * scripts/r147-outstanding-drill-check.ts):
 * - TWO chips max, deterministic order debtor → creditor (the snapshot's
 *   own field order — customersOweYou before youOweSuppliers);
 * - each chip gates on ITS OWN proof: the fact present, a non-blank partyId
 *   (the §16/§18 drill law — navigation rides the STABLE id, never the
 *   name), a non-blank partyName (a chip that cannot name its party is
 *   noise, not an affordance), and outstandingMinor > 0 with openItems > 0
 *   (the family's positive-value law — no chip about nothing);
 * - the unassigned mass (partyId null) and nameless parties NEVER drill —
 *   the R96 mass-row law, verbatim;
 * - old persisted metas without the fields stay honest ([]);
 * - null/undefined meta → [].
 */
export function pickOutstandingActionChips(
  meta: CopilotMeta | null | undefined,
): OutstandingActionChip[] {
  if (!meta || typeof meta !== "object") return [];
  const chips: OutstandingActionChip[] = [];
  const push = (
    key: OutstandingActionChip["key"],
    side: OutstandingActionChip["side"],
    fact: CopilotOutstandingFact | null | undefined,
  ) => {
    if (!fact || typeof fact !== "object") return;
    if (typeof fact.partyId !== "string" || fact.partyId.trim().length === 0) return;
    if (typeof fact.partyName !== "string" || fact.partyName.trim().length === 0) return;
    if (
      typeof fact.outstandingMinor !== "number" ||
      !Number.isFinite(fact.outstandingMinor) ||
      fact.outstandingMinor <= 0
    )
      return;
    if (typeof fact.openItems !== "number" || !Number.isFinite(fact.openItems) || fact.openItems <= 0)
      return;
    chips.push({
      key,
      side,
      partyId: fact.partyId,
      partyName: fact.partyName,
      outstandingMinor: fact.outstandingMinor,
      openItems: fact.openItems,
    });
  };
  push("actionDebtor", "receivables", meta.topDebtor);
  push("actionCreditor", "payables", meta.topCreditor);
  return chips;
}

/**
 * R147 — the outstanding drill chips under a grounded answer: when the
 * answer's proven facts name the biggest debtor/creditor WITH a stable
 * party id, each chip is a REAL control into the §16/§18 aging-details
 * drill (#/reports/aging-details?side=…&party=<id>) — the SAME landing the
 * balances board's leader rows drill to (one drill law, no second grammar).
 * Laws:
 * - NO bucket and NO pastDue on the navigation: the meta fact is the
 *   party's WHOLE open balance — a bucket would fabricate an age the fact
 *   does not carry, and pastDue would silently filter the landing (on the
 *   receivables side there is no authoritative due date at all);
 * - tooltips carry the EXACT proven money + open-item count (fmtMoney /
 *   fmtCount INSIDE the component — never a raw ICU template; the
 *   R99/R140 formatting laws); title = aria-label = ONE source;
 * - the icons mirror the app's OWN nav iconography (receivables =
 *   HandCoins, payables = ArrowUpRight — one icon one meaning);
 * - absent/undrillable facts → renders null (honest silence).
 */
function OutstandingActionChips({
  meta,
  business,
}: {
  meta: CopilotMeta;
  business: BusinessSummary;
}) {
  const t = useTranslations("copilot");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const chips = pickOutstandingActionChips(meta);
  if (chips.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1.5 ps-1"
      data-testid="copilot-outstanding-chips"
    >
      {chips.map((chip) => {
        const debtor = chip.key === "actionDebtor";
        const tooltip = t(debtor ? "actionDebtorTitle" : "actionCreditorTitle", {
          name: chip.partyName,
          money: fmtMoney(business, chip.outstandingMinor),
          count: fmtCount(uiLocale, chip.openItems),
        });
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => navigate({ kind: "aging-details", side: chip.side, partyId: chip.partyId })}
            title={tooltip}
            aria-label={tooltip}
            data-testid={debtor ? "copilot-action-debtor" : "copilot-action-creditor"}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2",
              debtor
                ? "border-emerald-600/30 bg-emerald-600/5 text-emerald-800 focus-visible:outline-emerald-600 dark:text-emerald-300 hover:bg-emerald-600/10"
                : "border-rose-600/30 bg-rose-600/5 text-rose-800 focus-visible:outline-rose-600 dark:text-rose-300 hover:bg-rose-600/10",
            )}
          >
            {debtor ? (
              <HandCoins className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
            )}
            {t(chip.key)}
            <ChevronDown
              className="size-3 shrink-0 opacity-60 rtl:-scale-x-100"
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

// ---- Product action chip (R153 — the best seller meets its own surface) ----

export type ProductActionChipFact = {
  productId: string;
  name: string;
  unitsSold: number;
  revenueMinor: number;
};

/**
 * R153 — the product drill's gate: when the answer's proven best-seller
 * fact carries a STABLE catalog id, ONE chip opens the product's own
 * surface (the entity detail — the R152 destination, where the
 * StockDialog adjusts stock and the threshold is edited). Laws
 * (battery-pinned in scripts/r153-product-drill-check.ts):
 * - the id law — navigation rides the STABLE productId, never the name
 *   (the R147 law verbatim); a missing/blank/null id NEVER drills — the
 *   unlinked mass (a snapshot name with no catalog row) stays honest
 *   (the R96 mass-row law, exactly like R147's null partyId);
 * - the positive-value law — unitsSold > 0 AND revenueMinor > 0 (no chip
 *   about nothing — the stock family's law);
 * - a nameless fact never drills (a chip that cannot name its target is
 *   noise, not an affordance);
 * - old persisted metas without the id stay honest (null);
 * - null/undefined meta → null.
 */
export function pickProductActionChip(
  meta: CopilotMeta | null | undefined,
): ProductActionChipFact | null {
  if (!meta || typeof meta !== "object") return null;
  const fact = meta.topProduct;
  if (!fact || typeof fact !== "object") return null;
  if (typeof fact.productId !== "string" || fact.productId.trim().length === 0) return null;
  if (typeof fact.name !== "string" || fact.name.trim().length === 0) return null;
  if (typeof fact.unitsSold !== "number" || !Number.isFinite(fact.unitsSold) || fact.unitsSold <= 0)
    return null;
  if (
    typeof fact.revenueMinor !== "number" ||
    !Number.isFinite(fact.revenueMinor) ||
    fact.revenueMinor <= 0
  )
    return null;
  return {
    productId: fact.productId,
    name: fact.name,
    unitsSold: fact.unitsSold,
    revenueMinor: fact.revenueMinor,
  };
}

/**
 * R153 — the ONE product chip under a grounded answer: the proven
 * best-seller opens THE PRODUCT (the entity detail — the R152
 * destination; the store's entityToHash authority builds the hash, never
 * a hand-built #/products/…). Laws:
 * - ONE chip max (the fact is one rank-1); the violet perf chip and the
 *   sky stock chips keep their OWN destinations — this chip is the
 *   product's own page, a materially different surface (stock lives
 *   there), not a duplicate;
 * - the icon mirrors the app's OWN nav iconography (Package = products —
 *   one icon one meaning); the hue is the R152 "open the surface"
 *   primary identity;
 * - the tooltip carries the EXACT proven figures (fmtCount / fmtMoney
 *   INSIDE the component — never a raw ICU template; the R99/R140
 *   formatting laws); title = aria-label = ONE source;
 * - absent/undrillable fact → renders null (honest silence).
 */
function ProductActionChip({
  meta,
  business,
}: {
  meta: CopilotMeta;
  business: BusinessSummary;
}) {
  const t = useTranslations("copilot");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const chip = pickProductActionChip(meta);
  if (!chip) return null;
  const tooltip = t("actionProductTitle", {
    name: chip.name,
    count: fmtCount(uiLocale, chip.unitsSold),
    money: fmtMoney(business, chip.revenueMinor),
  });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 ps-1" data-testid="copilot-product-chips">
      <button
        type="button"
        onClick={() => navigate({ kind: "entity", entity: "product", id: chip.productId })}
        title={tooltip}
        aria-label={tooltip}
        data-testid="copilot-action-product"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none transition-colors motion-reduce:transition-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
        )}
      >
        <Package className="size-3 shrink-0" aria-hidden="true" />
        {t("actionProduct")}
        <ChevronDown
          className="size-3 shrink-0 opacity-60 rtl:-scale-x-100"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

// ---- View -------------------------------------------------------------------

export function CopilotView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("copilot");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const uiLocale = useLocale();
  // R144 — the ask deep-link seed reads the ONE store view (the hash IS
  // the state: #/copilot?ask=… carries the composer draft pre-seed).
  const view = useAppStore((s) => s.view);

  // ---- Multi-session transcripts (per business, localStorage) -------------
  // `messages` below is ALWAYS the active session's message list; every
  // mutation flows through the same setMessages wrapper, so streaming,
  // retry and follow-up logic stays unchanged.
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);

  const messages = useMemo(
    () =>
      (sessions.find((s) => s.id === activeSessionId)?.messages ?? []) as ChatMessage[],
    [sessions, activeSessionId],
  );

  const [input, setInput] = useState("");
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  // Rename-in-dialog state (r12): the dropdown's pencil opens a controlled
  // Dialog so the menu can close without swallowing the edit.
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // R138 — session history search (client-side filter across the 20-session
  // cap; matches title OR any message content).
  const [sessionQuery, setSessionQuery] = useState("");
  // R139 — the honest regenerate confirm: asking the SAME question again is
  // a NEW metered request, so the affordance opens a dialog that says so
  // (with the plan's real usage when it can be fetched) before burning one.
  const [regenOpen, setRegenOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const lastQuestionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // R126 — the logical operation id of the answer in flight (Prompt 21
  // idempotency key): the stop beacon and any resume polling address it.
  const activeRequestIdRef = useRef<string | null>(null);
  // R126 — amber "restoring" pill while the resume poll loop heals a
  // mid-answer connection cut.
  const [resumingId, setResumingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canUse = can(role, "copilot:use");
  const pending = activeStreamId !== null;

  // R144 — the ASK DEEP-LINK SEED (the reports panel's "Ask the Copilot"
  // button is the first producer of #/copilot?ask=…). Laws:
  //  - the seed fills the composer DRAFT and focuses it — it NEVER sends
  //    (spending a metered AI request is the user's action, never a
  //    navigation's);
  //  - one ask, one seed (seededAskRef): re-entering with the SAME ask
  //    never re-fires, a DIFFERENT ask does;
  //  - an EMPTY composer is the only overwrite-able state — if the user
  //    typed (or a stream is mid-flight) the seed is consumed WITHOUT
  //    seeding (an explicit navigation may never silently destroy typed
  //    text); the hash survives, so a reload re-seeds honestly;
  //  - the same ask value never re-seeds even when the input was cleared
  //    by hand afterwards — re-clicking the SAME link is not a new intent.
  const seededAskRef = useRef<string | null>(null);
  useEffect(() => {
    const ask =
      view.kind === "module" && view.module === "copilot" ? (view.ask ?? "").trim() : "";
    if (!ask || seededAskRef.current === ask) return;
    if (activeStreamId !== null) return;
    seededAskRef.current = ask;
    if (input.trim() === "") {
      setInput(ask);
      textareaRef.current?.focus();
    }
  }, [view, activeStreamId, input]);

  // Feature B — live server counts (the SAME cached aggregate the dashboard
  // and idle prefetch warm: ["reports","summary","30"]). Deterministic —
  // suggestions reorder/hide from real data, never from the model.
  const { data: summaryLite } = useQuery<SummaryLite>({
    queryKey: ["reports", "summary", "30"],
    queryFn: () => api("/api/v1/reports/summary?days=30"),
    enabled: canUse,
    staleTime: 30_000,
  });
  const liveCounts = useMemo(
    () =>
      summaryLite
        ? {
            receivableCount: summaryLite.outstanding?.receivableCount ?? 0,
            lowStockCount: summaryLite.inventory?.lowStockCount ?? 0,
            salesCount: summaryLite.kpis?.salesCount ?? 0,
            expensesCount: summaryLite.kpis?.expensesCount ?? 0,
            topProducts: summaryLite.topProducts?.length ?? 0,
          }
        : null,
    [summaryLite],
  );

  // Empty-state suggestions — relevant-first (stable, deterministic);
  // purely-unhelpful chips ("who owes" with 0 open invoices, "restock"
  // with nothing low) are hidden until the data supports them.
  const suggestions = useMemo(() => {
    const c = liveCounts;
    const items = [
      { text: t("suggestion1"), relevant: c ? c.receivableCount > 0 : true, hideable: true },
      { text: t("suggestion2"), relevant: true, hideable: false },
      { text: t("suggestion3"), relevant: c ? c.expensesCount > 0 : true, hideable: false },
      { text: t("suggestion4"), relevant: c ? c.topProducts > 0 : true, hideable: false },
      { text: t("suggestion5"), relevant: c ? c.lowStockCount > 0 : true, hideable: true },
      { text: t("suggestion6"), relevant: true, hideable: false },
    ];
    const visible = items.filter((i) => i.relevant || !i.hideable);
    return [
      ...visible.filter((i) => i.relevant),
      ...visible.filter((i) => !i.relevant),
    ].map((i) => i.text);
  }, [t, liveCounts]);

  // Follow-up chips — only under the LAST completed answer.
  const lastMessage = messages[messages.length - 1];
  const showFollowUps =
    !pending &&
    messages.length >= 2 &&
    lastMessage?.role === "assistant" &&
    lastMessage.failed !== true &&
    lastMessage.content.trim().length > 0;
  const followUps = useMemo(
    () =>
      showFollowUps ? pickFollowUps(lastMessage.content, messages.length, liveCounts) : [],
    [showFollowUps, lastMessage?.content, messages.length, liveCounts],
  );

  // R139 — regenerate-answer gate: the affordance exists only under the
  // LAST completed (non-failed, non-empty) answer, and carries the question
  // that actually produced it (derived from the transcript — never a stale
  // ref after a session switch).
  const lastCompletedAnswer =
    !pending &&
    lastMessage?.role === "assistant" &&
    lastMessage.failed !== true &&
    lastMessage.content.trim().length > 0;
  const regenerateQuestion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant") continue;
      return m.content.trim().length > 0 ? m.content : null;
    }
    return null;
  }, [messages]);
  const canRegenerate = lastCompletedAnswer && regenerateQuestion !== null;

  // R138 — transcript-time formatting. ONE locale source (the active UI
  // locale, same law as formatRelative above): fa-IR yields the Jalali
  // calendar + Persian digits through Intl automatically; en-GB Gregorian.
  // R140 note: hoisted ABOVE the usage query so the shared numFmt can ride
  // the same source — there is exactly ONE definition of this mapping.
  const dayLocale = uiLocale === "fa" ? "fa-IR" : "en-GB";

  // R140 — the plan's REAL AI usage, fetched ONCE when the copilot view
  // mounts (R139 gated this fetch to the regenerate dialog; the new glance
  // line under the composer needs it visible, so ONE shared query now
  // feeds BOTH the glance chip and the dialog — single fetch, one cache).
  // §64 honesty: an unlimited plan (limit null) or a failed fetch renders
  // NOTHING — never fake numbers. retry:false: a 403 must never spin.
  type CopilotUsage = {
    metrics?: { AI_REQUESTS?: { used?: number; limit?: number | null } };
  };
  const { data: usage } = useQuery<CopilotUsage>({
    queryKey: ["billing", "usage", "copilot"],
    queryFn: () => api("/api/v1/billing/usage"),
    staleTime: 60_000,
    retry: false,
  });
  const meterRaw = usage?.metrics?.AI_REQUESTS;
  const meter =
    meterRaw &&
    typeof meterRaw.used === "number" &&
    typeof meterRaw.limit === "number"
      ? { used: meterRaw.used, limit: meterRaw.limit }
      : null;
  // R141 — the glance chip's honesty window: a completed ask consumes a
  // metered request, so the shared usage cache is invalidated the moment a
  // stream ends (without this the chip froze up to staleTime 60s — the
  // meter lied by omission after the FIRST ask). The refetch is passive:
  // it only runs while the copilot view is mounted (the query's owner).
  const queryClient = useQueryClient();
  // R140 — ONE memoized formatter for BOTH the glance chip and the
  // regenerate dialog's meter line (the R138 single-locale law: every
  // AI-usage number rides dayLocale — fa-IR gives Persian digits).
  const numFmt = useMemo(() => new Intl.NumberFormat(dayLocale), [dayLocale]);

  // Keep the latest message in view (scroll-only effect — no setState).
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, pending, atBottom]);

  // Abort any in-flight stream when the module unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // ---- Session lifecycle ---------------------------------------------------

  // Hydrate this business's transcripts on mount / business switch.
  // localStorage renders instantly; the server copy (Phase 07 — transcripts
  // follow the user across devices) is then MERGED per session with a
  // newer-updatedAt-wins rule, so a device that just asked offline keeps
  // its newest turns while still receiving the rest of the history.
  useEffect(() => {
    let cancelled = false;
    const state = loadCopilotState(business.id);
    setSessions(state.sessions);
    setActiveSessionId(state.activeId);
    activeSessionIdRef.current = state.activeId;
    setHydrated(true);

    void fetchServerSessions(business.id).then((server) => {
      if (cancelled || !server || server.length === 0) return;
      setSessions((prev) => mergeWithServer(prev, server));
      // Returning on a fresh device (no local active session)? Surface the
      // most recent server transcript instead of an empty composer.
      setActiveSessionId((cur) => {
        if (cur) return cur;
        const newest = [...server].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        )[0];
        activeSessionIdRef.current = newest?.id ?? null;
        return newest?.id ?? null;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [business.id]);

  // Debounced write-through persistence (400ms) — streaming patches coalesce.
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      saveCopilotState(business.id, { sessions, activeId: activeSessionId });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sessions, activeSessionId, hydrated, business.id]);

  /** Point future message mutations at a live session (create if needed). */
  const ensureActiveSession = useCallback((titleQuestion?: string): string => {
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const session = createEmptySession(
      titleQuestion ? titleFromQuestion(titleQuestion) : "",
    );
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setSessions((prev) => [session, ...prev]);
    return session.id;
  }, []);

  /**
   * Mutate the ACTIVE session's messages. Accepts a value or updater so the
   * existing send/stream/patch code (and its functional setState calls)
   * keeps working unchanged.
   */
  const setMessages = useCallback(
    (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      const targetId = activeSessionIdRef.current;
      setSessions((prevSessions) => {
        const idx = prevSessions.findIndex((s) => s.id === targetId);
        if (idx === -1) {
          // No live session — create one from the resulting messages.
          if (!targetId) return prevSessions;
          const msgs = typeof update === "function" ? update([]) : update;
          if (msgs.length === 0) return prevSessions;
          const firstUser = msgs.find((m) => m.role === "user");
          const session: CopilotSession = {
            ...createEmptySession(firstUser ? titleFromQuestion(firstUser.content) : ""),
            id: targetId,
            messages: msgs,
            updatedAt: Date.now(),
          };
          return [session, ...prevSessions];
        }
        const cur = prevSessions[idx];
        const msgs =
          typeof update === "function"
            ? update(cur.messages as ChatMessage[])
            : update;
        const firstUser = msgs.find((m) => m.role === "user");
        const next: CopilotSession = {
          ...cur,
          title:
            cur.title ||
            (firstUser ? titleFromQuestion(firstUser.content) : cur.title),
          messages: msgs,
          updatedAt: Date.now(),
        };
        return [next, ...prevSessions.filter((s) => s.id !== targetId)];
      });
    },
    [],
  );

  /** Best-effort server mirror of one appended message (Phase 07). */
  const syncAppend = useCallback(
    (
      sessionId: string | null,
      msg: { role: "user" | "assistant"; content: string; meta?: unknown },
      title?: string,
    ) => {
      if (!sessionId) return;
      void serverAppendMessage(business.id, sessionId, msg, title);
    },
    [business.id],
  );

  const switchSession = useCallback((id: string) => {
    if (activeStreamId !== null) return; // never mid-stream
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  }, [activeStreamId]);

  const startNewConversation = useCallback(() => {
    if (activeStreamId !== null) return;
    if ((sessions.find((s) => s.id === activeSessionIdRef.current)?.messages ?? []).length === 0) {
      textareaRef.current?.focus();
      return; // already on a fresh conversation
    }
    const session = createEmptySession();
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setSessions((prev) => [session, ...prev]);
    textareaRef.current?.focus();
  }, [activeStreamId, sessions]);

  const deleteSession = useCallback(
    (id: string) => {
      if (activeStreamId !== null) return;
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeSessionIdRef.current === id) {
          const fallback = next[0]?.id ?? null;
          activeSessionIdRef.current = fallback;
          setActiveSessionId(fallback);
        }
        return next;
      });
      void serverDeleteSession(business.id, id);
      toast({ title: t("sessionDeletedToast") });
    },
    [activeStreamId, business.id, t],
  );

  /** Pin/unpin a conversation — pinned items sort first and survive pruning. */
  const togglePinSession = useCallback(
    (id: string) => {
      if (activeStreamId !== null) return;
      let willPin = false;
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== id) return s;
          willPin = !s.pinned;
          return { ...s, pinned: willPin, updatedAt: Date.now() };
        });
        // Re-sort: pinned first (stable), then newest first.
        return next
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
      });
      void serverUpdateSession(business.id, id, { pinned: willPin });
    },
    [activeStreamId, business.id],
  );

  /** Open the rename dialog for one conversation. */
  const openRename = useCallback((s: CopilotSession) => {
    setRenameId(s.id);
    setRenameValue(s.title || "");
  }, []);

  const submitRename = useCallback(() => {
    const id = renameId;
    const title = renameValue.trim().slice(0, 80);
    if (!id || title.length === 0) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, title, titleEdited: true, updatedAt: Date.now() } : s,
      ),
    );
    void serverUpdateSession(business.id, id, { title });
    setRenameId(null);
    setRenameValue("");
    toast({ title: t("renamedToast") });
  }, [renameId, renameValue, business.id, t]);

  /** Clear EVERY transcript for this business — local cache + server copy. */
  const clearAllSessions = useCallback(() => {
    if (activeStreamId !== null) return;
    setSessions([]);
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    clearCopilotState(business.id);
    void serverClearSessions(business.id);
    toast({ title: t("clearAllToast") });
  }, [activeStreamId, business.id, t]);

  const patchAssistant = useCallback(
    (id: string, patch: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
    },
    [],
  );

  const localizedError = useCallback(
    (code: string, details?: { retryAfterMs?: number; limit?: number; periodEnd?: string }) => {
      switch (code) {
        case "RATE_LIMITED":
          return t("errorRateLimited", {
            seconds: String(Math.max(1, Math.ceil((details?.retryAfterMs ?? 0) / 1000))),
          });
        case "PERMISSION_DENIED":
          return t("errorForbidden");
        case "AI_UNAVAILABLE":
          return t("errorAiUnavailable");
        case "USAGE_LIMIT_REACHED":
          // Prompt 21 §54/§98: honest, localized quota messaging — states
          // what happened and what the user can do; never invents payment.
          return details?.periodEnd
            ? t("errorUsageLimit", {
                limit: details.limit ?? 0,
                date: new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : uiLocale, {
                  dateStyle: "medium",
                }).format(new Date(details.periodEnd)),
              })
            : t("errorUsageLimitNoDate", { limit: details?.limit ?? 0 });
        default:
          return tErrors("generic");
      }
    },
    [t, tErrors, uiLocale],
  );

  const send = useCallback(
    async (question: string, history: ChatMessage[]) => {
      const trimmed = question.trim();
      if (!trimmed || trimmed.length > 500 || activeStreamId !== null) return;
      lastQuestionRef.current = trimmed;
      setAtBottom(true);

      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", ts: Date.now() },
      ]);
      setActiveStreamId(assistantId);

      const controller = new AbortController();
      abortRef.current = controller;

      // Stream accumulators — also used to mirror the finished answer to the
      // server transcript (Phase 07 cross-device persistence).
      let answerText = "";
      let answerMeta: CopilotMeta | undefined;
      // R126 — the logical operation id (client-generated UUID): the stop
      // beacon and the resume poll address THIS answer, never a new one.
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      activeRequestIdRef.current = requestId;
      // R126 — how many deltas the LIVE stream delivered (the resume
      // fromIndex): the server buffers every delta from 0, so the client
      // counts its own seen deltas and asks for the unseen suffix.
      let seenDeltas = 0;

      try {
        const res = await fetch("/api/v1/copilot/stream", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-business-id": business.id,
          },
          body: JSON.stringify({
            question: trimmed,
            history: history
              .filter((m) => !m.failed)
              .slice(-6)
              .map((m) => ({ role: m.role, content: m.content })),
            days,
            requestId,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let code = "INTERNAL_ERROR";
          let errDetails: { retryAfterMs?: number; limit?: number; periodEnd?: string } | undefined;
          try {
            const body = (await res.json()) as {
              error?: {
                code?: string;
                details?: {
                  retryAfterMs?: number;
                  limit?: number;
                  periodEnd?: string;
                };
              };
            };
            if (body?.error?.code) code = body.error.code;
            errDetails = body?.error?.details;
          } catch {
            // keep defaults
          }
          patchAssistant(assistantId, (m) => ({
            ...m,
            content: localizedError(code, errDetails),
            failed: true,
          }));
          return;
        }

        // Parse the SSE stream incrementally.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamError: { code?: string; message?: string } | null = null;
        let sawDone = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const evt of events) {
            for (const line of evt.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              let payload: {
                meta?: CopilotMeta;
                delta?: string;
                done?: boolean;
                error?: { code?: string; message?: string };
              };
              try {
                payload = JSON.parse(line.slice(6));
              } catch {
                continue;
              }
              if (payload.meta) {
                // First event — dataset provenance for this answer.
                const meta = payload.meta;
                answerMeta = meta;
                patchAssistant(assistantId, (m) => ({ ...m, meta }));
              } else if (typeof payload.delta === "string" && payload.delta.length > 0) {
                const delta = payload.delta;
                answerText += delta;
                seenDeltas += 1;
                patchAssistant(assistantId, (m) => ({
                  ...m,
                  content: m.content + delta,
                }));
              } else if (payload.error) {
                streamError = payload.error;
              } else if (payload.done) {
                sawDone = true;
              }
            }
          }
        }

        if (streamError) {
          const code = streamError.code ?? "INTERNAL_ERROR";
          if (code === "RATE_LIMITED" || code === "AI_UNAVAILABLE" || !sawDone) {
            patchAssistant(assistantId, (m) =>
              m.content.trim().length === 0
                ? { ...m, content: localizedError(code), failed: true }
                : { ...m, content: `${m.content}\n\n⚠ ${localizedError(code)}` },
            );
          }
        } else if (answerText.trim().length > 0) {
          // Completed answer → mirror to the server transcript (with its
          // citation provenance). Failed answers stay local-only by design.
          syncAppend(
            activeSessionIdRef.current,
            {
              role: "assistant",
              content: answerText,
              ...(answerMeta ? { meta: answerMeta } : {}),
            },
            titleFromQuestion(lastQuestionRef.current ?? ""),
          );
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          // User pressed Stop — keep the partial answer (and mirror it), drop it if empty.
          if (answerText.trim().length > 0) {
            syncAppend(
              activeSessionIdRef.current,
              {
                role: "assistant",
                content: answerText,
                ...(answerMeta ? { meta: answerMeta } : {}),
              },
              titleFromQuestion(lastQuestionRef.current ?? ""),
            );
          }
          setMessages((prev) =>
            prev.flatMap((m) =>
              m.id === assistantId ? (m.content.trim() ? [m] : []) : [m],
            ),
          );
        } else if (error instanceof ApiClientError) {
          patchAssistant(assistantId, (m) => ({
            ...m,
            content: localizedError(error.code),
            failed: true,
          }));
        } else if (answerText.length > 0) {
          // R126 — MID-ANSWER NETWORK CUT with deltas already delivered:
          // the server kept consuming the provider into the bounded resume
          // buffer (stream break law ③). Poll POST /copilot/stream/resume
          // and apply exactly the unseen suffix. Bounded patience — the
          // R126 law: ≤ 40 polls × 400ms (~16s window), tolerating 3
          // transport errors; beyond that the honest pre-R126 partial
          // handling takes over (the buffer TTL is 120s, so a cut within
          // the window heals; an answer still generating after the window
          // finalizes as a partial — never a fake completion).
          setResumingId(assistantId);
          let fromIndex = seenDeltas;
          let transportErrors = 0;
          let healedDone = false;
          let stoppedRemotely = false;
          let terminalCode: string | null = null;
          try {
            for (let poll = 0; poll < 40; poll += 1) {
              await new Promise((r) => setTimeout(r, 400));
              let snap: StreamResumeSnapshot | null = null;
              try {
                const res = await fetch("/api/v1/copilot/stream/resume", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: {
                    "content-type": "application/json",
                    "x-business-id": business.id,
                  },
                  body: JSON.stringify({ requestId, fromIndex }),
                });
                if (!res.ok) throw new Error(`resume-${res.status}`);
                snap = (await res.json()) as StreamResumeSnapshot;
              } catch {
                transportErrors += 1;
                if (transportErrors >= 3) break;
                continue;
              }
              // Overflow = a middle gap the buffer dropped — a replay from
              // this fromIndex would stitch a lie into the answer; finalize
              // with the live partial instead (never fabricate continuity).
              if (snap.overflow) break;
              if (snap.deltas.length > 0) {
                const joined = snap.deltas.join("");
                fromIndex = snap.nextIndex;
                answerText += joined;
                patchAssistant(assistantId, (m) => ({
                  ...m,
                  content: m.content + joined,
                }));
              }
              if (snap.error) {
                terminalCode = snap.error.code ?? "INTERNAL_ERROR";
                break;
              }
              if (snap.done) {
                healedDone = true;
                break;
              }
              if (snap.stopped) {
                stoppedRemotely = true;
                break;
              }
            }
          } finally {
            setResumingId((cur) => (cur === assistantId ? null : cur));
          }
          if (healedDone) {
            // Mirror-ONCE: the FULL healed answer enters the transcript.
            // The healed marker itself stays DEVICE-LOCAL (R128 law C): it
            // marks THIS device's transport healing, so the server
            // transcript deliberately strips it — a server-restored copy on
            // another device must never count as healed there.
            patchAssistant(assistantId, (m) => ({ ...m, healed: true }));
            syncAppend(
              activeSessionIdRef.current,
              {
                role: "assistant",
                content: answerText,
                ...(answerMeta ? { meta: answerMeta } : {}),
              },
              titleFromQuestion(lastQuestionRef.current ?? ""),
            );
          } else {
            // Gave up / overflow / remote stop / terminal error — finalize
            // the partial honestly: no fabricated continuity, a warning
            // suffix unless the answer was user-stopped (same law as the
            // Stop path below), and the partial mirrored once.
            const suffix = stoppedRemotely
              ? null
              : terminalCode
                ? localizedError(terminalCode)
                : localizedError("NETWORK_ERROR");
            if (suffix) {
              patchAssistant(assistantId, (m) => ({
                ...m,
                content: `${m.content}\n\n⚠ ${suffix}`,
              }));
            }
            syncAppend(
              activeSessionIdRef.current,
              {
                role: "assistant",
                content: answerText,
                ...(answerMeta ? { meta: answerMeta } : {}),
              },
              titleFromQuestion(lastQuestionRef.current ?? ""),
            );
          }
        } else {
          patchAssistant(assistantId, (m) => ({
            ...m,
            content: localizedError("NETWORK_ERROR"),
            failed: true,
          }));
        }
      } finally {
        abortRef.current = null;
        activeRequestIdRef.current = null;
        setActiveStreamId((cur) => (cur === assistantId ? null : cur));
        // R141 — refresh the meter the moment a stream ends (success,
        // failure, stop or heal — the server's truth wins either way).
        void queryClient.invalidateQueries({ queryKey: ["billing", "usage", "copilot"] });
      }
    },
    [activeStreamId, business.id, days, localizedError, patchAssistant, syncAppend, queryClient],
  );

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const sessionId = ensureActiveSession(trimmed);
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: trimmed, ts: Date.now() },
    ]);
    syncAppend(sessionId, { role: "user", content: trimmed }, titleFromQuestion(trimmed));
    void send(trimmed, messages);
  };

  const handleStop = () => {
    // R126 — stop the MODEL, not just the socket: fire the stop beacon
    // FIRST (keepalive, best-effort — the fetch below may kill the page's
    // pending requests), THEN abort. Without the beacon an abort after
    // deltas is indistinguishable from a network cut and the server would
    // keep generating (break law ③) — burning tokens the user cancelled.
    const rid = activeRequestIdRef.current;
    if (rid) {
      try {
        void fetch("/api/v1/copilot/stream/stop", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-business-id": business.id,
          },
          body: JSON.stringify({ requestId: rid }),
          keepalive: true,
        }).catch(() => {
          /* best-effort beacon — the abort below still ends the stream */
        });
      } catch {
        /* same — never let the beacon block the stop */
      }
    }
    abortRef.current?.abort();
  };

  const handleRetry = () => {
    const q = lastQuestionRef.current;
    if (!q || pending) return;
    const sessionId = ensureActiveSession();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: q, ts: Date.now() },
    ]);
    syncAppend(sessionId, { role: "user", content: q });
    void send(q, messages);
  };

  /**
   * R139 — regenerate: ask the SAME question again as a NEW turn. The
   * append-only transcript law holds (no deletion — the server mirror has
   * no per-message delete), so the old answer stays as history and the
   * fresh answer lands below; the metering honesty lives in the confirm
   * dialog the user just accepted.
   */
  const confirmRegenerate = () => {
    const q = regenerateQuestion;
    setRegenOpen(false);
    if (!q || pending) return;
    const sessionId = ensureActiveSession();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: q, ts: Date.now() },
    ]);
    syncAppend(sessionId, { role: "user", content: q }, titleFromQuestion(q));
    void send(q, messages);
  };

  const copyAnswer = async (m: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  };

  /** Download the Q&A transcript as a shareable Markdown file. */
  const exportTranscript = () => {
    if (messages.length === 0 || pending) return;
    try {
      const localeTag = business.locale === "fa" ? "fa-IR" : "en-GB";
      const nowLabel = new Intl.DateTimeFormat(localeTag, {
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date());
      const windowLabel = t(`window_${days}` as "window_7");

      const lines: string[] = [];
      lines.push(`# ${t("title")} — ${t("exportTranscript")}`);
      lines.push("");
      lines.push(`- **${business.name}**`);
      lines.push(`- ${t("windowLabel")}: ${windowLabel}`);
      lines.push(`- ${t("citationsGenerated", { time: nowLabel })}`);
      lines.push(`- ${t("groundedNote")}`);
      lines.push("");
      lines.push("---");

      let qIndex = 0;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== "user" || m.failed) continue;
        const answer = messages[i + 1];
        if (!answer || answer.role !== "assistant" || answer.failed) continue;
        qIndex += 1;
        lines.push("");
        lines.push(`## ${qIndex}. ${m.content}`);
        // R138 — the question's own stamp in the export (honest additive:
        // legacy unstamped questions simply omit the line).
        if (typeof m.ts === "number") {
          try {
            const askedLabel = new Intl.DateTimeFormat(localeTag, {
              dateStyle: "long",
              timeStyle: "short",
            }).format(new Date(m.ts));
            lines.push("");
            lines.push(`*${t("askedAt", { time: askedLabel })}*`);
          } catch {
            /* timestamp is decorative in the export */
          }
        }
        lines.push("");
        lines.push(answer.content);
        const meta = answer.meta;
        if (meta) {
          const c = meta.counts;
          const bits = [
            t(`window_${meta.days === 7 ? "7" : meta.days === 30 ? "30" : "90"}` as "window_7"),
            `${meta.rangeFrom} → ${meta.rangeTo}`,
            ...(c
              ? [
                  t("citationsSales", { count: c.sales }),
                  t("citationsExpenses", { count: c.expenses }),
                  t("citationsOpenInvoices", { count: c.openInvoices }),
                  t("citationsPayments", { count: c.recentPayments }),
                ]
              : []),
          ];
          try {
            const time = new Intl.DateTimeFormat(localeTag, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(new Date(meta.generatedAt));
            bits.push(t("citationsGenerated", { time }));
          } catch {
            /* timestamp is decorative in the export */
          }
          lines.push("");
          lines.push(`> ${t("citationsTitle")}: ${bits.join(" · ")}`);
        }
        lines.push("");
        lines.push("---");
      }

      if (qIndex === 0) return; // nothing answerable to export

      const md = lines.join("\n");
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `copilot-transcript-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: t("exportedToast") });
    } catch {
      toast({ title: t("exportFailed"), variant: "destructive" });
    }
  };

  const askFollowUp = (question: string) => {
    if (pending) return;
    const sessionId = ensureActiveSession();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: question, ts: Date.now() },
    ]);
    syncAppend(sessionId, { role: "user", content: question });
    void send(question, messages);
  };

  // Sessions that hold an actual transcript (pinned first, then newest —
  // setSessions keeps the mutated session at the front, hydration merges
  // sort the same way). NOTE: hooks must run before the `!canUse` return.
  const savedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false)),
    [sessions],
  );
  const recentSessions = savedSessions.slice(0, 3);

  // R138 — history search: blank query → the unfiltered list (pinned-first
  // law untouched); otherwise title-or-content match via the pure lib.
  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim();
    if (q.length === 0) return savedSessions;
    return savedSessions.filter((s) => sessionMatchesQuery(s, q));
  }, [savedSessions, sessionQuery]);
  const queryActive = sessionQuery.trim().length > 0;

  if (!canUse) {
    return (
      <div className="space-y-6" data-view="copilot">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Card className="mx-auto max-w-md p-8 text-center">
          <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
            <Lock className="text-muted-foreground size-5" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-base font-semibold">{t("lockedTitle")}</h2>
          <p className="text-muted-foreground mt-1.5 text-sm">{t("lockedDesc")}</p>
        </Card>
      </div>
    );
  }

  const empty = messages.length === 0;
  const lastFailed = !pending && messages[messages.length - 1]?.failed === true;
  const waitingForFirstToken =
    pending && (messages[messages.length - 1]?.content ?? "").length === 0;

  const formatRelative = (ts: number) => {
    try {
      const rtf = new Intl.RelativeTimeFormat(uiLocale === "fa" ? "fa" : "en", {
        numeric: "auto",
      });
      const diffMs = ts - Date.now();
      const mins = Math.round(diffMs / 60_000);
      if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
      const hours = Math.round(diffMs / 3_600_000);
      if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
      return rtf.format(Math.round(diffMs / 86_400_000), "day");
    } catch {
      return "";
    }
  };

  // R138 — transcript-time formatting. Locale source above (single law).
  const daySeparatorLabel = (sep: DaySeparator): string => {
    if (sep.kind === "today") return t("dayToday");
    if (sep.kind === "yesterday") return t("dayYesterday");
    try {
      return new Intl.DateTimeFormat(dayLocale, { dateStyle: "long" }).format(
        new Date(sep.ts),
      );
    } catch {
      return "";
    }
  };

  return (
    <div className="space-y-4" data-view="copilot">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <span className="text-muted-foreground border-emerald-500/30 bg-emerald-500/5 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {t("readOnly")}
          </span>
        }
      />

      <Card className="flex h-[calc(100svh-15rem)] min-h-[520px] flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="flex items-center gap-2" role="group" aria-label={t("windowLabel")}>
            <CalendarClock className="text-muted-foreground size-4" aria-hidden="true" />
            <span className="text-muted-foreground text-xs font-medium">{t("windowLabel")}</span>
            <div className="bg-muted flex overflow-hidden rounded-lg p-0.5">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setDays(w)}
                  aria-pressed={days === w}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    days === w
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`window_${w}` as "window_7")}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Collapsible open={dataOpen} onOpenChange={setDataOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-muted-foreground h-8 gap-1.5 text-xs">
                  <ListTree className="size-3.5" aria-hidden="true" />
                  {t("dataIncludedTitle")}
                  <ChevronDown className={cn("size-3.5 transition-transform", dataOpen && "rotate-180")} aria-hidden="true" />
                </Button>
              </CollapsibleTrigger>
            </Collapsible>
            {/* Conversation history — switch / resume / delete transcripts.
                R138: the dropdown carries a search box (title OR content
                match across the 20-session cap) and resets the filter on
                close so every open starts from the full list. */}
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) setSessionQuery("");
              }}
            >
              <DropdownMenuTrigger asChild disabled={pending}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1.5 text-xs hover:text-foreground"
                  title={t("sessionHistory")}
                  aria-label={t("sessionHistory")}
                >
                  <History className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("sessionHistory")}</span>
                  {savedSessions.length > 0 ? (
                    <span className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ms-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums">
                      {savedSessions.length}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
              align="end"
              className="w-80"
              onEscapeKeyDown={(event) => {
                // R141 — progressive-dismissal law: Escape with an ACTIVE
                // query swallows the dismiss (Radix honors
                // defaultPrevented) and clears the filter — the menu stays
                // open for a fresh look at the full list; a blank input
                // lets the menu close as usual. (The first attempt —
                // stopPropagation in the input's onKeyDown — could never
                // work: Radix's escape listener is a DOCUMENT-CAPTURE
                // listener, it fires before any target-level handler.)
                if (queryActive) {
                  event.preventDefault();
                  setSessionQuery("");
                }
              }}
            >
                <DropdownMenuLabel className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{t("sessionHistory")}</span>
                  {queryActive ? (
                    <span className="tabular-nums" aria-live="polite">
                      {filteredSessions.length}/{savedSessions.length}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {savedSessions.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-3 text-xs">
                    {t("noSessions")}
                  </p>
                ) : (
                  <>
                    {/* R138 — search across titles AND message content. The
                        clear affordance appears only while a query is active;
                        Escape still closes the menu (Radix default). */}
                    <div className="px-2 pb-2">
                      <div className="relative">
                        <Search
                          className="text-muted-foreground/70 pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2"
                          aria-hidden="true"
                        />
                        <Input
                          value={sessionQuery}
                          onChange={(e) => setSessionQuery(e.target.value)}
                          placeholder={t("searchSessions")}
                          aria-label={t("searchSessions")}
                          maxLength={80}
                          dir="auto"
                          data-testid="copilot-session-search"
                          className="h-8 pe-8 ps-8 text-xs"
                        />
                        {queryActive ? (
                          <button
                            type="button"
                            onClick={() => setSessionQuery("")}
                            aria-label={t("clearSearch")}
                            title={t("clearSearch")}
                            className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2"
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <DropdownMenuSeparator />
                    {filteredSessions.length === 0 ? (
                      <p
                        className="text-muted-foreground flex items-center gap-1.5 px-2 py-3 text-xs"
                        data-testid="copilot-session-search-empty"
                      >
                        <SearchX className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate">
                          {t("searchNoResults", { query: sessionQuery.trim() })}
                        </span>
                      </p>
                    ) : (
                      <div className="max-h-72 overflow-y-auto">
                        {filteredSessions.map((s) => {
                        // R141 — where did the query hit? Computed per row
                        // while the filter is active; null otherwise (the
                        // plain row, no fabricated highlights).
                        const match: SessionMatchParts | null = queryActive
                          ? sessionMatchParts(s, sessionQuery)
                          : null;
                        return (
                        <DropdownMenuItem
                          key={s.id}
                          onSelect={() => switchSession(s.id)}
                          className="focus:bg-muted/70 group/item items-start gap-2 rounded-md py-2"
                        >
                          <MessageSquareText
                            className={cn(
                              "mt-0.5 size-3.5 shrink-0",
                              s.pinned
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground",
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="block truncate text-xs font-medium">
                                {match && match.titleMarkStart >= 0 ? (
                                  <>
                                    {s.title.slice(0, match.titleMarkStart)}
                                    <mark className="rounded-[3px] bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25 dark:text-amber-50">
                                      {s.title.slice(match.titleMarkStart, match.titleMarkEnd)}
                                    </mark>
                                    {s.title.slice(match.titleMarkEnd)}
                                  </>
                                ) : (
                                  s.title || t("untitledConversation")
                                )}
                              </span>
                              {s.pinned ? (
                                <Pin
                                  className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                                  aria-label={t("pinnedLabel")}
                                />
                              ) : null}
                            </span>
                            {/* R141 — the match preview: WHERE the query hit
                                the conversation's content (the filter's honest
                                witness — a content-only match is no longer
                                invisible). Amber edge + mark on the first hit;
                                ellipses are the lib's cut-edge honesty.
                                R142 — the +N badge: when MORE messages match
                                than the previewed one, the row says so
                                (the count never lies about what it hides). */}
                            {match?.preview ? (
                              <span
                                className="text-muted-foreground/90 mt-0.5 flex items-center gap-1.5 text-[11px]"
                                dir="auto"
                                data-testid="copilot-session-match-preview"
                              >
                                <span className="min-w-0 flex-1 truncate border-s-2 border-amber-400/50 ps-1.5">
                                  {match.preview.slice(0, match.previewMarkStart)}
                                  <mark className="rounded-[3px] bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25 dark:text-amber-50">
                                    {match.preview.slice(match.previewMarkStart, match.previewMarkEnd)}
                                  </mark>
                                  {match.preview.slice(match.previewMarkEnd)}
                                </span>
                                {match.matchCount > 1 ? (
                                  <span
                                    className="border-border/60 bg-muted/50 shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium tabular-nums"
                                    title={t("moreMatches", { count: match.matchCount - 1 })}
                                    data-testid="copilot-session-match-count"
                                  >
                                    +{numFmt.format(match.matchCount - 1)}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                            <span className="text-muted-foreground block text-[11px] tabular-nums">
                              {t("messagesCount", { count: s.messages.length })}
                              {" · "}
                              {formatRelative(s.updatedAt)}
                            </span>
                          </span>
                          {s.id === activeSessionId ? (
                            <Check
                              className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                              aria-hidden="true"
                            />
                          ) : null}
                          <span
                            className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100 group-data-[highlighted]/item:opacity-100 focus-within:opacity-100 max-md:opacity-100 motion-reduce:transition-none"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePinSession(s.id);
                              }}
                              aria-label={s.pinned ? t("unpinConversation") : t("pinConversation")}
                              title={s.pinned ? t("unpinConversation") : t("pinConversation")}
                              className={cn(
                                "rounded p-1 transition-colors",
                                s.pinned
                                  ? "text-amber-600 hover:text-amber-700 dark:text-amber-400"
                                  : "text-muted-foreground/70 hover:text-foreground",
                              )}
                            >
                              {s.pinned ? (
                                <PinOff className="size-3.5" aria-hidden="true" />
                              ) : (
                                <Pin className="size-3.5" aria-hidden="true" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRename(s);
                              }}
                              aria-label={t("renameConversation")}
                              title={t("renameConversation")}
                              className="text-muted-foreground/70 hover:text-foreground rounded p-1 transition-colors"
                            >
                              <Pencil className="size-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSession(s.id);
                              }}
                              aria-label={t("deleteConversation")}
                              title={t("deleteConversation")}
                              className="text-muted-foreground/70 hover:text-destructive rounded p-1 transition-colors"
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                          </span>
                        </DropdownMenuItem>
                        );
                        })}
                      </div>
                    )}
                    {savedSessions.length >= MAX_SESSIONS ? (
                      <p className="text-muted-foreground/80 border-t px-2 pt-2 mt-2 text-[11px] leading-snug">
                        {t("historyCapNote", { count: MAX_SESSIONS })}
                      </p>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        setClearAllOpen(true);
                      }}
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive items-center gap-2 rounded-md"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      <span className="flex-1">{t("clearAll")}</span>
                      <span className="text-muted-foreground/70 text-[10px] tabular-nums">
                        {savedSessions.length}
                      </span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {messages.length > 0 ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1.5 text-xs hover:text-foreground"
                  onClick={exportTranscript}
                  disabled={pending}
                  title={t("exportTranscript")}
                  aria-label={t("exportTranscript")}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("exportTranscript")}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1.5 text-xs"
                  onClick={startNewConversation}
                  disabled={pending}
                  title={t("newConversation")}
                  aria-label={t("newConversation")}
                >
                  <RefreshCcw className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("newConversation")}</span>
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {/* Transparency: what data can the copilot see */}
        {dataOpen ? (
          <div className="bg-muted/40 border-b px-4 py-3">
            <p className="text-muted-foreground text-xs">{t("dataIncludedDesc")}</p>
            <ul className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {[
                { icon: BarChart3, label: t("sectionKpis") },
                { icon: CalendarClock, label: t("sectionTimeline") },
                { icon: Package, label: t("sectionTopProducts") },
                { icon: Wallet, label: t("sectionExpensesByCategory") },
                { icon: HandCoins, label: t("sectionOutstanding") },
                { icon: ListTree, label: t("sectionInventory") },
                { icon: ArrowDown, label: t("sectionRecentPayments") },
              ].map((row) => (
                <li key={row.label} className="flex items-center gap-1.5">
                  <row.icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                  <span className="text-muted-foreground">{row.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Messages — wrapped in a relative box so the scroll-to-bottom
            pill can float over the transcript without being clipped by
            the Card's overflow-hidden (R136). */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="absolute inset-0 space-y-4 overflow-y-auto px-4 py-4"
            onScroll={(e) => {
              const el = e.currentTarget;
              setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
            }}
          >
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="border-emerald-500/20 from-emerald-500/15 to-teal-500/10 flex size-14 items-center justify-center rounded-2xl border bg-gradient-to-br">
                <Bot className="text-emerald-700 size-7 dark:text-emerald-400" aria-hidden="true" />
              </div>
              <div>
                <p className="font-medium">{t("emptyTitle")}</p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
                  {t("emptyDesc")}
                </p>
              </div>
              {recentSessions.length > 0 ? (
                <div className="w-full max-w-lg">
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    {t("recentConversations")}
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {recentSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => switchSession(s.id)}
                        className="border-border bg-muted/40 hover:border-emerald-500/40 hover:bg-emerald-500/5 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background group active:scale-[0.98] inline-flex max-w-full items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all hover:shadow-sm motion-reduce:transition-none motion-reduce:active:scale-100"
                      >
                        {s.pinned ? (
                          <Pin
                            className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                            aria-label={t("pinnedLabel")}
                          />
                        ) : (
                          <MessageSquareText
                            className="text-muted-foreground group-hover:text-emerald-600 size-3 shrink-0 transition-colors dark:group-hover:text-emerald-400"
                            aria-hidden="true"
                          />
                        )}
                        <span className="max-w-44 truncate">{s.title || t("untitledConversation")}</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          · {t("messagesCount", { count: s.messages.length })}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-2 max-w-lg">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("suggestionsLabel")}
                </p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        const sessionId = ensureActiveSession(s);
                        setMessages([
                          { id: nextId(), role: "user", content: s, ts: Date.now() },
                        ]);
                        syncAppend(sessionId, { role: "user", content: s }, titleFromQuestion(s));
                        void send(s, []);
                      }}
                      className="border-border bg-background hover:border-emerald-500/40 hover:bg-emerald-500/5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => {
                // R138 — day separators + time labels (additive honesty):
                // a separator renders ONLY on an honest day boundary — the
                // first stamped message, or a stamped message whose local
                // calendar day differs from the previous STAMPED message's
                // day. Unstamped legacy messages never fabricate one.
                const mTs = typeof m.ts === "number" ? m.ts : null;
                const prevTs = i > 0 ? messages[i - 1]?.ts : undefined;
                const sep = mTs !== null ? daySeparatorFor(mTs) : null;
                const showSep =
                  mTs !== null &&
                  sep !== null &&
                  (i === 0 ||
                    (typeof prevTs === "number" &&
                      dayKeyLocal(prevTs) !== dayKeyLocal(mTs)));
                const sepLabel = sep ? daySeparatorLabel(sep) : "";
                const timeLabel = mTs !== null ? fmtTimeLabel(mTs, dayLocale) : "";
                return (
                  <Fragment key={m.id}>
                    {showSep && sepLabel ? (
                      <div
                        className="my-1 flex items-center gap-3"
                        role="separator"
                        aria-label={sepLabel}
                        data-testid="copilot-day-separator"
                      >
                        <span className="bg-border h-px flex-1" aria-hidden="true" />
                        <span className="border-border/70 bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium shadow-xs">
                          <CalendarDays
                            className="text-muted-foreground/70 size-3"
                            aria-hidden="true"
                          />
                          <span>{sepLabel}</span>
                        </span>
                        <span className="bg-border h-px flex-1" aria-hidden="true" />
                      </div>
                    ) : null}
                    {m.role === "user" ? (
                  <div className="flex items-start justify-end gap-2.5">
                    <div className="flex max-w-[85%] flex-col items-end sm:max-w-[70%]">
                    <div className="bg-primary text-primary-foreground group relative w-fit rounded-2xl rounded-ee-sm px-3.5 py-2.5 shadow-xs">
                      <p className="text-sm leading-relaxed whitespace-pre-wrap" dir="auto">
                        {m.content}
                      </p>
                      {/* R136 — the user's own question is copyable too
                          (answer/copy symmetry); the affordance rides the
                          SAME hover-reveal + focus-visible law as the
                          assistant bubble's copy button, inverted for the
                          primary surface. */}
                      {!pending ? (
                        <button
                          type="button"
                          onClick={() => void copyAnswer(m)}
                          aria-label={copiedId === m.id ? tCommon("copied") : tCommon("copy")}
                          className="absolute end-2 bottom-1.5 rounded p-1 text-primary-foreground/50 opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-primary-foreground focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none"
                        >
                          {copiedId === m.id ? (
                            <Check className="size-3.5" aria-hidden="true" />
                          ) : (
                            <Copy className="size-3.5" aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                    </div>
                    {timeLabel ? (
                      <time
                        dateTime={new Date(m.ts as number).toISOString()}
                        className="text-muted-foreground/70 mt-1 px-1 text-[10px] tabular-nums"
                      >
                        {timeLabel}
                      </time>
                    ) : null}
                    </div>
                    <div
                      className="bg-primary text-primary-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                      aria-hidden="true"
                    >
                      <UserRound className="size-3.5" />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2.5">
                    <div
                      className={cn(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
                        m.failed
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-emerald-500/20 from-emerald-500/15 to-teal-500/10 text-emerald-700 bg-gradient-to-br dark:text-emerald-400",
                      )}
                      aria-hidden="true"
                    >
                      {m.failed ? (
                        <TriangleAlert className="size-3.5" />
                      ) : (
                        <Bot className="size-3.5" />
                      )}
                    </div>
                    <div className="flex min-w-0 max-w-[88%] flex-col sm:max-w-[75%]">
                      <div
                        className={cn(
                          "group ring-border/40 relative w-fit rounded-2xl rounded-ss-sm border px-3.5 py-2.5 ring-1",
                          m.failed
                            ? "border-destructive/30 bg-destructive/5"
                            : "bg-muted/50 shadow-xs",
                        )}
                      >
                      {m.content.length === 0 && m.id === activeStreamId ? (
                        <div className="flex items-center gap-1.5 px-1 py-1">
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className="bg-muted-foreground/60 size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
                              style={{ animationDelay: `${i * 150}ms` }}
                            />
                          ))}
                          <span className="text-muted-foreground ms-1.5 text-xs">{t("thinking")}</span>
                        </div>
                      ) : (
                        <MarkdownLite text={m.content} streaming={m.id === activeStreamId} />
                      )}
                      {!m.failed && m.content.length > 0 && m.id !== activeStreamId ? (
                        <div
                          className="absolute end-2 bottom-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 motion-reduce:transition-none"
                        >
                          {/* R139 — regenerate: re-ask THIS question as a new
                              metered turn; only under the LAST completed
                              answer (canRegenerate). The spin-on-hover is
                              motion-guarded. */}
                          {canRegenerate && i === messages.length - 1 ? (
                            <button
                              type="button"
                              onClick={() => setRegenOpen(true)}
                              aria-label={t("regenerateAria")}
                              title={t("regenerateAria")}
                              data-testid="copilot-regenerate"
                              className="group/regen bg-background/80 border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/20 rounded border p-1.5 shadow-xs backdrop-blur-sm transition-[color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                              <RefreshCcw
                                className="size-3.5 transition-transform duration-500 group-hover/regen:-rotate-[360deg] motion-reduce:transition-none motion-reduce:group-hover/regen:rotate-0"
                                aria-hidden="true"
                              />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void copyAnswer(m)}
                            aria-label={copiedId === m.id ? t("copied") : t("copy")}
                            className="bg-background/80 border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/20 rounded border p-1.5 shadow-xs backdrop-blur-sm transition-[color,border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                          >
                            {copiedId === m.id ? (
                              <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
                            ) : (
                              <Copy className="size-3.5" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      ) : null}
                      </div>
                      {timeLabel ? (
                        <time
                          dateTime={new Date(m.ts as number).toISOString()}
                          className="text-muted-foreground/70 mt-1 px-1 text-[10px] tabular-nums"
                        >
                          {timeLabel}
                        </time>
                      ) : null}
                      {/* R136 — the R126/R127 restored-answer honesty marker
                          finally SURFACED: a healed answer (device-local flag,
                          never synced — R128 law C) shows a sky badge right
                          under its bubble. Shape rides statusPillBase (one
                          pill law); the hue is sky = informational, distinct
                          from the amber resuming pill's in-flight state. */}
                      {m.healed && !m.failed ? (
                        <span
                          title={t("restoredDesc")}
                          data-testid="copilot-restored-badge"
                          className={cn(
                            statusPillBase,
                            "border-sky-500/40 bg-sky-500/10 mt-1.5 text-sky-700 dark:text-sky-400",
                          )}
                        >
                          <History className="size-3" aria-hidden="true" />
                          <span>{t("restoredBadge")}</span>
                        </span>
                      ) : null}
                      {!m.failed && m.meta ? (
                        <CitationStrip meta={m.meta} locale={business.locale} business={business} />
                      ) : null}
                      {!m.failed && m.meta ? (
                        <StockActionChips meta={m.meta} business={business} />
                      ) : null}
                      {/* R143 — the perf chips: the grounded answer's proven
                          facts become REAL controls into the perf sub-view
                          (the R100 grammar's first external producers). */}
                      {!m.failed && m.meta ? (
                        <PerfActionChips meta={m.meta} business={business} />
                      ) : null}
                      {/* R147 — the outstanding drill chips: the proven
                          debtor/creditor leaders with a STABLE party id
                          drill into the §16/§18 aging-details boards. */}
                      {!m.failed && m.meta ? (
                        <OutstandingActionChips meta={m.meta} business={business} />
                      ) : null}
                      {/* R153 — the product chip: the proven best-seller
                          with a STABLE catalog id opens the product's own
                          surface (the R152 destination — stock lives
                          there). */}
                      {!m.failed && m.meta ? (
                        <ProductActionChip meta={m.meta} business={business} />
                      ) : null}
                      {resumingId === m.id ? (
                        <div
                          className={cn(
                            statusPillBase,
                            "border-amber-500/40 bg-amber-500/10 mt-1.5 text-amber-700 dark:text-amber-400",
                          )}
                          role="status"
                          aria-live="polite"
                        >
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                          <span>{t("resuming")}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  )}
                </Fragment>
              );
            })}

              {waitingForFirstToken ? null : null}

              {lastFailed ? (
                <div className="ps-9.5">
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={handleRetry}>
                    <RefreshCcw className="size-3.5" aria-hidden="true" />
                    {tCommon("retry")}
                  </Button>
                </div>
              ) : null}

              {followUps.length > 0 ? (
                <div
                  className="animate-in fade-in slide-in-from-bottom-1 ps-9.5"
                  data-testid="copilot-followups"
                >
                  <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                    <Sparkles className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    {t("followUpsLabel")}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {followUps.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => askFollowUp(t(key))}
                        className="border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-500/50 hover:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors motion-reduce:transition-none"
                      >
                        {t(key)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
          </div>

          {/* R136 — scroll-to-bottom pill: appears ONLY when the reader has
              scrolled away from the live edge (atBottom is scroll-derived);
              while a stream is running it becomes a "new answers" hint with
              a pulsing dot. Physical centering (left-1/2 -translate-x-1/2)
              is direction-agnostic — safe under RTL. */}
          {!atBottom && !empty ? (
            <button
              type="button"
              onClick={() =>
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: "smooth",
                })
              }
              aria-label={pending ? t("scrollBottomLive") : t("scrollBottom")}
              title={pending ? t("scrollBottomLive") : t("scrollBottom")}
              data-testid="copilot-scroll-bottom"
              className="border-border/70 bg-background/95 text-foreground animate-in fade-in slide-in-from-bottom-2 absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border py-1.5 pe-3 ps-2 text-xs font-medium shadow-md backdrop-blur transition-[box-shadow,border-color] hover:border-foreground/30 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background duration-200 motion-reduce:animate-none motion-reduce:transition-none"
            >
              <span className="relative flex items-center justify-center">
                <ArrowDown
                  className="text-emerald-600 size-3.5 dark:text-emerald-400"
                  aria-hidden="true"
                />
                {pending ? (
                  <span
                    className="bg-emerald-500 absolute -top-1 -end-1 size-1.5 animate-pulse rounded-full motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
              </span>
              <span>{pending ? t("scrollBottomLive") : t("scrollBottom")}</span>
            </button>
          ) : null}
        </div>

        {/* Composer */}
        <div className="border-t p-3 sm:p-4">
          <div className="border-input focus-within:ring-ring/40 flex items-end gap-2 rounded-2xl border p-2 transition-shadow focus-within:ring-2 focus-within:ring-offset-0">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              rows={1}
              maxLength={500}
              placeholder={t("placeholder")}
              aria-label={t("placeholder")}
              disabled={pending}
              className="placeholder:text-muted-foreground max-h-[120px] min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none disabled:opacity-50"
            />
            {pending ? (
              <Button
                size="icon"
                variant="secondary"
                className="border-destructive/30 text-destructive hover:bg-destructive/10 size-9 shrink-0 rounded-xl border"
                onClick={handleStop}
                aria-label={t("stop")}
                title={t("stop")}
              >
                <Square className="size-3.5 fill-current" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-9 shrink-0 rounded-xl"
                onClick={handleSubmit}
                disabled={input.trim().length === 0}
                aria-label={t("send")}
              >
                <SendHorizontal className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="text-muted-foreground mt-2 flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate">{t("groundedNote")}</span>
            <span className="flex shrink-0 items-center gap-2">
              {/* R140 — the usage glance chip: the plan's REAL AI-request
                  meter, always visible under the composer (fed by the same
                  shared query the regenerate dialog reads). §64 law: no
                  real used+limit pair → NO chip (unlimited plans and failed
                  fetches render nothing). The tone escalates honestly:
                  muted → amber at ≥80% → destructive when exhausted. */}
              {meter ? (
                <span
                  data-testid="copilot-usage-glance"
                  title={t("regenerateMeter", {
                    used: numFmt.format(meter.used),
                    limit: numFmt.format(meter.limit),
                  })}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] tabular-nums transition-colors",
                    meter.limit > 0 && meter.used / meter.limit >= 1
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : meter.limit > 0 && meter.used / meter.limit >= 0.8
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "border-border/70 bg-muted/40",
                  )}
                >
                  <Gauge className="size-3 shrink-0" aria-hidden="true" />
                  <span dir="ltr">
                    {numFmt.format(meter.used)}/{numFmt.format(meter.limit)}
                  </span>
                </span>
              ) : null}
              <span
                className={cn(
                  "shrink-0 tabular-nums transition-colors",
                  input.length >= 450 && "text-amber-600 dark:text-amber-400",
                )}
                dir="ltr"
              >
                {input.length}/500
              </span>
            </span>
          </p>
        </div>
      </Card>

      {/* Clear-all confirmation — controlled here so the dropdown can open
          it without closing itself mid-render (focus-return guard). */}
      <AlertDialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
              {t("clearAllTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("clearAllDesc", { count: savedSessions.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearAllSessions}
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t("clearAllConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* R139 — regenerate confirm: the metering honesty gate. Asking the
          same question again burns a NEW request — the dialog says so in
          plain words, shows the plan's REAL usage when it could be fetched
          (numbers through the SAME dayLocale Intl law; §64: an unlimited
          plan or a failed fetch simply shows no meter line, never fake
          numbers), and only the confirmation actually sends. */}
      <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <RefreshCcw className="text-primary size-4" aria-hidden="true" />
              {t("regenerateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("regenerateDesc", { question: regenerateQuestion ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {meter ? (
            <p
              className="text-muted-foreground border-border/60 bg-muted/40 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
              data-testid="copilot-regen-meter"
            >
              <Gauge className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="tabular-nums">
                {t("regenerateMeter", {
                  used: numFmt.format(meter.used),
                  limit: numFmt.format(meter.limit),
                })}
              </span>
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRegenerate}
              className="focus-visible:ring-emerald-500/40 bg-emerald-600 text-white hover:bg-emerald-600/90"
            >
              <RefreshCcw className="size-4" aria-hidden="true" />
              {t("regenerateConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename conversation — controlled Dialog opened from the history
          dropdown's pencil; saving mirrors the change to the server and
          marks the title user-edited so auto-title never overrides it. */}
      <Dialog
        open={renameId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameId(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Pencil className="text-primary size-4" aria-hidden="true" />
              {t("renameTitle")}
            </DialogTitle>
            <DialogDescription>{t("renameDesc")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
            className="space-y-4"
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={80}
              placeholder={t("renamePlaceholder")}
              aria-label={t("renameTitle")}
              autoFocus
              dir="auto"
            />
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRenameId(null);
                  setRenameValue("");
                }}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={renameValue.trim().length === 0}>
                <Check className="size-4" aria-hidden="true" />
                {t("renameSave")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
