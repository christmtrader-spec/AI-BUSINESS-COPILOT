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

DEEP v2 (--deep, R170 §3 priority #1) — THE RING-PLACEMENT LAW. The R170
QA caveat exposed the third blind spot: the focus check searched a 900-char
WINDOW after role="…", so a focus-visible ring on a CHILD <span> satisfied
it while the ring was behaviorally DEAD on the keyboard path (a span can
never receive focus — the PO supplier picker bug). v2 resolves the JSX
OPENING TAG that carries the role attribute (a quote- and brace-aware walk:
`>` inside strings or {...} — arrow functions, nested JSX — never ends the
tag) and requires focus-visible INSIDE THAT TAG. Three verdicts per role
element:
  - on-tag  → clean;
  - child-window ring but not on the tag → deep-m MISPLACED (dead ring);
  - no ring anywhere near → deep-f ABSENT (the v1 gap, unchanged).

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


def _tag_bounds(text: str, role_start: int, role_end: int):
    """v2: resolve the JSX opening tag that CONTAINS the role attribute.

    Returns (tag_start, tag_end) inclusive-of-'>' indices, or None when the
    walk cannot resolve the tag (comments, unusual nesting) — the caller
    then falls back to the v1 window check only.

    Both walks are quote- and brace-aware: a '>' inside a string literal or
    inside a {...} expression container (arrow functions `() =>`, nested
    JSX props) must NOT end the tag; an unquoted '>' at brace depth 0 does.
    """
    # backward: find the '<' that opens this tag
    depth, q, i = 0, None, role_start
    while i >= 0:
        c = text[i]
        if q:
            if c == q:
                q = None
        elif c in "\"'`":
            q = c
        elif c == "}":
            depth += 1
        elif c == "{":
            if depth == 0:
                return None  # a JSX expression container BEFORE our tag — unresolved
            depth -= 1
        elif c == "<" and depth == 0:
            if text[i + 1 : i + 2].isalpha():
                tag_start = i
                break
            return None  # '</' closing tag or stray '<' — unresolved
        i -= 1
    else:
        return None
    if i < 0:
        return None
    # forward: find the '>' that closes the opening tag
    depth, q, j = 0, None, role_end
    while j < len(text):
        c = text[j]
        if q:
            if c == q:
                q = None
        elif c in "\"'`":
            q = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == ">" and depth == 0:
            return (tag_start, j)
        elif c == "<" and depth == 0:
            return None  # a new tag began before ours closed — unresolved
        j += 1
    return None


def deep_scan():
    """R169 --deep (v2 placement law, R170 §3): read-only.

    Returns (transition_gaps, focus_gaps, misplaced).

    transition_gaps: string literals (className= OR cn() pieces OR plain
    arrays) carrying a transition token without the escape, where the string
    ALSO looks like a class list (contains a known interactive-state token:
    hover:/focus/active:/group-hover) — state-styled strings only, so plain
    data strings never fire.
    focus_gaps: role="radio|option|menuitem|tab|switch" surfaces whose
    900-char neighborhood carries NO focus-visible class (ABSENT).
    misplaced (v2): role=* surfaces where focus-visible exists in the
    surrounding window but NOT inside the opening tag itself — the ring
    landed on a CHILD element and is behaviorally DEAD on the keyboard path
    (a <span> can never receive focus; the R170 PO-picker bug).
    """
    transition_gaps, focus_gaps, misplaced = [], [], []
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
        # (b) every role=* interactive surface needs a VISIBLE focus state
        #     ON ITSELF (v2 placement law), not on a child element.
        for m in ROLE_SURFACE.finditer(text):
            line = text[: m.start()].count("\n") + 1
            bounds = _tag_bounds(text, m.start(), m.end())
            if bounds is not None:
                tag_text = text[bounds[0] : bounds[1] + 1]
                window = text[bounds[1] + 1 : bounds[1] + 1 + 900]
                if FOCUS_VISIBLE.search(tag_text):
                    continue  # the ring lives ON the interactive element — clean
                if FOCUS_VISIBLE.search(window):
                    misplaced.append((rel, line, m.group(1)))
                    continue  # dead ring on a child — v2's whole point
                focus_gaps.append((rel, line, m.group(1)))
                continue
            # unresolved tag — fall back to the v1 window check
            window = text[m.end() : m.end() + 900]
            if not FOCUS_VISIBLE.search(window):
                focus_gaps.append((rel, line, m.group(1)))
    # dedupe (a) by (rel, line) — nested quotes can double-report
    seen = set()
    transition_gaps = [g for g in transition_gaps if not (g[0], g[1]) in seen and not seen.add((g[0], g[1]))]
    return transition_gaps, focus_gaps, misplaced


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
        tgap, fgap, mis = deep_scan()
        print(f"\nDEEP transition gaps: {len(tgap)} (state-styled strings missing {ESCAPE})")
        for rel, line, cls in tgap:
            print(f"  deep-t  {rel}:{line}  {cls}")
        print(f"DEEP misplaced rings: {len(mis)} (focus-visible on a CHILD of the role=* element — dead on the keyboard path)")
        for rel, line, role in mis:
            print(f"  deep-m  {rel}:{line}  role={role}")
        print(f"DEEP focus gaps: {len(fgap)} (role=* surfaces without focus-visible)")
        for rel, line, role in fgap:
            print(f"  deep-f  {rel}:{line}  role={role}")
        if tgap or fgap or mis:
            return 1
        print("DEEP: CLEAN ✓ (v2 placement law)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
