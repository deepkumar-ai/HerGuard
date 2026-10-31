/* HER GUARD service worker.
 * Caches the shell so the app opens offline; API calls are never cached so
 * risk scoring, check-ins and dispatch state always come from the live backend.
 */
const CACHE = "herguard-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache the API or anything that is not a same-origin/GET/cacheable asset.
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin && !url.hostname.includes("unpkg.com") && !url.hostname.includes("tailwindcss")) {
    return;
  }

  // Navigations: network first so a running backend always wins, shell as fallback.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  // Static assets: cache first, refreshed in the background on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached);
    })
  );
});
