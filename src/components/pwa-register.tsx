"use client";

import { useEffect } from "react";

/**
 * Prompt 52 §F5 — PWA registration.
 * Registers the light-offline service worker in production (and any https
 * origin); localhost/dev is skipped so hot reload and Turbopack never fight
 * a cache. The manifest link + icons come from the root layout metadata.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && window.location.hostname === "localhost") {
      // Dev sandbox still serves over http on a LAN host — allow that, but
      // never register on plain localhost where it breaks HMR.
      return;
    }
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Registration is a progressive enhancement — never surface an error.
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
