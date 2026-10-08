import "server-only";

/**
 * Prompt 42 (§52) — SHARED SQLite write-transaction utility.
 *
 * Extracted verbatim (behaviorally identical) from the Prompt 41
 * purchase-order service so that EVERY multi-write inventory/procurement
 * path shares ONE serialization + retry law (§53/§54). Owning a copy per
 * service would let two write paths interleave on the single SQLite write
 * lock and reintroduce the exact "Transaction already closed" class of
 * generic 500s P41 hardened away.
 *
 * WHY (§52): SQLite is a single-writer database. Prisma interactive
 * transactions issue BEGIN IMMEDIATE, so N concurrent writers contend on
 * the one write lock; losers used to sit until the transaction timeout and
 * die with "Transaction already closed" (a generic 500). Two defenses:
 *
 *  1. In-process FIFO serialization of WRITE transactions — requests still
 *     run concurrently up to the transaction boundary, then take the write
 *     lock one at a time (each transaction is a few ms, so latency stays
 *     bounded; reads are never blocked).
 *  2. A bounded retry for TRANSIENT transaction failures (P2034 write
 *     conflict / P2024 timeout / expired transaction from another process,
 *     e.g. test scripts sharing the dev DB) with deterministic backoff.
 *
 * Domain errors (ApiError and any non-transient error) are NEVER retried —
 * they propagate unchanged (§52 requirements).
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type Tx = Prisma.TransactionClient;

/** FIFO in-process write chain (§52 requirement 1). */
let writeChain: Promise<unknown> = Promise.resolve();

function runSerializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(() => fn());
  // The chain itself must never reject — the NEXT queued write always runs.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** §52 — transient ≠ domain: only lock/timer failures are retryable. */
function isTransientTxError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034" || error.code === "P2024";
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /Transaction already closed|SQLITE_BUSY|database is locked/i.test(error.message);
  }
  return false;
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 } as const;
const MAX_ATTEMPTS = 3;

/**
 * The ONE sanctioned wrapper for multi-statement write transactions on the
 * SQLite single-writer engine. Deterministic bounded backoff (§52):
 * attempt N waits 30·N ms before retrying a TRANSIENT failure only.
 */
export async function withWriteTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  attempts: number = MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runSerializedWrite(() => db.$transaction(fn, TX_OPTIONS));
    } catch (error) {
      lastError = error;
      if (!isTransientTxError(error)) throw error; // ApiError NEVER retried (§52)
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  throw lastError;
}
