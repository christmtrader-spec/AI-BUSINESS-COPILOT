# Cookie Assessment

**Document ID:** LEGAL-COOKIES-v1 · **Created:** 2026-09-25 (Prompt 27 §35-§38/§92)
**Conclusion: NO cookie banner is required for the current product** — because
only essential cookies and functional local storage exist. A banner was NOT
added merely because websites "usually have one" (§35).

## Actual technology usage (verified in code)

| Technology | Name / key | Type | Purpose | Duration | Essential? |
|---|---|---|---|---|---|
| Session cookie | NextAuth v4 default session cookie (httpOnly, signed/encrypted; the exact cookie name is implementation-defined and intentionally NOT hard-coded in public copy — §36) | Cookie | Keep the user signed in | Session / 30-day maxAge per NextAuth config | YES — authentication cannot work without it |
| Local storage | `abc-preferences` (Zustand persist: locale, active business id) | Local storage | Remember language + last workspace | Until cleared | Functional preference (no tracking) |
| Local storage | `abc:pendingInvite`, `abc:pendingPlan` | Local storage | Carry an invite token / plan hint across the auth handoff | Cleared after use | Functional |
| Session storage | `abc:onboardingResumed` | Session storage | Show the onboarding resume once per browser session | Tab close | Functional |

## What does NOT exist (verified)

- No third-party analytics scripts (first-party `AnalyticsEvent` table only,
  server-side, no cookies involved)
- No advertising or marketing cookies
- No consent-management infrastructure

## Consequences

1. Public copy documents "an authentication session cookie and local
   preference storage" — it does NOT claim "we use no cookies" (§92).
2. If third-party analytics are ever introduced, they MUST be designed
   behind an explicit consent mechanism where legally required, and this
   document + the privacy policy must be updated first (§38).
3. A separate `/cookies` page is NOT created — the essential-only usage is
   documented inside the Privacy Policy ("Cookies and local storage"
   section), which is proportionate to the actual usage.
