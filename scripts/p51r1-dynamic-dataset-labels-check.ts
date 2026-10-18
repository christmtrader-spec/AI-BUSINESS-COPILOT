/**
 * scripts/p51r1-dynamic-dataset-labels-check.ts — P51-R1 durable regression
 * for the DYNAMIC translation-key family of the data-portability export UI.
 *
 * ROOT CAUSE FAMILY (Task 53 + P51-R1): the export panel builds i18n keys
 * at runtime — t(`portability.datasetsLabels.${datasetLabelKey(dataset)}`) —
 * so the static i18n audit CANNOT see them. Task 53 fixed the two CRM keys;
 * P51-R1 found the SAME gap for the 16 procurement/order/quotation/bill/
 * stocktake datasets that the export API has accepted since Prompts 40–48
 * (EXPORT_DATASET_KEYS is the API contract, z.enum(EXPORT_DATASET_KEYS)).
 *
 * This check derives everything from the ACTUAL sources (no hand-maintained
 * list that can go stale):
 *   [1] every key in the backend EXPORT_DATASET_KEYS (parsed from the
 *       export-catalog source — the API's own validation vocabulary) has a
 *       client mapping in DATASET_LABEL_KEYS (no `?? key` fallback leak);
 *   [2] every mapped label key exists in portability.datasetsLabels in
 *       BOTH en.ts and fa.ts (real key-existence, not string matching);
 *   [3] the backend EXPORT_CATALOG.labelKey agrees with the client mapping
 *       (a single mapping law — no drift between server and client);
 *   [4] the panel's selectable EXPORT_DATASETS list is a SUBSET of the
 *       backend vocabulary (the UI can never offer an API-unknown dataset);
 *   [5] locale messages remain plain objects with no missing-value holes.
 *
 * Run: bun scripts/p51r1-dynamic-dataset-labels-check.ts
 */

import { readFileSync } from "node:fs";
import enMessages from "../src/i18n/messages/en";
import faMessages from "../src/i18n/messages/fa";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  passed++;
  if (!cond) {
    failed++;
    failures.push(name);
    console.log(`✗ ${name}${info ? ` — ${info}` : ""}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// --- [source 1] backend vocabulary (the API's own z.enum list) -------------
const catalogSrc = readFileSync(new URL("../src/lib/data-portability/export-catalog.ts", import.meta.url), "utf8");
const backendKeysMatch = catalogSrc.match(/export const EXPORT_DATASET_KEYS = \[([\s\S]*?)\] as const/);
ok("S1. EXPORT_DATASET_KEYS array found in export-catalog.ts", Boolean(backendKeysMatch));
const backendKeys = (backendKeysMatch?.[1] ?? "")
  .split("\n")
  .map((l) => (l.match(/"([a-z_]+)"/) ?? [])[1])
  .filter(Boolean);
ok("S2. backend vocabulary parsed (≥ 30 datasets)", backendKeys.length >= 30, String(backendKeys.length));

// --- [source 2] backend catalog labelKeys ----------------------------------
const catalogLabelKeys: Record<string, string> = {};
for (const m of catalogSrc.matchAll(/\n  ([a-z_]+): \{ key: "\1", sensitivity: "[A-Z_]+", csvFile: "[^"]+", labelKey: "([A-Za-z]+)" \}/g)) {
  catalogLabelKeys[m[1]] = m[2];
}
ok("S3. EXPORT_CATALOG labelKeys parsed", Object.keys(catalogLabelKeys).length >= 30, String(Object.keys(catalogLabelKeys).length));

// --- [source 3] client mapping + selectable list ----------------------------
const panelSrc = readFileSync(new URL("../src/modules/settings/data-portability/export-panel.tsx", import.meta.url), "utf8");
const mappingMatch = panelSrc.match(/const DATASET_LABEL_KEYS: Record<string, string> = \{([\s\S]*?)\};/);
ok("S4. DATASET_LABEL_KEYS found in export-panel.tsx", Boolean(mappingMatch));
const clientMapping: Record<string, string> = {};
for (const m of (mappingMatch?.[1] ?? "").matchAll(/([a-z_]+): "([A-Za-z]+)"/g)) {
  clientMapping[m[1]] = m[2];
}
const selectableMatch = panelSrc.match(/const EXPORT_DATASETS = \[([\s\S]*?)\] as const/);
ok("S5. panel selectable EXPORT_DATASETS found", Boolean(selectableMatch));
const selectableKeys = (selectableMatch?.[1] ?? "")
  .split("\n")
  .map((l) => (l.match(/"([a-z_]+)"/) ?? [])[1])
  .filter(Boolean);

// --- [source 4] real locale objects -----------------------------------------
const enLabels = (enMessages as unknown as { portability: { datasetsLabels: Record<string, string> } }).portability.datasetsLabels;
const faLabels = (faMessages as unknown as { portability: { datasetsLabels: Record<string, string> } }).portability.datasetsLabels;
ok("S6. EN datasetsLabels loaded as a real object", typeof enLabels === "object" && enLabels !== null);
ok("S7. FA datasetsLabels loaded as a real object", typeof faLabels === "object" && faLabels !== null);

// --- [1] mapping completeness (no fallback leak) ----------------------------
console.log("\n== [1] client mapping covers the API vocabulary ==");
const unmapped = backendKeys.filter((k) => !(k in clientMapping));
ok("1a. every EXPORT_DATASET_KEYS entry has a client mapping", unmapped.length === 0, unmapped.join(", "));
const extra = Object.keys(clientMapping).filter((k) => !backendKeys.includes(k));
ok("1b. no stale client mappings (mapping keys ⊆ backend keys)", extra.length === 0, extra.join(", "));

// --- [2] every mapped key exists in BOTH locales (real key checks) ----------
console.log("\n== [2] label keys exist in EN and FA message objects ==");
const missingEn = backendKeys.filter((k) => {
  const label = clientMapping[k];
  return !label || !(label in enLabels) || typeof enLabels[label] !== "string" || enLabels[label].length === 0;
});
ok("2a. all dataset labels exist in EN portability.datasetsLabels", missingEn.length === 0, missingEn.join(", "));
const missingFa = backendKeys.filter((k) => {
  const label = clientMapping[k];
  return !label || !(label in faLabels) || typeof faLabels[label] !== "string" || faLabels[label].length === 0;
});
ok("2b. all dataset labels exist in FA portability.datasetsLabels", missingFa.length === 0, missingFa.join(", "));
const faPersian = backendKeys.filter((k) => {
  const label = clientMapping[k];
  const v = faLabels[label] ?? "";
  return !/[\u0600-\u06FF]/.test(v);
});
ok("2c. FA labels are actual Persian text (no English leaks)", faPersian.length === 0, faPersian.join(", "));

// --- [3] single mapping law (server labelKey == client mapping) --------------
console.log("\n== [3] backend labelKey agrees with the client mapping ==");
const drifted = backendKeys.filter((k) => catalogLabelKeys[k] && clientMapping[k] && catalogLabelKeys[k] !== clientMapping[k]);
ok("3a. EXPORT_CATALOG.labelKey === DATASET_LABEL_KEYS for every dataset", drifted.length === 0, drifted.join(", "));

// --- [4] selectable list subset of the API vocabulary ------------------------
console.log("\n== [4] panel selectable list ⊆ API vocabulary ==");
const unknownSelectable = selectableKeys.filter((k) => !backendKeys.includes(k));
ok("4a. panel never offers an API-unknown dataset", unknownSelectable.length === 0, unknownSelectable.join(", "));
ok("4b. panel exposes the top-level datasets (≥ 15)", selectableKeys.length >= 15, String(selectableKeys.length));

// --- [5] no empty/undefined holes --------------------------------------------
console.log("\n== [5] locale object hygiene ==");
const holeEn = Object.entries(enLabels).filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
ok("5a. no empty EN dataset labels", holeEn.length === 0, holeEn.join(", "));
const holeFa = Object.entries(faLabels).filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
ok("5b. no empty FA dataset labels", holeFa.length === 0, holeFa.join(", "));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
