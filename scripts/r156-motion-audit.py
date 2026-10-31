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

DEEP MODE (--deep, R169) — the v1 scan had TWO blind spots the radio-card
a11y gap exploited:
  1. cn()-wrapped classes: `className={cn("base", cond ? "a" : "b")}` — the
     className=-anchored regex never sees the conditional pieces;
  2. ARIA-role interactivity: div/span/li elements with role="radio|option|
     menuitem|tab|switch" are interactive surfaces but carry no <button> tag
     for any tag-anchored check.
Deep mode scans EVERY string literal in every .tsx (transition tokens only
appear in class strings in practice) for the missing motion-reduce escape,
and requires every role=* interactive surface to carry a VISIBLE focus
state (focus-visible:ring-2 / focus-visible:outline-2). Read-only — deep
findings are REPORT-only (hand-fix with Edit; the R168 battery pins the
radio family structurally).

Usage: python3 scripts/r156-motion-audit.py [--fix] [--deep]
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

# R169 --deep: ANY string literal (cn() pieces included) + the ARIA-role law.
ANY_STRING = re.compile(r'["\'`]([^"\'`\n]{4,400})["\'`]')
ROLE_SURFACE = re.compile(
    r'role="(radio|option|menuitem|tab|switch)"'
)
FOCUS_VISIBLE = re.compile(r"focus-visible:(ring-2|outline-2|outline\b)")


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


def deep_scan():
    """R169 --deep: read-only. Returns (transition_gaps, focus_gaps).

    transition_gaps: string literals (className= OR cn() pieces OR plain
    arrays) carrying a transition token without the escape, where the string
    ALSO looks like a class list (contains a known interactive-state token:
    hover:/focus/active:/group-hover) — state-styled strings only, so plain
    data strings never fire.
    focus_gaps: role="radio|option|menuitem|tab|switch" surfaces whose
    900-char neighborhood carries NO focus-visible class.
    """
    transition_gaps, focus_gaps = [], []
    STATE_TOKEN = re.compile(r"hover:|focus|active:|group-hover:")
    for p in sorted(SRC.rglob("*.tsx")):
        rel = str(p.relative_to(ROOT))
        if ".test." in rel:
            continue
        text = p.read_text()
        # (a) every string literal with transitions + interactive states
        for m in ANY_STRING.finditer(text):
            cls = m.group(1)
            if ESCAPE in cls:
                continue
            cleaned = MOTION_SAFE.sub("", cls)
            if not TRANSITION.search(cleaned):
                continue
            if not STATE_TOKEN.search(cleaned):
                continue  # a transition with NO interactive state is decorative/static
            line = text[: m.start()].count("\n") + 1
            transition_gaps.append((rel, line, cls[:120]))
        # (b) every role=* interactive surface needs a visible focus state
        for m in ROLE_SURFACE.finditer(text):
            window = text[m.end() : m.end() + 900]
            if not FOCUS_VISIBLE.search(window):
                line = text[: m.start()].count("\n") + 1
                focus_gaps.append((rel, line, m.group(1)))
    # dedupe (a) by (rel, line) — nested quotes can double-report
    seen = set()
    transition_gaps = [g for g in transition_gaps if not (g[0], g[1]) in seen and not seen.add((g[0], g[1]))]
    return transition_gaps, focus_gaps


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
    if "--deep" in sys.argv:
        tgap, fgap = deep_scan()
        print(f"\nDEEP transition gaps: {len(tgap)} (state-styled strings missing {ESCAPE})")
        for rel, line, cls in tgap:
            print(f"  deep-t  {rel}:{line}  {cls}")
        print(f"DEEP focus gaps: {len(fgap)} (role=* surfaces without focus-visible)")
        for rel, line, role in fgap:
            print(f"  deep-f  {rel}:{line}  role={role}")
        if tgap or fgap:
            return 1
        print("DEEP: CLEAN ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
