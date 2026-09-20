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
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  HandCoins,
  ListTree,
  Lock,
  Package,
  RefreshCcw,
  SendHorizontal,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  Wallet,
} from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { cn } from "@/lib/utils";
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
 * AI Copilot — Phase 05. Read-only Q&A over deterministic, server-computed
 * figures (A11-A13). The client sends ONLY the question + conversation
 * history; all authoritative data is injected server-side.
 */

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  failed?: boolean;
};

type CopilotMeta = {
  days: number;
  generatedAt: string;
  rangeFrom: string;
  rangeTo: string;
  sections: string[];
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

function MarkdownLite({ text }: { text: string }) {
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

  return <div className="space-y-1.5 text-sm">{nodes}</div>;
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
  const [pending, setPending] = useState(false);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const lastQuestionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canUse = can(role, "copilot:use");

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

  // Keep the latest message in view (scroll-only effect — no setState).
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, pending, atBottom]);

  const send = useCallback(
    async (question: string, history: ChatMessage[]) => {
      const trimmed = question.trim();
      if (!trimmed || trimmed.length > 500) return;
      lastQuestionRef.current = trimmed;
      setPending(true);
      setAtBottom(true);
      try {
        const res = await api<{ answer: string; meta: CopilotMeta }>(
          "/api/v1/copilot",
          {
            method: "POST",
            body: JSON.stringify({
              question: trimmed,
              history: history
                .filter((m) => !m.failed)
                .slice(-6)
                .map((m) => ({ role: m.role, content: m.content })),
              days,
            }),
          },
        );
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: res.answer },
        ]);
      } catch (error) {
        const code =
          error instanceof ApiClientError ? error.code : "INTERNAL_ERROR";
        const retryAfterMs =
          (error as { details?: { retryAfterMs?: number } })?.details
            ?.retryAfterMs ?? 0;
        const fallback =
          code === "RATE_LIMITED"
            ? t("errorRateLimited", {
                seconds: String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
              })
            : code === "PERMISSION_DENIED"
              ? t("errorForbidden")
              : tErrors("generic");
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: fallback, failed: true },
        ]);
      } finally {
        setPending(false);
      }
    },
    [days, t, tErrors],
  );

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || pending) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: trimmed }]);
    void send(trimmed, messages);
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
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-8 gap-1.5 text-xs"
                onClick={() => setMessages([])}
                disabled={pending}
              >
                <RefreshCcw className="size-3.5" aria-hidden="true" />
                {t("newConversation")}
              </Button>
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
                    <div
                      className={cn(
                        "group relative max-w-[88%] rounded-2xl rounded-ss-sm border px-3.5 py-2.5 sm:max-w-[75%]",
                        m.failed
                          ? "border-destructive/30 bg-destructive/5"
                          : "bg-muted/50",
                      )}
                    >
                      <MarkdownLite text={m.content} />
                      {!m.failed ? (
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
                  </div>
                ),
              )}

              {pending ? (
                <div className="flex items-start gap-2.5" aria-live="polite">
                  <div
                    className="border-emerald-500/20 from-emerald-500/15 to-teal-500/10 text-emerald-700 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-gradient-to-br dark:text-emerald-400"
                    aria-hidden="true"
                  >
                    <Bot className="size-3.5" />
                  </div>
                  <div className="bg-muted/50 flex items-center gap-1.5 rounded-2xl rounded-ss-sm border px-4 py-3">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="bg-muted-foreground/60 size-1.5 animate-bounce rounded-full"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                    <span className="text-muted-foreground ms-1.5 text-xs">{t("thinking")}</span>
                  </div>
                </div>
              ) : null}

              {lastFailed ? (
                <div className="ps-9.5">
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={handleRetry}>
                    <RefreshCcw className="size-3.5" aria-hidden="true" />
                    {tCommon("retry")}
                  </Button>
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
            <Button
              size="icon"
              className="size-9 shrink-0 rounded-xl"
              onClick={handleSubmit}
              disabled={pending || input.trim().length === 0}
              aria-label={t("send")}
            >
              <SendHorizontal className="size-4" aria-hidden="true" />
            </Button>
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
