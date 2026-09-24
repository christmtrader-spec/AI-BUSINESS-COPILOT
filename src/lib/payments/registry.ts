/**
 * Payment provider registry — Prompt 22.
 *
 * The ONLY place that knows which providers exist. Resolution rules:
 * - Code-registered adapters (mock today) are candidates.
 * - `PAYMENT_PROVIDERS` env (comma-separated slugs) RESTRICTS the set when
 *   present (e.g. `PAYMENT_PROVIDERS=mock` in CI). Unknown slugs in the
 *   env are ignored (they simply have no adapter).
 * - A provider is USABLE only when its adapter says `configured`.
 * - `resolveProvider` fails CLOSED: unconfigured/unknown slug →
 *   PROVIDER_UNAVAILABLE. Nothing ever falls back to another provider.
 *
 * Real providers later: add the adapter file, register it here, gate
 * `configured` on the presence of its env keys. No other file changes.
 */

import { ApiError } from "@/lib/api-helpers";
import { mockProvider } from "./mock-provider";
import type { PaymentProvider, ProviderSlug } from "./types";

const ADAPTERS: readonly PaymentProvider[] = [mockProvider];

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
}> {
  const allow = envAllowlist();
  return ADAPTERS.filter((p) => !allow || allow.has(p.slug)).map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    mode: p.mode,
    configured: p.configured,
    usable: p.configured,
  }));
}

export function isProviderUsable(slug: string): boolean {
  const allow = envAllowlist();
  if (allow && !allow.has(slug)) return false;
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

/** The default provider used for new checkout sessions. */
export function defaultProvider(): PaymentProvider {
  const usable = listProviders().filter((p) => p.usable);
  if (usable.length === 0) {
    throw new ApiError(422, "PROVIDER_UNAVAILABLE", "No payment provider is configured.");
  }
  return resolveProvider(usable[0].slug);
}
