/**
 * scripts/r141-search-highlight-check.ts — R141 battery.
 *
 * Pins the session-search MATCH WITNESS wave (where did the query hit?):
 *
 *   [1] PURE LAWS (sessionMatchParts) — title-hit offsets land on the first
 *       occurrence and slice the ORIGINAL text back to the lowered query;
 *       the content preview windows the first content-matching message with
 *       honest ellipses ONLY on actual cut edges; the mark offsets index the
 *       WINDOW slice; a blank query / malformed session yields the honest
 *       blank (no fabricated highlights); case-insensitive EN and verbatim
 *       FA both align; the FIRST message and FIRST occurrence win.
 *   [2] SOURCE LAWS (copilot-view) — the row computes `match` gated on
 *       queryActive; title + preview render <mark> highlights with the ONE
 *       shared amber class law; the preview line carries its testid, the
 *       amber edge and dir="auto"; the Escape progressive-dismissal law
 *       (active query → stopPropagation + clear, menu stays open).
 *   [3] REGRESSION PINS — the R138 search block survives untouched (input
 *       testid, aria, clear affordance, no-results state, shown/total
 *       count, reset-on-close) and sessionMatchesQuery is unmodified.
 *
 * Run: bun scripts/r141-search-highlight-check.ts
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
const lib = readFileSync("src/lib/copilot-sessions.ts", "utf8");

// ---- [1] pure laws ----------------------------------------------------------

const { sessionMatchParts, sessionMatchesQuery } = await import("../src/lib/copilot-sessions");

const mk = (title: string, contents: string[]) => ({
  id: "s-test",
  title,
  createdAt: 0,
  updatedAt: 0,
  messages: contents.map((content, i) => ({ id: `m-${i}`, role: "user" as const, content })),
});

// Title hit: exact first-occurrence offsets; the slice equals the query.
{
  const p = sessionMatchParts(mk("Revenue in October", []), "october");
  ok("[1] title hit — markStart first-occurrence offset", p.titleMarkStart === 11, JSON.stringify(p));
  ok("[1] title hit — markEnd = start + q.length", p.titleMarkEnd === 18, JSON.stringify(p));
  ok(
    "[1] title hit — the marked slice reads the query (case folded)",
    p.titleMarkStart >= 0 &&
      "Revenue in October".slice(p.titleMarkStart, p.titleMarkEnd) === "October",
    JSON.stringify(p),
  );
  ok("[1] title-only hit — no fabricated preview", p.preview === null && p.previewMarkStart === -1);
}

// Content hit: windowed preview, mark offsets index the WINDOW slice.
{
  const long = "The monthly totals were computed from ledger entries; revenue in October reached the target and October closed strong.";
  const p = sessionMatchParts(mk("Chit-chat", [long]), "october");
  ok("[1] content hit — preview exists", typeof p.preview === "string", JSON.stringify(p));
  if (typeof p.preview === "string") {
    const marked = p.preview.slice(p.previewMarkStart, p.previewMarkEnd);
    ok("[1] content hit — window slice marks the query", marked.toLowerCase() === "october", marked);
    ok("[1] content hit — window cut honestly (mid-text → ellipses)", p.preview.startsWith("…") && p.preview.endsWith("…"), p.preview);
    ok(
      "[1] content hit — mark offsets sit INSIDE the window",
      p.previewMarkStart >= 1 && p.previewMarkEnd <= p.preview.length - 1,
      JSON.stringify({ s: p.previewMarkStart, e: p.previewMarkEnd, len: p.preview.length }),
    );
    ok(
      "[1] content hit — FIRST occurrence of TWO wins (context is the first match's)",
      p.preview.includes("revenue in October") &&
        p.preview.slice(p.previewMarkStart, p.previewMarkEnd).toLowerCase() === "october",
      p.preview,
    );
  }
}

// Window-edge honesty: no ellipsis where nothing was cut.
{
  const p1 = sessionMatchParts(mk("t", ["revenue is fine today"]), "revenue");
  ok("[1] window edge — match at text start has NO leading ellipsis", typeof p1.preview === "string" && !p1.preview.startsWith("…"), String(p1.preview));
  const p2 = sessionMatchParts(mk("t", ["tell me about the revenue"]), "revenue");
  ok("[1] window edge — match at text end has NO trailing ellipsis", typeof p2.preview === "string" && !p2.preview.endsWith("…"), String(p2.preview));
}

// BOTH surfaces hit: title mark AND preview, independent.
{
  const p = sessionMatchParts(mk("Revenue question", ["what was my revenue"]), "revenue");
  ok("[1] both-hit — title marked", p.titleMarkStart === 0 && p.titleMarkEnd === 7, JSON.stringify(p));
  ok("[1] both-hit — preview marked too", typeof p.preview === "string" && p.previewMarkStart >= 0, String(p.preview));
}

// Locale laws: EN case-insensitive; FA verbatim (length-preserving offsets).
{
  const pEn = sessionMatchParts(mk("REVENUE report", []), "revenue");
  ok("[1] EN case-insensitive — REVENUE marked", pEn.titleMarkStart === 0 && pEn.titleMarkEnd === 7, JSON.stringify(pEn));
  const pFa = sessionMatchParts(mk("گزارش فروش مهر", ["فروش این ماه چقدر بود؟"]), "فروش");
  ok("[1] FA verbatim — title hit at 6 (after the space)", pFa.titleMarkStart === 6 && pFa.titleMarkEnd === 10, JSON.stringify(pFa));
  ok("[1] FA verbatim — preview mark aligns", typeof pFa.preview === "string" && pFa.preview.slice(pFa.previewMarkStart, pFa.previewMarkEnd) === "فروش", String(pFa.preview));
}

// First message wins; non-string content ignored; first occurrence wins.
{
  const p = sessionMatchParts(mk("t", ["no match here", "second has revenue inside"]), "revenue");
  ok("[1] first MATCHING message wins", typeof p.preview === "string" && p.preview.includes("second"), String(p.preview));
  const pSkip = sessionMatchParts(mk("t", [42 as unknown as string, "real revenue"]), "revenue");
  ok("[1] non-string content skipped, honest", typeof pSkip.preview === "string" && pSkip.preview.includes("real"), String(pSkip.preview));
}

// Blank / malformed → the honest blank (no fabricated highlights).
{
  const blank = sessionMatchParts(mk("Revenue", ["revenue"]), "   ");
  ok("[1] blank query — all blank", blank.titleMarkStart === -1 && blank.titleMarkEnd === -1 && blank.preview === null && blank.previewMarkStart === -1 && blank.previewMarkEnd === -1);
  const n1 = sessionMatchParts(null, "revenue");
  ok("[1] null session — never crashes, all blank", n1.titleMarkStart === -1 && n1.preview === null);
  const n2 = sessionMatchParts({ title: 5, messages: "nope" } as unknown as Parameters<typeof sessionMatchParts>[0], "revenue");
  ok("[1] malformed session — never crashes, all blank", n2.titleMarkStart === -1 && n2.preview === null);
  const n3 = sessionMatchParts(mk("Revenue", [null as unknown as string]), "revenue");
  ok("[1] malformed message content — title still honest", n3.titleMarkStart === 0 && n3.preview === null);
}

// Filter witness law: the highlighter CANNOT highlight what the filter
// would not match (same trim + toLocaleLowerCase mirror).
{
  const s = mk("Financial chat", ["nothing about the topic"]);
  const matches = sessionMatchesQuery(s, "revenue");
  const p = sessionMatchParts(s, "revenue");
  ok("[1] witness law — filter false ⇒ no title mark, no preview", !matches && p.titleMarkStart === -1 && p.preview === null);
}

// ---- [2] source laws (copilot-view) -----------------------------------------

ok("[2] view imports sessionMatchParts + type", view.includes("sessionMatchParts,") && view.includes("type SessionMatchParts,"));
ok(
  "[2] match computed per row, gated on queryActive",
  /const match: SessionMatchParts \| null = queryActive\s*\n\s*\? sessionMatchParts\(s, sessionQuery\)/.test(view),
);
const markCls = "rounded-[3px] bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25 dark:text-amber-50";
ok("[2] ONE shared amber mark class on BOTH sites", count(view, markCls) === 2, String(count(view, markCls)));
ok("[2] title <mark> slices titleMarkStart/End", view.includes("s.title.slice(match.titleMarkStart, match.titleMarkEnd)"));
ok(
  "[2] preview line: testid + amber edge + dir=auto + truncate",
  view.includes('data-testid="copilot-session-match-preview"') &&
    /border-s-2 border-amber-400\/50/.test(view) &&
    /dir="auto"\s*\n\s*data-testid="copilot-session-match-preview"/.test(view),
);
ok(
  "[2] Escape progressive-dismissal law — onEscapeKeyDown + defaultPrevented (Radix document-capture law)",
  /onEscapeKeyDown=\{\(event\) => \{/.test(view) &&
    /if \(queryActive\) \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*setSessionQuery\(""\);/.test(view) &&
    !view.includes('if (e.key === "Escape" && queryActive)'),
);
ok("[2] preview renders BEFORE the meta line (witness above the count)", view.indexOf("copilot-session-match-preview") < view.indexOf('t("messagesCount", { count: s.messages.length })', view.indexOf("copilot-session-match-preview")));

// ---- [3] regression pins (the R138 search block survives) -------------------

ok("[3] search input testid + aria survive", view.includes('data-testid="copilot-session-search"') && view.includes('aria-label={t("searchSessions")}'));
ok("[3] clear affordance survives", view.includes('aria-label={t("clearSearch")}'));
ok("[3] no-results honest state survives", view.includes('data-testid="copilot-session-search-empty"') && view.includes('t("searchNoResults", { query: sessionQuery.trim() })'));
ok("[3] shown/total count survives", /aria-live="polite"/.test(view) && view.includes("{filteredSessions.length}/{savedSessions.length}"));
ok("[3] reset-on-close survives", /onOpenChange=\{\(open\) => \{\s*\n\s*if \(!open\) setSessionQuery\(""\);/.test(view));
ok("[3] sessionMatchesQuery untouched (verbatim mirror)", lib.includes("export function sessionMatchesQuery(") && lib.includes('const q = (typeof query === "string" ? query : "").trim().toLocaleLowerCase();'));

console.log(`\n== r141: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
