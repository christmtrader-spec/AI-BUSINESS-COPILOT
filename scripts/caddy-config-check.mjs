#!/usr/bin/env node
/**
 * caddy-config-check.mjs — Prompt 29 §95/§96/§149.
 *
 * Validates the Caddy reverse-proxy contract that the application's IP
 * parsing and HTTPS assumptions depend on:
 *
 *  - X-Forwarded-For  MUST be overwritten from {remote_host} (the socket
 *    peer) — a client-supplied XFF must NEVER survive, otherwise rate
 *    limiting by IP can be spoofed (§95/§96).
 *  - X-Forwarded-Proto MUST be overwritten from {scheme}.
 *  - X-Real-IP        MUST be overwritten from {remote_host}.
 *  - The proxy targets the app on localhost (no wildcard upstreams).
 *
 * This is a static contract check of the repo's Caddyfile — deployment
 * Caddyfiles MUST match this contract (documented in production-operations.md).
 *
 * Exit codes: 0 = contract holds · 1 = UNSAFE PROXY CONFIGURATION.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const caddyPath = process.argv[2] ?? join(ROOT, "Caddyfile");

if (!existsSync(caddyPath)) {
  console.error(`✖ caddy-config-check: Caddyfile not found at ${caddyPath}`);
  process.exit(1);
}

const text = readFileSync(caddyPath, "utf8");
console.log(`caddy-config-check — ${caddyPath} (${text.split("\n").length} lines)`);

let failures = [];

/* ---------------------- X-Forwarded-For overwrite (§96) -------------------- */
// Every reverse_proxy block must overwrite XFF from the socket peer.
const proxyBlocks = text.split(/reverse_proxy\s+/).slice(1);
if (proxyBlocks.length === 0) {
  failures.push("NO_REVERSE_PROXY_BLOCKS");
} else {
  for (const [i, block] of proxyBlocks.entries()) {
    // The block extends to the next closing brace at same level — take a
    // conservative window (until the next "reverse_proxy" or EOF).
    const window = block.split(/reverse_proxy\s/)[0];
    const hasXffOverwrite = /header_up\s+X-Forwarded-For\s+\{remote_host\}/.test(window);
    const hasXfpOverwrite = /header_up\s+X-Forwarded-Proto\s+\{scheme\}/.test(window);
    const hasXriOverwrite = /header_up\s+X-Real-IP\s+\{remote_host\}/.test(window);
    const hasLocalhostTarget = /localhost:(\d+|\{[^}]*\})|127\.0\.0\.1:(\d+|\{[^}]*\})/.test(window);
    if (!hasXffOverwrite) failures.push(`BLOCK_${i + 1}: X-Forwarded-For NOT overwritten from remote_host (client XFF spoofing possible)`);
    if (!hasXfpOverwrite) failures.push(`BLOCK_${i + 1}: X-Forwarded-Proto NOT overwritten (scheme spoofing possible)`);
    if (!hasXriOverwrite) failures.push(`BLOCK_${i + 1}: X-Real-IP NOT overwritten from remote_host`);
    if (!hasLocalhostTarget) failures.push(`BLOCK_${i + 1}: upstream is not localhost-bound (unexpected topology)`);
  }
}

/* ------------------- no trust of arbitrary client headers ------------------ */
// The file must not contain header_up directives that COPY client XFF through.
if (/\{\header\.X-Forwarded-For\}|\{http\.request\.header\.X-Forwarded-For\}/i.test(text)) {
  failures.push("CLIENT_XFF_PASSTHROUGH detected — a client-supplied X-Forwarded-For is being forwarded (rate-limit IP spoofing, §95)");
}

console.log("");
for (const [i, line] of text.split("\n").entries()) {
  if (/header_up\s+(X-Forwarded-For|X-Forwarded-Proto|X-Real-IP)/.test(line)) {
    console.log(`  L${i + 1}: ${line.trim()}`);
  }
}

console.log("");
if (failures.length > 0) {
  console.error("✖ CADDY CONTRACT: UNSAFE — fix before production:");
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✔ CADDY CONTRACT: X-Forwarded-For/X-Forwarded-Proto/X-Real-IP are overwritten from the socket peer; upstreams are localhost-bound. Real client IP cannot be spoofed through this proxy (§149).");
process.exit(0);
