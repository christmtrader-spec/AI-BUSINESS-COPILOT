import "server-only";

/**
 * Portability file storage — Prompt 31 §11/§18/§19/§147/§303/§313/§314/§315.
 *
 * LAWS:
 *  - Files live under the non-public portability root (§11/§18): never
 *    under public/, .next/ or any web-served directory (§304 — the root is
 *    validated at every use).
 *  - EVERY file path is server-generated: `<root>/exports|imports/<jobId>.<ext>`
 *    where jobId is a Prisma cuid. User-supplied file NAMES are display
 *    metadata only and are never used to construct a path (§147).
 *  - Symlink refusal (§313): artifacts whose lstat reports a symlink are
 *    rejected — a planted symlink can never redirect reads/writes.
 *  - Checksums are SHA-256 over the exact file bytes (§21/§311/§312).
 *  - Single-node local filesystem storage (§20/§389): application-level
 *    encryption is NOT implemented; if infrastructure encrypts the volume,
 *    that is an operator concern, documented — never claimed here.
 */

import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { dataPortabilityRoot, validateStorageRoot } from "./config";

export class PortabilityStorageError extends Error {
  constructor(
    public code:
      | "STORAGE_INVALID"
      | "STORAGE_UNWRITABLE"
      | "FILE_NOT_FOUND"
      | "FILE_SYMLINK"
      | "FILE_CHECKSUM_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

export type PortabilityKind = "exports" | "imports";

function resolveRoot(): string {
  const root = dataPortabilityRoot();
  const invalid = validateStorageRoot(root);
  if (invalid) {
    throw new PortabilityStorageError("STORAGE_INVALID", "Portability storage root is not allowed.");
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Absolute path for a server-generated artifact key. */
function pathFor(kind: PortabilityKind, storageKey: string): string {
  const root = resolveRoot();
  const full = resolve(join(root, kind, storageKey));
  // Containment check — defense in depth on top of server-generated keys.
  const expectedDir = resolve(join(root, kind));
  if (!full.startsWith(expectedDir + sep)) {
    throw new PortabilityStorageError("STORAGE_INVALID", "Path traversal rejected.");
  }
  return full;
}

/** Build the server-owned storage key for a job (never user input). */
export function buildStorageKey(kind: PortabilityKind, jobId: string, extension: string): string {
  const safeId = /^[a-z0-9]{20,40}$/i.test(jobId) ? jobId : randomUUID().replace(/-/g, "");
  const safeExt = extension === "" ? "bin" : extension.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  return `${safeId}.${safeExt}`;
}

/** Write a complete artifact from an in-memory buffer (bounded by limits). */
export async function writeArtifact(
  kind: PortabilityKind,
  storageKey: string,
  data: Uint8Array,
): Promise<{ absolutePath: string; size: number; checksum: string }> {
  const target = pathFor(kind, storageKey);
  fs.mkdirSync(dirname(target), { recursive: true });
  // Refuse to follow a symlink planted at the target path (§313).
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new PortabilityStorageError("FILE_SYMLINK", "Artifact path is a symlink.");
    }
  } catch (error) {
    if (error instanceof PortabilityStorageError) throw error;
    /* not found — fresh file, fine */
  }
  const tmp = `${target}.tmp-${randomUUID()}`;
  await pipeline(
    (function* () {
      yield data;
    })(),
    createWriteStream(tmp, { mode: 0o600 }),
  );
  // Refuse a symlink planted between lstat and rename.
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(tmp);
      throw new PortabilityStorageError("FILE_SYMLINK", "Artifact path is a symlink.");
    }
  } catch (error) {
    if (error instanceof PortabilityStorageError) throw error;
    /* target still absent */
  }
  fs.renameSync(tmp, target);
  const checksum = await sha256File(target);
  return { absolutePath: target, size: data.byteLength, checksum };
}

/** SHA-256 hex over a file, streamed (bounded memory, §23). */
export async function sha256File(absolutePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export type ArtifactInfo = {
  absolutePath: string;
  size: number;
  checksum: string;
};

/**
 * Verify a stored artifact exists, is a regular (non-symlink) file and its
 * SHA-256 matches the recorded checksum (§30/§312/§372). Throws safe codes.
 */
export async function verifyArtifact(
  kind: PortabilityKind,
  storageKey: string,
  expectedChecksum: string,
): Promise<ArtifactInfo> {
  const target = pathFor(kind, storageKey);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    throw new PortabilityStorageError("FILE_NOT_FOUND", "Export file is not available.");
  }
  if (st.isSymbolicLink()) {
    throw new PortabilityStorageError("FILE_SYMLINK", "Export file is not available.");
  }
  if (!st.isFile()) {
    throw new PortabilityStorageError("FILE_NOT_FOUND", "Export file is not available.");
  }
  const checksum = await sha256File(target);
  if (checksum !== expectedChecksum.toLowerCase()) {
    throw new PortabilityStorageError("FILE_CHECKSUM_MISMATCH", "Export file failed integrity verification.");
  }
  return { absolutePath: target, size: st.size, checksum };
}

/** Read a staged upload file (import flow), verifying its checksum (§311). */
export function readStagedUpload(
  storageKey: string,
  expectedChecksum: string | null,
): { buffer: Buffer; size: number } {
  const target = pathFor("imports", storageKey);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    throw new PortabilityStorageError("FILE_NOT_FOUND", "Import file is no longer available.");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new PortabilityStorageError("FILE_NOT_FOUND", "Import file is no longer available.");
  }
  const buffer = fs.readFileSync(target);
  if (expectedChecksum) {
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (checksum !== expectedChecksum.toLowerCase()) {
      throw new PortabilityStorageError("FILE_CHECKSUM_MISMATCH", "Import file failed integrity verification.");
    }
  }
  return { buffer, size: buffer.byteLength };
}

/** Delete an artifact if present. Never throws — cleanup is best-effort. */
export function deleteArtifact(kind: PortabilityKind, storageKey: string | null): void {
  if (!storageKey) return;
  try {
    const target = pathFor(kind, storageKey);
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return; // never follow planted links during cleanup
    fs.unlinkSync(target);
  } catch {
    /* already gone */
  }
}

/**
 * List artifact keys currently on disk for a kind (cleanup support).
 * Returns server-generated keys only (basename; no traversal possible).
 */
export function listArtifactKeys(kind: PortabilityKind): string[] {
  try {
    const dir = resolve(join(resolveRoot(), kind));
    return fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith("."))
      .map((f) => basename(f));
  } catch {
    return [];
  }
}

/** Open a Web ReadableStream over a stored artifact for HTTP download. */
export function artifactWebStream(absolutePath: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(absolutePath);
  // ReadableStreamAdapter via Readable.toWeb (Node 18+ / Bun compatible).
  return nodeStreamToWeb(nodeStream);
}

function nodeStreamToWeb(stream: import("node:stream").Readable): ReadableStream<Uint8Array> {
  // Minimal, dependency-free adapter — push chunks into a Web stream.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        controller.enqueue(bytes);
      });
      stream.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      stream.on("error", (error) => {
        try {
          controller.error(error);
        } catch {
          /* already errored */
        }
      });
    },
    cancel() {
      stream.destroy();
    },
  });
}

/**
 * Securely join a storage-key-ish name for prune tooling — used by the
 * prune scripts via listArtifactKeys, never with raw user input.
 */
export function isSafeArtifactKey(key: string): boolean {
  if (key.includes("/") || key.includes("\\") || key.includes("\0")) return false;
  if (isAbsolute(key)) return false;
  if (key.startsWith(".")) return false;
  return /^[\w.-]+$/.test(key) && key.length <= 120;
}
