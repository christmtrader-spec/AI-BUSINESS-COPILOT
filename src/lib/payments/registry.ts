/**
 * Payment provider registry — Prompt 22 + Prompt 23.
 *
 * The ONLY place that knows which providers exist. Resolution rules:
 * - Code-registered adapters (mock + zarinpal + stripe) are candidates.
 * - `PAYMENT_PROVIDERS` env (comma-separated slugs) RESTRICTS the set when
 *   present (e.g. `PAYMENT_PROVIDERS=mock` in CI). Unknown slugs in the
 *   env are ignored (they simply have no adapter).
 * - `PAYMENT_PROVIDER` selects the PREFERRED provider for new checkouts
 *   (Prompt 23 §5 stable provider code). When it names a provider that is
 *   NOT usable, resolution FAILS CLOSED (422) — never a silent fallback to
 *   another provider (§89/§90). Without it, the first usable adapter wins.
 * - A provider is USABLE only when its adapter says `configured` AND the
 *   global payment configuration has no blockers (config.ts).
 * - `resolveProvider` fails CLOSED: unconfigured/unknown slug →
 *   PROVIDER_UNAVAILABLE. Nothing ever falls back to another provider.
 *
 * Real providers later: add the adapter file, register it here, gate
 * `configured` on the presence of its env keys. No other file changes.
 */

import { ApiError } from "@/lib/api-helpers";
import { validatePaymentConfig } from "./config";
import { mockProvider } from "./mock-provider";
import { stripeProvider } from "./stripe";
import type { PaymentProvider, ProviderSlug } from "./types";
import { zarinpalProvider } from "./zarinpal";

const ADAPTERS: readonly PaymentProvider[] = [mockProvider, zarinpalProvider, stripeProvider];

function envAllowlist(): Set<string> | null {
  const raw = process.env.PAYMENT_PROVIDERS?.trim();
  if (!raw) return null;
  const slugs = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return slugs.length > 0 ? new Set(slugs) : null;
}

/** All providers visible in this environment (configured ones usable). */
export function listProviders(): Array<{
  slug: ProviderSlug;
  displayName: string;
  mode: string;
  configured: boolean;
  usable: boolean;
  currencies: readonly string[];
  webhooks: boolean;
}> {
  const allow = envAllowlist();
  const cfg = validatePaymentConfig();
  return ADAPTERS.filter((p) => !allow || allow.has(p.slug)).map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    mode: p.mode,
    configured: p.configured && cfg.blockers.length === 0,
    usable: p.configured && cfg.blockers.length === 0,
    currencies: p.capabilities.currencies,
    webhooks: p.capabilities.webhooks,
  }));
}

export function isProviderUsable(slug: string): boolean {
  const allow = envAllowlist();
  if (allow && !allow.has(slug)) return false;
  const cfg = validatePaymentConfig();
  if (cfg.blockers.length > 0) return false;
  const p = ADAPTERS.find((a) => a.slug === slug);
  return !!p && p.configured;
}

/** Resolve THE provider for a slug — fails closed (§68 spirit). */
export function resolveProvider(slug: string): PaymentProvider {
  if (!isProviderUsable(slug)) {
    throw new ApiError(422, "PROVIDER_UNAVAILABLE", "The requested payment provider is not available.");
  }
  return ADAPTERS.find((a) => a.slug === slug) as PaymentProvider;
}

/** Non-throwing adapter lookup — for the webhook route's 404 path. */
export function findProvider(slug: string): PaymentProvider | null {
  if (!isProviderUsable(slug)) return null;
  return ADAPTERS.find((a) => a.slug === slug) ?? null;
}

/**
 * The default provider for NEW checkout sessions (Prompt 23 §5/§90):
 * PAYMENT_PROVIDER when usable; fail closed when explicitly set but not
 * usable (no silent provider switch); otherwise the first usable adapter.
 */
export function defaultProvider(): PaymentProvider {
  const preferred = validatePaymentConfig().providerSlug;
  if (preferred) {
    if (isProviderUsable(preferred)) {
      return resolveProvider(preferred);
    }
    // An explicitly configured provider that cannot start blocks payments
    // entirely — silently charging through a different provider is worse
    // than no payments (§90).
    const exists = ADAPTERS.some((a) => a.slug === preferred);
    throw new ApiError(
      422,
      exists ? "PAYMENTS_UNAVAILABLE" : "PROVIDER_UNAVAILABLE",
      "The configured payment provider is not available.",
    );
  }
  const usable = listProviders().filter((p) => p.usable);
  if (usable.length === 0) {
    throw new ApiError(422, "PROVIDER_UNAVAILABLE", "No payment provider is configured.");
  }
  return resolveProvider(usable[0].slug);
}
