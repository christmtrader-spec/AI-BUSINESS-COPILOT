/**
 * i18n completeness audit: scans all src/modules tsx files for useTranslations("ns")
 * bindings and t("key") usages, then verifies each ns.key exists in en + fa messages.
 * Also detects keys present in en but missing in fa (and vice versa) per namespace.
 * Run: bun scripts/i18n-audit.mts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Msgs = Record<string, unknown>;

const en = (await import("../src/i18n/messages/en")).default as Msgs;
const fa = (await import("../src/i18n/messages/fa")).default as Msgs;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(f)) out.push(p);
  }
  return out;
}

const files = walk("src/modules").concat(walk("src/components/shared"));
const used = new Map<string, Set<string>>(); // ns -> keys

for (const file of files) {
  const src = readFileSync(file, "utf8");
  // find bindings: const tX = useTranslations("ns")
  const bindRe = /const\s+(\w+)\s*=\s*useTranslations\("([\w.]+)"\)/g;
  const bindings: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = bindRe.exec(src))) bindings.push([m[1], m[2]]);
  if (!bindings.length) continue;
  // find usages: name("key") — single-line simple keys only
  for (const [name, ns] of bindings) {
    const useRe = new RegExp(`\\b${name}\\("([\\w.]+)"`, "g");
    let u: RegExpExecArray | null;
    while ((u = useRe.exec(src))) {
      const full = `${ns}.${u[1]}`;
      if (!used.has(full)) used.set(full, new Set());
      used.get(full)!.add(file.replace("src/", ""));
    }
  }
}

let missing = 0;
for (const [key, filesSet] of [...used.entries()].sort()) {
  const parts = key.split(".");
  const ns = parts[0];
  const rest = parts.slice(1);
  const get = (bag: Msgs): unknown =>
    rest.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Msgs)[k] : undefined), bag[ns]);
  const enVal = get(en);
  const faVal = get(fa);
  if (enVal === undefined || faVal === undefined) {
    missing++;
    console.log(
      `MISSING ${key}  [en:${enVal === undefined ? "x" : "ok"} fa:${faVal === undefined ? "x" : "ok"}]  used in ${[...filesSet].join(", ")}`,
    );
  }
}

// parity check: keys in en ns but not in fa ns (top 2 levels)
let parity = 0;
for (const ns of Object.keys(en)) {
  const enNs = en[ns] as Msgs;
  const faNs = (fa[ns] ?? {}) as Msgs;
  const flat = (o: unknown, pre = ""): string[] =>
    o && typeof o === "object"
      ? Object.entries(o as Msgs).flatMap(([k, v]) => flat(v, pre ? `${pre}.${k}` : k))
      : [pre];
  const enKeys = new Set(flat(enNs));
  const faKeys = new Set(flat(faNs));
  for (const k of enKeys) if (!faKeys.has(k)) { parity++; console.log(`FA-MISSING ${ns}.${k}`); }
  for (const k of faKeys) if (!enKeys.has(k)) { parity++; console.log(`EN-MISSING ${ns}.${k}`); }
}

console.log(`\nScanned ${files.length} files, ${used.size} ns.key usages.`);
console.log(`Missing-at-usage: ${missing}, parity gaps: ${parity}`);
if (missing === 0 && parity === 0) console.log("i18n AUDIT CLEAN ✓");
