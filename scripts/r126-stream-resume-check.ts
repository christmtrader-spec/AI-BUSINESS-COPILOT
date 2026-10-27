/**
 * R126 — battery for the stream-resume registry (PURE, bun, no DOM).
 *
 * Pins the laws the copilot transport now depends on:
 *   A. register/keep-original/eviction — bounded memory, no forked buffers
 *   B. appendDelta + per-entry char cap + overflow flag
 *   C. finish/fail lifecycle (fail never overrides done; append after end refused)
 *   D. markUserStopped — authz inside the pure core (owner mismatch refused),
 *      idempotence, refused once finished
 *   E. snapshot — fromIndex slicing/clamping, authz (foreign business/user →
 *      null), fresh arrays (caller mutation cannot corrupt the buffer)
 *   F. TTL — live entries expire after ttlMs, finished ones after finishedTtlMs
 *   G. purity — injected clock only, deterministic, inputs unmutated
 */
import {
  createStreamResumeRegistry,
  type StreamResumeRegistry,
} from "../src/lib/ai/stream-resume";

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

const OWNER_A = { businessId: "biz-a", userId: "user-1" };
const OWNER_B = { businessId: "biz-b", userId: "user-2" };

function makeRegistry(
  nowMs: { t: number },
  overrides: Partial<Parameters<typeof createStreamResumeRegistry>[0]> = {},
) {
  return createStreamResumeRegistry({ now: () => nowMs.t, ...overrides });
}

// ---------------------------------------------------------------------------
// A. register / keep-original / eviction
// ---------------------------------------------------------------------------
{
  const clock = { t: 1_000 };
  const reg = makeRegistry(clock, { maxEntries: 3 });
  check("A1 register returns true for a fresh id", reg.register("r1", OWNER_A));
  check("A2 keep-original: re-register of a live id is refused", !reg.register("r1", OWNER_A));
  check("A3 keep-original holds even across owners (same transport key)", !reg.register("r1", OWNER_B));
  check("A4 size reflects one entry", reg.size() === 1);

  reg.register("r2", OWNER_A);
  reg.register("r3", OWNER_A);
  check("A5 registry holds up to maxEntries", reg.size() === 3);
  reg.register("r4", OWNER_A);
  check("A6 eviction keeps the newest maxEntries", reg.size() === 3);
  const snap = reg.snapshot("r4", 0, OWNER_A);
  check("A7 newest entry survives eviction", snap !== null && snap.deltas.length === 0);
  const evicted = reg.snapshot("r1", 0, OWNER_A);
  check("A8 oldest entry was evicted", evicted === null);

  // entries with different owners never collide or leak into each other
  reg2: {
    const reg2 = makeRegistry(clock);
    reg2.register("shared", OWNER_A);
    reg2.appendDelta("shared", "alpha");
    check("A9 owner B cannot read owner A's buffer", reg2.snapshot("shared", 0, OWNER_B) === null);
    break reg2;
  }
}

// ---------------------------------------------------------------------------
// B. appendDelta + char cap + overflow
// ---------------------------------------------------------------------------
{
  const clock = { t: 1_000 };
  const reg = makeRegistry(clock, { maxCharsPerEntry: 10 });
  reg.register("cap", OWNER_A);
  check("B1 append to a live entry", reg.appendDelta("cap", "12345"));
  check("B2 append within cap", reg.appendDelta("cap", "6789"));
  check("B3 append landing exactly at the cap is allowed", reg.appendDelta("cap", "0"));
  check("B4 append past the cap is refused + overflow flagged", !reg.appendDelta("cap", "x"));
  const snap = reg.snapshot("cap", 0, OWNER_A);
  check("B5 overflow visible in the snapshot", snap?.overflow === true);
  check("B6 buffered deltas intact through the cap boundary", snap?.deltas.join("") === "1234567890");
  check("B7 nextIndex = total buffered", snap?.nextIndex === 3);
  check("B8 append refused once overflow (cap is hard)", !reg.appendDelta("cap", "y"));
  const snap2 = reg.snapshot("cap", 3, OWNER_A);
  check("B9 overflow entry replays nothing new but stays readable", snap2?.deltas.length === 0 && snap2?.nextIndex === 3);
}

// ---------------------------------------------------------------------------
// C. finish / fail lifecycle
// ---------------------------------------------------------------------------
{
  const clock = { t: 1_000 };
  const reg = makeRegistry(clock);
  reg.register("done1", OWNER_A);
  reg.appendDelta("done1", "a");
  reg.finish("done1");
  check("C1 append refused after done", !reg.appendDelta("done1", "b"));
  const doneSnap = reg.snapshot("done1", 0, OWNER_A);
  check("C2 done visible, error null, stopped false", doneSnap?.done === true && doneSnap?.error === null && doneSnap?.stopped === false);

  reg.register("err1", OWNER_A);
  reg.fail("err1", { code: "AI_UNAVAILABLE", message: "down" });
  check("C3 append refused after error", !reg.appendDelta("err1", "a"));
  check("C4 fail never overrides done", (() => {
    reg.register("done2", OWNER_A);
    reg.finish("done2");
    reg.fail("done2", { code: "X" });
    const s = reg.snapshot("done2", 0, OWNER_A);
    return s?.done === true && s?.error === null;
  })());
  check("C5 finish/fail on unknown ids are no-ops", (() => {
    reg.finish("ghost");
    reg.fail("ghost", { code: "X" });
    return reg.snapshot("ghost", 0, OWNER_A) === null;
  })());
  // the error object is copied — caller mutation cannot poison the buffer
  check("C6 snapshot error is a fresh copy", (() => {
    const err = { code: "E" };
    reg.register("err2", OWNER_A);
    reg.fail("err2", err);
    err.code = "MUTATED";
    const s = reg.snapshot("err2", 0, OWNER_A);
    return s?.error?.code === "E";
  })());
}

// ---------------------------------------------------------------------------
// D. markUserStopped
// ---------------------------------------------------------------------------
{
  const clock = { t: 1_000 };
  const reg = makeRegistry(clock);
  reg.register("s1", OWNER_A);
  check("D1 owner stops their own stream", reg.markUserStopped("s1", OWNER_A));
  check("D2 stop is idempotent (still owned, live)", reg.markUserStopped("s1", OWNER_A));
  const snap = reg.snapshot("s1", 0, OWNER_A);
  check("D3 stopped visible in snapshot", snap?.stopped === true);
  check("D4 foreign owner cannot stop or read", (() => {
    reg.register("x1", OWNER_A);
    return reg.markUserStopped("x1", OWNER_B) === false && reg.snapshot("x1", 0, OWNER_B) === null;
  })());
  check("D5 stop refused after done", (() => {
    reg.register("s2", OWNER_A);
    reg.finish("s2");
    return reg.markUserStopped("s2", OWNER_A) === false;
  })());
  check("D6 stop refused for unknown id", !reg.markUserStopped("ghost", OWNER_A));
  check("D7 append refused after stop (buffer frozen)", (() => {
    reg.register("s3", OWNER_A);
    reg.markUserStopped("s3", OWNER_A);
    return reg.appendDelta("s3", "late") === false;
  })());
}

// ---------------------------------------------------------------------------
// E. snapshot slicing / clamping / authz / freshness
// ---------------------------------------------------------------------------
{
  const clock = { t: 1_000 };
  const reg = makeRegistry(clock);
  reg.register("e1", OWNER_A);
  for (const d of ["one", "two", "three"]) reg.appendDelta("e1", d);

  const full = reg.snapshot("e1", 0, OWNER_A);
  check("E1 fromIndex 0 replays everything", full?.deltas.join(",") === "one,two,three" && full?.nextIndex === 3);
  const tail = reg.snapshot("e1", 1, OWNER_A);
  check("E2 fromIndex 1 replays the tail only", tail?.deltas.join(",") === "two,three");
  const caughtUp = reg.snapshot("e1", 3, OWNER_A);
  check("E3 fromIndex at the end replays nothing", caughtUp?.deltas.length === 0 && caughtUp?.nextIndex === 3);
  const beyond = reg.snapshot("e1", 99, OWNER_A);
  check("E4 fromIndex clamps to the buffer length", beyond?.deltas.length === 0 && beyond?.nextIndex === 3);
  const negative = reg.snapshot("e1", -5, OWNER_A);
  check("E5 negative fromIndex clamps to 0", negative?.deltas.length === 3);
  const fractional = reg.snapshot("e1", 1.9, OWNER_A);
  check("E6 fractional fromIndex floors", fractional?.deltas.join(",") === "two,three");

  check("E7 wrong business refused", reg.snapshot("e1", 0, OWNER_B) === null);
  check("E8 wrong user refused", reg.snapshot("e1", 0, { businessId: "biz-a", userId: "user-2" }) === null);
  check("E9 unknown id refused", reg.snapshot("ghost", 0, OWNER_A) === null);

  check("E10 deltas array is fresh (caller mutation cannot corrupt)", (() => {
    const s = reg.snapshot("e1", 0, OWNER_A);
    if (!s) return false;
    s.deltas.push("INJECTED");
    s.deltas.length = 0;
    const again = reg.snapshot("e1", 0, OWNER_A);
    return again?.deltas.join(",") === "one,two,three";
  })());
}

// ---------------------------------------------------------------------------
// F. TTL — live vs finished expiry
// ---------------------------------------------------------------------------
{
  const clock = { t: 10_000 };
  const reg = makeRegistry(clock, { ttlMs: 120_000, finishedTtlMs: 30_000 });
  reg.register("live", OWNER_A);
  reg.register("dead", OWNER_A);
  reg.finish("dead");

  clock.t = 10_000 + 45_000;
  check("F1 finished entry expires after finishedTtlMs", reg.snapshot("dead", 0, OWNER_A) === null);
  check("F2 live entry survives 45s", reg.snapshot("live", 0, OWNER_A) !== null);

  clock.t = 10_000 + 121_000;
  check("F3 live entry expires after ttlMs", reg.snapshot("live", 0, OWNER_A) === null);
  check("F4 sweep keeps size honest", reg.size() === 0);

  // a mid-answer error also finishes the entry (short TTL)
  clock.t = 200_000;
  reg.register("erred", OWNER_A);
  reg.appendDelta("erred", "partial");
  reg.fail("erred", { code: "INTERNAL_ERROR" });
  clock.t = 200_000 + 31_000;
  check("F5 errored entry expires on the finished clock", reg.snapshot("erred", 0, OWNER_A) === null);

  // an entry whose buffer grew is still capped by ttl (updatedAt does not extend life)
  clock.t = 300_000;
  const reg2 = makeRegistry(clock, { ttlMs: 1_000 });
  reg2.register("steady", OWNER_A);
  for (let i = 0; i < 5; i += 1) {
    clock.t += 100;
    reg2.appendDelta("steady", "x");
  }
  clock.t += 1_500;
  check("F6 activity does not extend the hard TTL", reg2.snapshot("steady", 0, OWNER_A) === null);
}

// ---------------------------------------------------------------------------
// G. purity — injected clock, deterministic, inputs unmutated
// ---------------------------------------------------------------------------
{
  const owner = { businessId: "biz-a", userId: "user-1" };
  const ownerCopy = { ...owner };
  const clock = { t: 5_000 };
  const reg: StreamResumeRegistry = makeRegistry(clock);
  reg.register("g1", ownerCopy);
  ownerCopy.businessId = "TAMPERED";
  check("G1 registry does not retain caller object references", reg.snapshot("g1", 0, { businessId: "biz-a", userId: "user-1" }) !== null);

  const out1 = JSON.stringify(reg.snapshot("g1", 0, owner));
  const out2 = JSON.stringify(reg.snapshot("g1", 0, owner));
  check("G2 deterministic under a frozen clock", out1 === out2);

  clock.t += 1;
  const out3 = JSON.stringify(reg.snapshot("g1", 0, owner));
  check("G3 clock is the only time source (no Date.now leakage)", out1 === out3);

  check("G4 empty registry is empty", makeRegistry(clock).size() === 0);
}

// ---------------------------------------------------------------------------

console.log(`\nr126-stream-resume-check: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:", failures);
  process.exit(1);
}
