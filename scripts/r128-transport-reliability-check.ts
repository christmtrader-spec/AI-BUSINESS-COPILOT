/**
 * R128 — battery for the device-local transport-reliability fact (PURE,
 * bun, no DOM).
 *
 * Pins the laws the insights panel's quiet line depends on:
 *   A. empties — no sessions / no messages → {0,0} (the panel stays silent)
 *   B. denominator — assistant + not-failed + non-empty content counts;
 *      user messages, failed answers and empty/whitespace-less answers
 *      (empty string) never count
 *   C. numerator — only the R127 `healed` marker counts; a server-restored
 *      answer (no marker) inflates the denominator only
 *   D. stop-partials — a user-stopped partial (content kept, no healed)
 *      counts as answered, never as healed
 *   E. aggregation — facts accumulate across sessions; bounded shapes
 *      (MAX_SESSIONS × MAX_MESSAGES_PER_SESSION) scan cleanly
 *   F. defensive shape tolerance — null entries / missing messages arrays /
 *      malformed messages never crash (the sanitizer guarantees shape, the
 *      core must not assume it)
 *   G. purity — inputs unmutated (deep-frozen input works), fresh result
 *      object every call, deterministic under repetition
 */
import {
  transportReliability,
  type CopilotSession,
} from "../src/lib/copilot-sessions";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`FAIL: ${name}`);
  }
}

function session(
  id: string,
  messages: Partial<CopilotSession["messages"][number]>[],
): CopilotSession {
  return {
    id,
    title: "",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: messages as CopilotSession["messages"],
  };
}

// ---- A. empties ------------------------------------------------------------

check("A1 empty array → answered 0", transportReliability([]).answered === 0);
check("A2 empty array → healed 0", transportReliability([]).healed === 0);
check(
  "A3 session with zero messages → silent",
  (() => {
    const r = transportReliability([session("s1", [])]);
    return r.answered === 0 && r.healed === 0;
  })(),
);

// ---- B. denominator law ----------------------------------------------------

const B = transportReliability([
  session("s1", [
    { id: "m1", role: "user", content: "Who owes me money?" },
    { id: "m2", role: "assistant", content: "Two customers owe you." },
  ]),
]);
check("B1 healthy answer counts in denominator", B.answered === 1);
check("B2 healthy answer without marker → healed 0", B.healed === 0);

const Bfail = transportReliability([
  session("s1", [
    { id: "m1", role: "assistant", content: "", failed: true },
    { id: "m2", role: "assistant", content: "boom", failed: true },
  ]),
]);
check("B3 failed answers sit outside the fraction", Bfail.answered === 0);
check("B4 failed answers never count as healed", Bfail.healed === 0);

const Buser = transportReliability([
  session("s1", [
    { id: "m1", role: "user", content: "hello" },
    { id: "m2", role: "user", content: "anyone there" },
  ]),
]);
check("B5 user messages never count", Buser.answered === 0);

const Bempty = transportReliability([
  session("s1", [{ id: "m1", role: "assistant", content: "" }]),
]);
check("B6 empty-content assistant answer never counts", Bempty.answered === 0);

// ---- C. numerator law ------------------------------------------------------

const C = transportReliability([
  session("s1", [
    { id: "m1", role: "assistant", content: "streamed live, complete" },
  ]),
  session("s2", [
    { id: "m2", role: "assistant", content: "cut at chunk 3, healed", healed: true },
  ]),
]);
check("C1 healed counts in both fraction parts", C.answered === 2 && C.healed === 1);

const Cserver = transportReliability([
  session("s1", [
    // Restored from the server transcript — same shape, never a marker.
    { id: "m1", role: "assistant", content: "asked on another device" },
    { id: "m2", role: "assistant", content: "also restored", meta: { days: 30 } },
  ]),
]);
check(
  "C2 server-restored answers inflate the denominator only",
  Cserver.answered === 2 && Cserver.healed === 0,
);

// ---- D. stop-partials ------------------------------------------------------

const D = transportReliability([
  session("s1", [
    { id: "m1", role: "assistant", content: "user stopped me here" },
    { id: "m2", role: "assistant", content: "healed resume", healed: true },
  ]),
]);
check("D1 user-stopped partial counts as answered", D.answered === 2);
check("D2 user-stopped partial never counts as healed", D.healed === 1);

// ---- E. aggregation + bounded shapes ---------------------------------------

const many: CopilotSession[] = [];
for (let s = 0; s < 20; s += 1) {
  const messages: CopilotSession["messages"] = [];
  for (let m = 0; m < 200; m += 1) {
    messages.push({
      id: `s${s}-m${m}`,
      role: m % 2 === 0 ? "user" : "assistant",
      content: m % 2 === 0 ? "question" : `answer ${m}`,
      ...(s < 3 && m === 5 ? { healed: true } : {}),
    });
  }
  many.push(session(`bulk-${s}`, messages));
}
const E = transportReliability(many);
check("E1 bounded scan (20×200) counts every healthy answer", E.answered === 20 * 100);
check("E2 healed marker found in every session that carries it", E.healed === 3);

// ---- F. defensive shape tolerance ------------------------------------------

type Loose = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown;
};
const F = transportReliability([
  null as unknown as CopilotSession,
  { ...session("s1", [{ id: "m1", role: "assistant", content: "ok" }]), messages: undefined } as unknown as CopilotSession,
  session("s2", [
    null as unknown as CopilotSession["messages"][number],
    { role: "assistant" } as CopilotSession["messages"][number],
    { id: "m2", role: "assistant", content: "fine" } as CopilotSession["messages"][number],
  ]),
] as unknown as Loose[] as CopilotSession[]);
check("F1 malformed entries never crash", F.answered === 1);
check("F2 malformed entries never invent healed", F.healed === 0);

// ---- G. purity -------------------------------------------------------------

const gSession = session("g1", [
  { id: "m1", role: "user", content: "q" },
  { id: "m2", role: "assistant", content: "a", healed: true },
]);
const frozen = Object.freeze([Object.freeze({ ...gSession, messages: Object.freeze(gSession.messages.map((m) => Object.freeze({ ...m }))) })]) as unknown as CopilotSession[];
const g1 = transportReliability(frozen);
check("G1 frozen input accepted (no mutation needed)", g1.answered === 1 && g1.healed === 1);
const g2 = transportReliability(frozen);
check("G2 deterministic under repetition", g1.answered === g2.answered && g1.healed === g2.healed);
check(
  "G3 fresh result object every call",
  transportReliability(frozen) !== transportReliability(frozen),
);
const before = JSON.stringify(frozen[0]);
transportReliability(frozen);
check("G4 input JSON unchanged after the call", JSON.stringify(frozen[0]) === before);

// ---- summary ---------------------------------------------------------------

console.log(`\nr128-transport-reliability-check: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:", failures.join(" · "));
  process.exit(1);
}
