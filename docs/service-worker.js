
const CACHE_NAME = "goldbot-za-static-v1";
const APP_ROOT = "/GoldBot-Sa/";
const OFFLINE_URL = APP_ROOT + "offline.html";

const STATIC_FILES = [
  APP_ROOT,
  APP_ROOT + "index.html",
  APP_ROOT + "manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) =>
              key.startsWith("goldbot-za-static-") &&
              key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Never cache API calls or trading data.
  if (
    url.hostname.includes("supabase.co") ||
    url.pathname.includes("/functions/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/auth/") ||
    url.pathname.includes("/storage/")
  ) {
    return;
  }

  // Only handle requests belonging to this GitHub Pages app.
  if (!url.pathname.startsWith(APP_ROOT)) return;

  // Always try the network first for page navigation.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) =>
                cache.put(APP_ROOT + "index.html", copy)
              )
            );
          }
          return response;
        })
        .catch(async () => {
          return (
            await caches.match(request) ||
            await caches.match(APP_ROOT + "index.html") ||
            new Response(
              "GoldBot-ZA is offline. Reconnect to load current gold prices and signals.",
              {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
              }
            )
          );
        })
    );
    return;
  }

  // Cache-first only for known static app files.
  const isStaticFile =
    url.pathname === APP_ROOT + "manifest.json" ||
    url.pathname === APP_ROOT + "index.html" ||
    url.pathname === APP_ROOT + "icon-192.png" ||
    url.pathname === APP_ROOT + "icon-512.png";

  if (!isStaticFile) return;

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;

      const response = await fetch(request);

      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }

      return response;
    })
  );
});
