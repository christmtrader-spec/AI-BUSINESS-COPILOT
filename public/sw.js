/**
 * AI Business Copilot — light offline service worker (Prompt 52 §F5).
 *
 * Strategy (deliberately conservative — this app is FINANCIAL):
 *  - App shell (document navigations + static assets): cache-first on
 *    install of the shell, then network-first with cache fallback so
 *    deploys always win when online.
 *  - GET /api/v1/* reads: network-first; when the network fails, serve the
 *    last successful response (stale data is labeled by the app itself —
 *    the UI shows it read-only). NOTHING is ever WRITTEN offline: every
 *    non-GET goes straight to the network, no replay, no queueing.
 *  - Auth/session endpoints, webhooks and everything outside /api/v1 are
 *    never cached.
 *
 * Cache is bounded (LRU-ish trim) and versioned; old versions are purged
 * on activate. Registration is dev-guarded in PwaRegister (localhost skips).
 */
const VERSION = "abc-pwa-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = [
  "/",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest",
];

const MAX_DATA_ENTRIES = 120;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individual adds — one bad asset must not fail the install.
      await Promise.allSettled(SHELL_ASSETS.map((a) => cache.add(a)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function trimCache(cacheName, maxEntries) {
  return (async () => {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    // Oldest inserted first (request order) — drop from the front.
    for (const key of keys.slice(0, keys.length - maxEntries)) {
      await cache.delete(key);
    }
  })();
}

async function networkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && (fresh.ok || fresh.type === "opaqueredirect")) {
      cache.put(request, fresh.clone()).catch(() => undefined);
      trimCache(cacheName, maxEntries).catch(() => undefined);
    }
    return fresh;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function isApiRead(request) {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.origin === self.location.origin &&
    url.pathname.startsWith("/api/v1/") &&
    !url.pathname.startsWith("/api/v1/auth") &&
    !url.pathname.startsWith("/api/v1/webhooks")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only same-origin GETs participate. Non-GET (writes) ALWAYS go to the
  // network — an offline write would either fail honestly or, worse,
  // pretend to succeed. We never fake success for money operations.
  if (request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const url = new URL(request.url);
      if (url.origin !== self.location.origin) return fetch(request);

      // Navigations: network-first over the shell cache (offline shell).
      if (request.mode === "navigate") {
        return networkFirst(request, SHELL_CACHE, 12);
      }

      // Static assets (hashed): network-first is fine and stays fresh.
      if (url.pathname.startsWith("/_next/static") || url.pathname === "/logo.svg") {
        return networkFirst(request, SHELL_CACHE, 40);
      }

      // Business reads: last-known-good fallback when offline (§F5).
      if (await isApiRead(request)) {
        return networkFirst(request, DATA_CACHE, MAX_DATA_ENTRIES);
      }

      return fetch(request);
    })(),
  );
});
