"use client";

/**
 * Client analytics — Prompt 25 §49/§54/§101-§104/§148.
 *
 * Fire-and-forget POSTs to the STRICTLY allowlisted public ingest endpoint.
 * The server rejects any lifecycle event name (§104), sanitizes every
 * property (§103) and dedupes per session per UTC day — so re-renders and
 * remounts cannot inflate the funnel (§54/§159).
 *
 * - Event names come from the SAME registry the server uses — components
 *   never scatter raw strings (§101).
 * - Only §103-safe properties are ever sent (planCode/billingPeriod/
 *   currency/page/source/locale). No form input, no amounts, no PII (§148).
 * - The dedupe session id is a random UUID kept in sessionStorage — it
   identifies a TAB SESSION, never a person (privacy §107).
 * - Never throws, never awaits rendering: analytics cannot break the UX.
 */

import type { AnalyticsEventName, AnalyticsProps } from "@/lib/analytics";

const SESSION_KEY = "abc:analyticsSession";

function sessionMarker(): string {
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID().replace(/-/g, "")
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return "nosession";
  }
}

/** Client-trackable events only (mirror of the server allowlist). */
export const CLIENT_EVENTS = {
  pricingViewed: "PRICING_VIEWED",
  planSelected: "PLAN_SELECTED",
  signupStarted: "SIGNUP_STARTED",
  onboardingStarted: "ONBOARDING_STARTED",
} as const satisfies Record<string, AnalyticsEventName>;

export function trackClientEvent(name: AnalyticsEventName, props: AnalyticsProps = {}): void {
  // Best-effort: an analytics outage must never surface in the UI.
  try {
    const body = JSON.stringify({
      name,
      props,
      sessionId: sessionMarker(),
    });
    void fetch("/api/v1/public/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // ignore — analytics is strictly optional (§105)
  }
}
