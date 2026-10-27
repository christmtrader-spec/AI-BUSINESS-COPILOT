/**
 * R-RECOVERY — one-shot converter: old LegalDocument shape (locales.en/fa,
 * sections[].blocks) → new LegalDocumentContent shape (title/intro/
 * sections with heading/paragraphs/bullets) consumed by the surviving
 * LegalView (src/modules/legal/legal-view.tsx) via src/content/legal/index.ts.
 *
 * Reads the OLD content modules (they remain the honest source of the text)
 * and writes NEW side-files (privacy-content.ts / terms-content.ts /
 * ai-data-use-content.ts) so the old registry/pages keep working untouched.
 *
 * Run: bun scripts/rebuild-legal-content.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { privacyDoc } from "../src/content/legal/privacy";
import { termsDoc } from "../src/content/legal/terms";
import { aiDataUseDoc } from "../src/content/legal/ai-data-use";

type OldBlock =
  | { kind: "p"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

type OldSection = { id: string; title: string; blocks: OldBlock[] };
type OldDoc = {
  type: string;
  locales: {
    en: { title: string; description: string; sections: OldSection[] };
    fa: { title: string; description: string; sections: OldSection[] };
  };
};

function q(s: string): string {
  return JSON.stringify(s);
}

function convert(varName: string, key: string, doc: OldDoc): string {
  const en = doc.locales.en;
  const fa = doc.locales.fa;
  if (en.sections.length !== fa.sections.length) {
    throw new Error(`${key}: section count mismatch EN=${en.sections.length} FA=${fa.sections.length}`);
  }
  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${key} content — RECOVERY-GENERATED from the audited old-shape`);
  lines.push(` * document (${varName}) by scripts/rebuild-legal-content.ts.`);
  lines.push(` * The TEXT is the reviewed copy — NOT rewritten, only reshaped`);
  lines.push(` * into the paired-locale LegalDocumentContent model.`);
  lines.push(` */`);
  lines.push(`import type { LegalDocumentContent } from "./types";`);
  lines.push(``);
  lines.push(`export const ${varName}: LegalDocumentContent = {`);
  lines.push(`  key: ${q(key)},`);
  lines.push(`  title: { en: ${q(en.title)}, fa: ${q(fa.title)} },`);
  lines.push(`  intro: [`);
  lines.push(`    { en: ${q(en.description)}, fa: ${q(fa.description)} },`);
  lines.push(`  ],`);
  lines.push(`  sections: [`);
  for (let i = 0; i < en.sections.length; i++) {
    const se = en.sections[i];
    const sf = fa.sections[i];
    const paragraphsEn: string[] = [];
    const bulletsEn: string[] = [];
    const paragraphsFa: string[] = [];
    const bulletsFa: string[] = [];
    const collect = (
      blocks: OldBlock[],
      par: string[],
      bul: string[],
    ) => {
      for (const b of blocks) {
        if (b.kind === "p") par.push(b.text);
        else if (b.kind === "bullets") bul.push(...b.items);
        else {
          // table → flattened bullet rows ("head: cell — cell")
          for (const row of b.rows) {
            bul.push(row.map((c, ci) => (b.head[ci] ? `${b.head[ci]}: ${c}` : c)).join(" — "));
          }
        }
      }
    };
    collect(se.blocks, paragraphsEn, bulletsEn);
    collect(sf.blocks, paragraphsFa, bulletsFa);
    if (paragraphsEn.length !== paragraphsFa.length || bulletsEn.length !== bulletsFa.length) {
      throw new Error(`${key} section ${se.id}: block count mismatch`);
    }
    lines.push(`    {`);
    lines.push(`      id: ${q(se.id)},`);
    lines.push(`      heading: { en: ${q(se.title)}, fa: ${q(sf.title)} },`);
    if (paragraphsEn.length) {
      lines.push(`      paragraphs: [`);
      for (let j = 0; j < paragraphsEn.length; j++) {
        lines.push(`        { en: ${q(paragraphsEn[j])}, fa: ${q(paragraphsFa[j])} },`);
      }
      lines.push(`      ],`);
    }
    if (bulletsEn.length) {
      lines.push(`      bullets: [`);
      for (let j = 0; j < bulletsEn.length; j++) {
        lines.push(`        { en: ${q(bulletsEn[j])}, fa: ${q(bulletsFa[j])} },`);
      }
      lines.push(`      ],`);
    }
    lines.push(`    },`);
  }
  lines.push(`  ],`);
  lines.push(`};`);
  lines.push(``);
  return lines.join("\n");
}

const files: Array<[string, string, string, OldDoc]> = [
  ["privacyContent", "privacy", "privacy-content.ts", privacyDoc as unknown as OldDoc],
  ["termsContent", "terms", "terms-content.ts", termsDoc as unknown as OldDoc],
  ["aiDataUseContent", "ai-data-use", "ai-data-use-content.ts", aiDataUseDoc as unknown as OldDoc],
];

for (const [varName, key, file, doc] of files) {
  const out = convert(varName, key, doc);
  const path = `../src/content/legal/${file}`;
  writeFileSync(new URL(path, import.meta.url), out);
  console.log(`wrote ${file} (${out.split("\n").length} lines)`);
}
console.log("done");
