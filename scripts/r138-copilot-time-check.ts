/**
 * scripts/r138-copilot-time-check.ts — R138 battery.
 *
 * Pins the copilot transcript-TIME wave (per-message stamps, day
 * separators, history search) and the r103 preflight fix:
 *
 *   [1] i18n LAW — the 6 new keys exist in BOTH locales, symmetric and
 *       non-empty; FA strings are genuinely Persian (no bare EN sentences),
 *       EN strings carry no Persian.
 *   [2] PURE TIME LAWS — dayKeyLocal is LOCAL-calendar (never UTC) and
 *       defensive; daySeparatorFor answers today/yesterday/date, survives
 *       the 23:59→00:01 midnight boundary as "yesterday" (direct key
 *       comparison, NOT a raw 24h subtraction), and returns null for
 *       non-finite stamps (the honest additive law).
 *   [3] SEARCH LAW — sessionMatchesQuery matches title OR message content,
 *       case-insensitively; a blank/whitespace query matches everything
 *       (the unfiltered list); null sessions and malformed messages never
 *       crash (law F).
 *   [4] SANITIZER + HYDRATION LAWS — loadCopilotState preserves finite ts
 *       and drops non-finite ones; mergeWithServer maps the server row's
 *       createdAt onto ts and honestly omits non-parseable stamps.
 *   [5] SOURCE LAWS (copilot-view) — ALL FIVE creation sites stamp ts; the
 *       day separator renders ONLY on an honest boundary (first stamped
 *       message or a dayKey change vs the previous stamped message) and
 *       carries role=separator + aria-label + its testid; time labels use
 *       the <time dateTime> element with tabular-nums on BOTH roles;
 *       fmtTimeLabel never throws; the history search input carries its
 *       testid + aria-label + clear affordance + honest no-results state +
 *       the shown/total count; the filter resets when the dropdown closes;
 *       the export stamps each question with askedAt (gated on ts).
 *   [6] SYNC SOURCE LAW — copilot-sync maps createdAt only when
 *       Number.isFinite(Date.parse(...)) (never a fabricated NaN stamp).
 *   [7] R103 PREFLIGHT — the bare invocation now fails with the documented
 *       prescription (no cryptic Client-Component stack) and the header
 *       keeps the --conditions react-server law.
 *
 * Run: bun scripts/r138-copilot-time-check.ts
 */
export {};

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function count(hay: string, needle: string) {
  return hay.split(needle).length - 1;
}

const view = readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
const sync = readFileSync("src/lib/copilot-sync.ts", "utf8");
const lib = readFileSync("src/lib/copilot-sessions.ts", "utf8");
const proofs = readFileSync("scripts/r103-tile-api-proofs.ts", "utf8");
const en = readFileSync("src/i18n/messages/en.ts", "utf8");
const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");

// ---- [1] i18n law -----------------------------------------------------------

const NEW_KEYS = [
  "dayToday",
  "dayYesterday",
  "searchSessions",
  "clearSearch",
  "searchNoResults",
  "askedAt",
] as const;

function sectionOf(src: string, section: string): string {
  const start = src.indexOf(`  ${section}: {`);
  if (start < 0) return "";
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open, i + 1);
}

const enCopilot = sectionOf(en, "copilot");
const faCopilot = sectionOf(fa, "copilot");
const hasPersian = (s: string) => /[\u0600-\u06FF]/.test(s);

for (const key of NEW_KEYS) {
  const enMatch = enCopilot.match(new RegExp(`${key}: "([^"]*)"`));
  const faMatch = faCopilot.match(new RegExp(`${key}: "([^"]*)"`));
  ok(`[1] ${key} exists in EN`, !!enMatch);
  ok(`[1] ${key} exists in FA`, !!faMatch);
  if (enMatch && faMatch) {
    ok(
      `[1] ${key} EN is English, FA is Persian`,
      !hasPersian(enMatch[1]) && hasPersian(faMatch[1]),
      `EN="${enMatch[1]}" FA="${faMatch[1]}"`,
    );
    ok(`[1] ${key} FA preserves the {query}/{time} placeholder law`, (() => {
      const placeholders = (s: string) => (s.match(/\{(query|time)\}/g) ?? []).sort().join(",");
      return placeholders(enMatch[1]) === placeholders(faMatch[1]);
    })());
  }
}

// ---- [2] pure time laws ------------------------------------------------------

const {
  dayKeyLocal,
  daySeparatorFor,
  sessionMatchesQuery,
} = await import("../src/lib/copilot-sessions");

// Local-calendar key of a known instant: build it FROM a Date so the
// expectation follows the machine's timezone whatever it is.
const noon = new Date();
noon.setHours(12, 0, 0, 0);
const noonTs = noon.getTime();
const manualKey = `${noon.getFullYear()}-${String(noon.getMonth() + 1).padStart(2, "0")}-${String(noon.getDate()).padStart(2, "0")}`;
ok("[2] dayKeyLocal is the LOCAL calendar key", dayKeyLocal(noonTs) === manualKey, `${dayKeyLocal(noonTs)} vs ${manualKey}`);
ok("[2] dayKeyLocal defensive: NaN → empty", dayKeyLocal(Number.NaN) === "");
ok("[2] dayKeyLocal defensive: Infinity → empty", dayKeyLocal(Number.POSITIVE_INFINITY) === "");

const now = noonTs;
ok("[2] separator: same local day → today", daySeparatorFor(noonTs, now)?.kind === "today");
ok("[2] separator: 24h-1ms ago can still be YESTERDAY (23:59 law)", (() => {
  // 12:00 today minus 24h+1ms ≈ 11:59:59.999 YESTERDAY → key must differ
  // from today's key and equal yesterday's key.
  const sep = daySeparatorFor(noonTs - 86_400_001, now);
  return sep?.kind === "yesterday";
})());
ok("[2] separator: yesterday's noon → yesterday", daySeparatorFor(noonTs - 86_400_000, now)?.kind === "yesterday");
ok("[2] separator: a week ago → date kind carrying the stamp", (() => {
  const sep = daySeparatorFor(noonTs - 7 * 86_400_000, now);
  return sep?.kind === "date" && sep.ts === noonTs - 7 * 86_400_000;
})());
ok("[2] separator: non-finite stamp → null (no fabricated day)", daySeparatorFor(Number.NaN, now) === null);
ok("[2] separator: midnight wrap — 00:01 today, message 23:59 yesterday", (() => {
  const at = new Date(now);
  at.setHours(0, 1, 0, 0);
  const msg = new Date(at.getTime() - 2 * 60_000); // 23:59 yesterday
  return daySeparatorFor(msg.getTime(), at.getTime())?.kind === "yesterday";
})());

// ---- [3] search law -----------------------------------------------------------

const sess = (title: string, contents: string[]) => ({
  title,
  messages: contents.map((content) => ({ content })),
});
ok("[3] matches by title", sessionMatchesQuery(sess("Revenue talk", ["hello"]), "revenue"));
ok("[3] matches by message content", sessionMatchesQuery(sess("Untitled", ["low stock alert for Sku-A"]), "sku-a"));
ok("[3] case-insensitive both sides", sessionMatchesQuery(sess("Invoices", ["OVERDUE list"]), "overdue"));
ok("[3] blank query matches everything", sessionMatchesQuery(sess("anything", []), ""));
ok("[3] whitespace query matches everything", sessionMatchesQuery(sess("anything", []), "   "));
ok("[3] no match → false", sessionMatchesQuery(sess("Revenue", ["hello"]), "zzz") === false);
ok("[3] null session never crashes", sessionMatchesQuery(null, "q") === false);
ok(
  "[3] malformed messages never crash and never match",
  sessionMatchesQuery({ title: "t", messages: [null, 42, {}] } as never, "zz") === false,
);
ok(
  "[3] malformed messages still fall back to the title",
  sessionMatchesQuery({ title: "t", messages: [null, 42, {}] } as never, "t") === true,
);
ok("[3] missing title + no messages → false on any query", sessionMatchesQuery({}, "q") === false);

// ---- [4] sanitizer + hydration laws -------------------------------------------

const stored = {
  sessions: [
    {
      id: "s-1",
      title: "Time wave",
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [
        { id: "m-1", role: "user", content: "when?", ts: 1_234_567 },
        { id: "m-2", role: "assistant", content: "now", ts: Number.NaN },
        { id: "m-3", role: "assistant", content: "old" },
      ],
    },
  ],
  activeId: "s-1",
};
const fakeStorage = new Map<string, string>([["abc:copilot:sessions:v1:biz-1", JSON.stringify(stored)]]);
const prevWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => fakeStorage.get(k) ?? null,
    setItem: (k: string, v: string) => void fakeStorage.set(k, v),
    removeItem: (k: string) => void fakeStorage.delete(k),
  },
};
const { loadCopilotState } = await import("../src/lib/copilot-sessions");
const hydrated = loadCopilotState("biz-1");
(globalThis as { window?: unknown }).window = prevWindow;
const msgs = hydrated.sessions[0]?.messages ?? [];
ok("[4] finite ts survives the sanitizer", msgs[0]?.ts === 1_234_567);
ok("[4] non-finite ts is DROPPED (never fabricated)", msgs[1] && !("ts" in msgs[1]));
ok("[4] unstamped legacy message stays unstamped", msgs[2] && !("ts" in msgs[2]));

const { mergeWithServer } = await import("../src/lib/copilot-sync");
const server = [
  {
    id: "s-1",
    title: "Time wave",
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(9_000).toISOString(),
    messages: [
      { id: "m-1", role: "user", content: "when?", createdAt: "2026-10-30T10:30:00.000Z" },
      { id: "m-2", role: "assistant", content: "now", createdAt: "not-a-date" },
    ],
  },
];
const merged = mergeWithServer([], server as never);
const mergedMsgs = merged[0]?.messages ?? [];
ok("[4] server createdAt maps onto ts", mergedMsgs[0]?.ts === Date.parse("2026-10-30T10:30:00.000Z"));
ok("[4] non-parseable server stamp is honestly omitted", mergedMsgs[1] && !("ts" in mergedMsgs[1]));

// ---- [5] source laws (copilot-view) -------------------------------------------

ok("[5] all FIVE creation sites stamp ts", count(view, "ts: Date.now()") === 5, String(count(view, "ts: Date.now()")));
ok("[5] ChatMessage carries the additive ts field", /type ChatMessage = \{[\s\S]*?ts\?: number;/.test(view));
ok(
  "[5] separator gated on honest boundaries only",
  view.includes("mTs !== null &&") &&
    view.includes("dayKeyLocal(prevTs) !== dayKeyLocal(mTs)") &&
    view.includes("i === 0 ||"),
);
ok(
  "[5] separator a11y: role=separator + aria-label + testid",
  view.includes('role="separator"') &&
    view.includes('aria-label={sepLabel}') &&
    view.includes('data-testid="copilot-day-separator"'),
);
ok(
  "[5] time labels ride the <time dateTime> element with tabular-nums",
  count(view, "<time") === 2 &&
    count(view, "dateTime={new Date(m.ts as number).toISOString()}") === 2 &&
    count(view, "text-muted-foreground/70 mt-1 px-1 text-[10px] tabular-nums") === 2,
  `<time> count=${count(view, "<time")}`,
);
ok("[5] fmtTimeLabel never throws (try/catch law)", /function fmtTimeLabel\([\s\S]*?try \{[\s\S]*?\} catch \{/.test(view));
ok(
  "[5] ONE locale law: the separator + time labels share dayLocale",
  view.includes('const dayLocale = uiLocale === "fa" ? "fa-IR" : "en-GB";') &&
    count(view, "fmtTimeLabel(mTs, dayLocale)") === 1 &&
    view.includes("daySeparatorLabel(sep)"),
);
ok(
  "[5] history search: input carries testid + aria-label + dir=auto",
  view.includes('data-testid="copilot-session-search"') &&
    view.includes('aria-label={t("searchSessions")}') &&
    view.includes('dir="auto"'),
);
ok(
  "[5] search: honest no-results state + shown/total count + clear affordance",
  view.includes('data-testid="copilot-session-search-empty"') &&
    view.includes("{filteredSessions.length}/{savedSessions.length}") &&
    view.includes('aria-label={t("clearSearch")}'),
);
ok(
  "[5] search: filter law + reset-on-close",
  view.includes("sessionMatchesQuery(s, q)") &&
    view.includes('if (!open) setSessionQuery("");'),
);
ok(
  "[5] export stamps each question (gated on the stamp, never fabricated)",
  view.includes('typeof m.ts === "number"') && view.includes('t("askedAt", { time: askedLabel })'),
);
ok(
  "[5] cap note stays on the TOTAL list (search never hides the 20-law)",
  view.includes("savedSessions.length >= MAX_SESSIONS"),
);

// ---- [6] sync source law --------------------------------------------------------

ok(
  "[6] sync maps createdAt only when parseable",
  sync.includes("Number.isFinite(Date.parse(m.createdAt))") && sync.includes("ts: Date.parse(m.createdAt)"),
);

// ---- [7] r103 preflight ---------------------------------------------------------

ok(
  "[7] r103 header keeps the react-server law",
  proofs.includes("bun --conditions react-server scripts/r103-tile-api-proofs.ts"),
);
ok(
  "[7] r103 bare invocation fails with the prescription (no cryptic stack)",
  proofs.includes("server-only guard tripped") &&
    proofs.includes("bun --conditions react-server scripts/r103-tile-api-proofs.ts"),
);

// ---- summary ---------------------------------------------------------------------

console.log(`\n== r138: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
