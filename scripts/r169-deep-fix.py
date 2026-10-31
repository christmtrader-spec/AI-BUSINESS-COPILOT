#!/usr/bin/env python3
"""
r169-deep-fix.py — closes the --deep findings (transition escapes + role=*
focus-visible), reusing the audit module's own scan so the fix list IS the
audit list (no drift). Safety rules inherited from the v1 lesson:
  - plain quoted strings only (no `${`, no backtick) are auto-appended;
  - everything else is left for the hand-fix list;
  - idempotent: re-runs change nothing.

Usage: python3 scripts/r169-deep-fix.py
"""
import importlib.util
import sys
import pathlib

_root = pathlib.Path(__file__).parent
_spec = importlib.util.spec_from_file_location("r156_motion_audit", _root / "r156-motion-audit.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

ROOT = audit.ROOT
ESCAPE = audit.ESCAPE
FOCUS = (
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring "
    "focus-visible:ring-offset-1 focus-visible:ring-offset-background"
)
HAND_FIX = {
    # template literal with ${} — the safe-fix discipline says hand-edit
    ("src/modules/auth/auth-view.tsx", 99),
}


def append_to_quoted(text: str, needle_cls: str, suffix: str) -> tuple[str, int]:
    """Append suffix inside the quoted literal that contains needle_cls.
    Returns (new_text, replacements)."""
    count = 0
    for delim in ('"', "'", "`"):
        probe = f"{delim}{needle_cls}{delim}"
        if probe in text:
            text = text.replace(probe, f"{delim}{needle_cls}{suffix}{delim}")
            count += 1
    return text, count


def append_line_based(text: str, lineno: int, suffix: str) -> int:
    """Append suffix to the state-styled quoted literal ON this line."""
    lines = text.split("\n")
    if lineno - 1 >= len(lines):
        return 0
    line = lines[lineno - 1]
    import re as _re
    for m in _re.finditer(r'["\'`]([^"\'`\n]+)["\'`]', line):
        lit = m.group(1)
        if audit.ESCAPE in lit or "${" in lit:
            continue
        if not audit.TRANSITION.search(audit.MOTION_SAFE.sub("", lit)):
            continue
        if not _re.search(r"hover:|focus|active:|group-hover:", lit):
            continue
        new_lit = lit + suffix
        start, end = m.span(1)
        lines[lineno - 1] = line[:start] + new_lit + line[end:]
        return 1
    return 0


def main():
    tgap, fgap = audit.deep_scan()
    fixed_t, fixed_f = 0, 0
    skipped = []

    # ── transition escapes ──
    cache: dict[str, str] = {}
    for rel, line, cls in tgap:
        if (rel, line) in HAND_FIX or "${" in cls or "`" in cls:
            skipped.append((rel, line, "template/hand"))
            continue
        p = ROOT / rel
        text = cache.get(rel) or p.read_text()
        # the audit's cls may be a truncated window ([:120]) — match the real literal
        real = cls if cls.endswith(('"', "'", "`")) is False else cls
        new_text, n = append_to_quoted(text, cls.rstrip(), f" {ESCAPE}")
        if not n:
            n = append_line_based(text, line, f" {ESCAPE}")
            new_text = text
        if n:
            cache[rel] = new_text
            fixed_t += 1
        else:
            skipped.append((rel, line, "literal not found (truncated window)"))

    # ── role=* focus-visible ──
    for rel, line, role in fgap:
        p = ROOT / rel
        text = cache.get(rel) or p.read_text()
        changed = False
        # find each role="<role>" occurrence and patch the NEXT className literal
        idx = 0
        while True:
            i = text.find(f'role="{role}"', idx)
            if i < 0:
                break
            window_end = min(len(text), i + 900)
            window = text[i:window_end]
            if audit.FOCUS_VISIBLE.search(window[:400]):
                idx = i + 1
                continue
            # locate the first className="..." / className={`...`} / cn("...") opening after the role
            import re as _re
            m = _re.search(r'className=(?:\{)?(?:cn\()?[`"]', window)
            if not m:
                idx = i + 1
                continue
            open_pos = i + m.end()  # position right AFTER the quote
            delim = text[open_pos - 1]
            close_pos = text.find(delim, open_pos)
            if close_pos < 0 or close_pos > window_end:
                idx = i + 1
                continue
            lit = text[open_pos:close_pos]
            if "${" in lit or "\n" in lit:
                skipped.append((rel, line, "complex literal — hand"))
                idx = i + 1
                continue
            text = text[:close_pos] + f" {FOCUS}" + text[close_pos:]
            cache[rel] = text
            fixed_f += 1
            changed = True
            idx = close_pos + len(FOCUS) + 2
        if not changed:
            pass

    for rel, text in cache.items():
        (ROOT / rel).write_text(text)
        print(f"patched {rel}")

    print(f"\ntransition escapes appended: {fixed_t}")
    print(f"focus-visible appended:      {fixed_f}")
    if skipped:
        print("SKIPPED (hand-fix):")
        for rel, line, why in skipped:
            print(f"  {rel}:{line} — {why}")


if __name__ == "__main__":
    main()
