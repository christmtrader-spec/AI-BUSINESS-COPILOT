"use client";

import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/app-store";

/**
 * Prompt 52 §F2 — consume a cross-view quick-action intent.
 *
 * The dashboard fires `{action, seq}` then navigates to the target module;
 * the target module calls this hook and opens its create dialog once per
 * fired intent (the `seq` guard makes double-fires impossible and a stale
 * intent from a previous session harmless because it is consumed on mount).
 */
export function useQuickIntent(
  action: "new-sale" | "new-expense" | "new-payment" | "new-product",
  onFire: () => void,
): void {
  const quickIntent = useAppStore((s) => s.quickIntent);
  const consume = useAppStore((s) => s.consumeQuickIntent);
  const lastSeq = useRef<number | null>(null);
  const onFireRef = useRef(onFire);

  // Keep the callback ref fresh without writing refs during render.
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  useEffect(() => {
    if (!quickIntent) return;
    if (quickIntent.action !== action) return;
    if (lastSeq.current === quickIntent.seq) return;
    lastSeq.current = quickIntent.seq;
    onFireRef.current();
    consume();
  }, [quickIntent, action, consume]);
}
