"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  ArrowDown,
  BarChart3,
  BookMarked,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Download,
  HandCoins,
  ListTree,
  Lock,
  Package,
  ReceiptText,
  RefreshCcw,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  UserRound,
  Wallet,
} from "lucide-react";
import { ApiClientError } from "@/lib/api-client";
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
let seq = 0;
const nextId = () => `m${++seq}`;

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

function pickFollowUps(answer: string, conversationLength: number): FollowUpKey[] {
  const lead = FOLLOW_UP_MATCHERS.find((m) => m.re.test(answer))?.key;
  const rest = FOLLOW_UP_KEYS.filter((k) => k !== lead);
  const rotate = conversationLength % rest.length;
  const rotated = [...rest.slice(rotate), ...rest.slice(0, rotate)];
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

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const lastQuestionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(
    () => [
      t("suggestion1"),
      t("suggestion2"),
      t("suggestion3"),
      t("suggestion4"),
      t("suggestion5"),
      t("suggestion6"),
    ],
    [t],
  );

  const canUse = can(role, "copilot:use");
  const pending = activeStreamId !== null;

  // Follow-up chips — only under the LAST completed answer.
  const lastMessage = messages[messages.length - 1];
  const showFollowUps =
    !pending &&
    messages.length >= 2 &&
    lastMessage?.role === "assistant" &&
    lastMessage.failed !== true &&
    lastMessage.content.trim().length > 0;
  const followUps = useMemo(
    () => (showFollowUps ? pickFollowUps(lastMessage.content, messages.length) : []),
    [showFollowUps, lastMessage?.content, messages.length],
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

  const patchAssistant = useCallback(
    (id: string, patch: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
    },
    [],
  );

  const localizedError = useCallback(
    (code: string, retryAfterMs?: number) => {
      switch (code) {
        case "RATE_LIMITED":
          return t("errorRateLimited", {
            seconds: String(Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))),
          });
        case "PERMISSION_DENIED":
          return t("errorForbidden");
        case "AI_UNAVAILABLE":
          return t("errorAiUnavailable");
        default:
          return tErrors("generic");
      }
    },
    [t, tErrors],
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
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let code = "INTERNAL_ERROR";
          let retryAfterMs: number | undefined;
          try {
            const body = (await res.json()) as {
              error?: { code?: string; details?: { retryAfterMs?: number } };
            };
            if (body?.error?.code) code = body.error.code;
            retryAfterMs = body?.error?.details?.retryAfterMs;
          } catch {
            // keep defaults
          }
          patchAssistant(assistantId, (m) => ({
            ...m,
            content: localizedError(code, retryAfterMs),
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
                patchAssistant(assistantId, (m) => ({ ...m, meta }));
              } else if (typeof payload.delta === "string" && payload.delta.length > 0) {
                const delta = payload.delta;
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
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          // User pressed Stop — keep the partial answer, drop it if empty.
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
        } else {
          patchAssistant(assistantId, (m) => ({
            ...m,
            content: localizedError("NETWORK_ERROR"),
            failed: true,
          }));
        }
      } finally {
        abortRef.current = null;
        setActiveStreamId((cur) => (cur === assistantId ? null : cur));
      }
    },
    [activeStreamId, business.id, days, localizedError, patchAssistant],
  );

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: trimmed }]);
    void send(trimmed, messages);
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleRetry = () => {
    const q = lastQuestionRef.current;
    if (!q || pending) return;
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: q }]);
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
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: question }]);
    void send(question, messages);
  };

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
            {messages.length > 0 ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1.5 text-xs hover:text-foreground"
                  onClick={exportTranscript}
                  disabled={pending}
                  title={t("exportTranscript")}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("exportTranscript")}</span>
                  <span className="sr-only">{t("exportTranscript")}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-8 gap-1.5 text-xs"
                  onClick={() => setMessages([])}
                  disabled={pending}
                >
                  <RefreshCcw className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t("newConversation")}</span>
                  <span className="sr-only">{t("newConversation")}</span>
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
                        setMessages([{ id: nextId(), role: "user", content: s }]);
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
    </div>
  );
}
