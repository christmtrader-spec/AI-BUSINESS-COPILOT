"use client";

import {
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
  BarChart3,
  BookMarked,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Download,
  HandCoins,
  History,
  ListTree,
  Lock,
  MessageSquareText,
  Package,
  Pencil,
  Pin,
  PinOff,
  ReceiptText,
  RefreshCcw,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  UserRound,
  Wallet,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiClientError } from "@/lib/api-client";
import {
  clearCopilotState,
  createEmptySession,
  loadCopilotState,
  MAX_SESSIONS,
  newMessageId,
  saveCopilotState,
  titleFromQuestion,
  type CopilotSession,
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

/**
 * AI Copilot — Phase 05/06. Read-only Q&A over deterministic, server-computed
 * figures (A11-A13). The client sends ONLY the question + conversation
 * history; all authoritative data is injected server-side.
 *
 * Phase 06: answers stream token-by-token over SSE
 * (`POST /api/v1/copilot/stream`), with a Stop control that aborts the
 * stream and keeps the partial answer.
 */

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
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
function CitationStrip({ meta, locale }: { meta: CopilotMeta; locale: string }) {
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
          className="border-border/70 bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none"
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
        { id: assistantId, role: "assistant", content: "" },
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
      }
    },
    [activeStreamId, business.id, days, localizedError, patchAssistant, syncAppend],
  );

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const sessionId = ensureActiveSession(trimmed);
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: trimmed }]);
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
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: q }]);
    syncAppend(sessionId, { role: "user", content: q });
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
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: question }]);
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
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
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
            {/* Conversation history — switch / resume / delete transcripts. */}
            <DropdownMenu>
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
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("sessionHistory")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {savedSessions.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-3 text-xs">
                    {t("noSessions")}
                  </p>
                ) : (
                  <>
                    <div className="max-h-72 overflow-y-auto">
                      {savedSessions.map((s) => (
                        <DropdownMenuItem
                          key={s.id}
                          onSelect={() => switchSession(s.id)}
                          className="focus:bg-muted/70 items-start gap-2 rounded-md py-2"
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
                                {s.title || t("untitledConversation")}
                              </span>
                              {s.pinned ? (
                                <Pin
                                  className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                                  aria-label={t("pinnedLabel")}
                                />
                              ) : null}
                            </span>
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
                            className="flex shrink-0 items-center gap-0.5"
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
                      ))}
                    </div>
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

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
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
                        className="border-border bg-muted/40 hover:border-emerald-500/40 hover:bg-emerald-500/5 group inline-flex max-w-full items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all hover:shadow-sm"
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
                        setMessages([{ id: nextId(), role: "user", content: s }]);
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
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="flex items-start justify-end gap-2.5">
                    <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-ee-sm px-3.5 py-2.5 sm:max-w-[70%]">
                      <p className="text-sm leading-relaxed whitespace-pre-wrap" dir="auto">
                        {m.content}
                      </p>
                    </div>
                    <div
                      className="bg-primary text-primary-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                      aria-hidden="true"
                    >
                      <UserRound className="size-3.5" />
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex items-start gap-2.5">
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
                          "group relative w-fit rounded-2xl rounded-ss-sm border px-3.5 py-2.5",
                          m.failed
                            ? "border-destructive/30 bg-destructive/5"
                            : "bg-muted/50",
                        )}
                      >
                      {m.content.length === 0 && m.id === activeStreamId ? (
                        <div className="flex items-center gap-1.5 px-1 py-1">
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              className="bg-muted-foreground/60 size-1.5 animate-bounce rounded-full"
                              style={{ animationDelay: `${i * 150}ms` }}
                            />
                          ))}
                          <span className="text-muted-foreground ms-1.5 text-xs">{t("thinking")}</span>
                        </div>
                      ) : (
                        <MarkdownLite text={m.content} streaming={m.id === activeStreamId} />
                      )}
                      {!m.failed && m.content.length > 0 && m.id !== activeStreamId ? (
                        <button
                          type="button"
                          onClick={() => void copyAnswer(m)}
                          aria-label={copiedId === m.id ? t("copied") : t("copy")}
                          className="text-muted-foreground hover:text-foreground absolute end-2 bottom-1.5 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          {copiedId === m.id ? (
                            <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
                          ) : (
                            <Copy className="size-3.5" aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                      </div>
                      {!m.failed && m.meta ? (
                        <CitationStrip meta={m.meta} locale={business.locale} />
                      ) : null}
                      {resumingId === m.id ? (
                        <div
                          className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                          role="status"
                          aria-live="polite"
                        >
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                          <span>{t("resuming")}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )}

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
                        className="border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-500/50 hover:bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
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
            <span className="shrink-0 tabular-nums" dir="ltr">
              {input.length}/500
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
