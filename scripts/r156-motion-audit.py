#!/usr/bin/env python3
"""
r156-motion-audit.py — the motion-safety audit (R156, --fix to apply).

THE LAW (the R147→R155 family, now closed app-wide): every interactive
transition-* class MUST carry its motion-reduce escape — a user with
"reduce motion" prefers NO animated hover/focus/state changes.

SAFE FIX MODE (--fix) — the v1 lesson (a naive regex ate template-literal
delimiters and corrupted pricing-view): the fixer only rewrites
  a) "…"/'…' className strings containing NO `${`, NO backtick, NO quotes;
  b) `…` template literals containing NO `${` and NO quote chars;
everything else is reported as MANUAL (hand-fixed with Edit — a short list).
Idempotent: re-runs find nothing to fix.

Usage: python3 scripts/r156-motion-audit.py [--fix]
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

STRINGS = re.compile(r'className=(?:\{)?[`"\']([^`"\']*(?:\n[^`"\']*)*)[`"\']')
TRANSITION = re.compile(
    r"(?<![\w-])transition(?![\w-])|(?<![\w-])transition-(colors|opacity|transform|all|scale|shadow|position|padding|margin|width|height|size)"
)
MOTION_SAFE = re.compile(r"motion-safe:[^\s`\"']+")
ESCAPE = "motion-reduce:transition-none"


def classify(cls: str) -> str:
    """'fixable' | 'manual' | 'skip' for one candidate string literal."""
    if ESCAPE in cls:
        return "skip"
    if not TRANSITION.search(MOTION_SAFE.sub("", cls)):
        return "skip"
    if "`" in cls:
        return "skip"  # regex could not capture a full template literal anyway
    if "${" in cls or '"' in cls or "'" in cls:
        return "manual"
    return "fixable"


def scan():
    fixable, manual = [], []
    for p in sorted(SRC.rglob("*.tsx")):
        rel = str(p.relative_to(ROOT))
        if ".test." in rel:
            continue
        text = p.read_text()
        for m in STRINGS.finditer(text):
            cls = m.group(1)
            kind = classify(cls)
            if kind == "skip":
                continue
            line = text[: m.start()].count("\n") + 1
            s1, e1 = m.span(1)  # GROUP-1 span ONLY — never eat className=" or the delimiter (the v1/v2 lesson)
            (fixable if kind == "fixable" else manual).append((rel, line, s1, e1, cls))
    return fixable, manual


def apply(fixable):
    by_file = {}
    for rel, line, start, end, cls in fixable:
        by_file.setdefault(rel, []).append((start, end, cls))
    for rel, edits in by_file.items():
        p = ROOT / rel
        text = p.read_text()
        for start, end, cls in sorted(edits, key=lambda e: -e[0]):
            text = text[:start] + f"{cls} {ESCAPE}" + text[end:]
        p.write_text(text)
        print(f"fixed {len(edits):3}  {rel}")


def main():
    fix = "--fix" in sys.argv
    fixable, manual = scan()
    print(f"FIXABLE: {len(fixable)} across {len({f[0] for f in fixable})} files")
    print(f"MANUAL : {len(manual)} sites")
    for rel, line, *_ in manual:
        print(f"  manual  {rel}:{line}")
    if fix and fixable:
        print()
        apply(fixable)
        f2, m2 = scan()
        print(f"\nafter fix: fixable {len(f2)}, manual {len(m2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
