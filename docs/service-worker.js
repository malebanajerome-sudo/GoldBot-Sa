/* ============================================================
   GoldBot-ZA | Stacks Co.
   Advanced Offline-First Progressive Web App Service Worker
   ============================================================ */

"use strict";

/* ---------- VERSIONED CACHES ---------- */

const VERSION = "v4";
const PREFIX = "goldbot-za";

const SHELL_CACHE = `${PREFIX}-${VERSION}-shell`;
const ASSET_CACHE = `${PREFIX}-${VERSION}-assets`;
const IMAGE_CACHE = `${PREFIX}-${VERSION}-images`;

const SCOPE_URL = self.registration.scope;
const APP_ROOT = new URL("./", SCOPE_URL);
const INDEX_URL = new URL("./index.html", SCOPE_URL).href;
const OFFLINE_URL = new URL("./offline.html", SCOPE_URL).href;

const NETWORK_TIMEOUT = 6000;
const MAX_IMAGE_ENTRIES = 40;

const SHELL_FILES = [
  APP_ROOT.href,
  INDEX_URL,
  new URL("./manifest.json", SCOPE_URL).href
];

/* ---------- HELPERS ---------- */

function isInsideApp(url) {
  return (
    url.origin === APP_ROOT.origin &&
    url.pathname.startsWith(APP_ROOT.pathname)
  );
}

function isBackendRequest(url) {
  return (
    url.hostname.endsWith(".supabase.co") ||
    /\/(functions|rest|auth|storage|realtime)\//i.test(url.pathname)
  );
}

function isCacheableResponse(response) {
  if (
    !response ||
    response.status !== 200 ||
    response.type !== "basic"
  ) {
    return false;
  }

  const cacheControl =
    response.headers.get("Cache-Control") || "";

  if (
    response.headers.has("Set-Cookie") ||
    /\b(no-store|private)\b/i.test(cacheControl)
  ) {
    return false;
  }

  return true;
}

function isSensitiveRequest(request) {
  return (
    request.method !== "GET" ||
    request.headers.has("Authorization") ||
    request.headers.has("apikey") ||
    request.cache === "no-store"
  );
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    NETWORK_TIMEOUT
  );

  try {
    return await fetch(request, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeCachePut(cacheName, request, response) {
  if (!isCacheableResponse(response)) return;

  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn("[GoldBot-ZA] Cache write failed:", error);
  }
}

async function safeCacheMatch(cacheName, request) {
  try {
    const cache = await caches.open(cacheName);
    return await cache.match(request);
  } catch (error) {
    console.warn("[GoldBot-ZA] Cache read failed:", error);
    return null;
  }
}

async function trimCache(cacheName, limit) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    while (keys.length > limit) {
      const oldest = keys.shift();
      if (oldest) await cache.delete(oldest);
    }
  } catch (error) {
    console.warn("[GoldBot-ZA] Cache trimming failed:", error);
  }
}

/* ---------- INSTALLATION ---------- */

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);

    // Cache each shell file independently.
    // A missing optional file must not break installation.
    await Promise.allSettled(
      SHELL_FILES.map(async url => {
        try {
          const response = await fetch(
            new Request(url, { cache: "reload" })
          );

          if (isCacheableResponse(response)) {
            await cache.put(url, response);
          }
        } catch (error) {
          console.warn(
            "[GoldBot-ZA] Shell file unavailable:",
            url
          );
        }
      })
    );

    // Offline fallback is optional. If offline.html exists,
    // cache it; otherwise index.html remains the fallback.
    try {
      const response = await fetch(
        new Request(OFFLINE_URL, { cache: "reload" })
      );

      if (isCacheableResponse(response)) {
        await cache.put(OFFLINE_URL, response);
      }
    } catch {
      console.info(
        "[GoldBot-ZA] Using cached app shell as offline fallback."
      );
    }

    await self.skipWaiting();
  })());
});

/* ---------- ACTIVATION AND CLEANUP ---------- */

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keepCaches = new Set([
      SHELL_CACHE,
      ASSET_CACHE,
      IMAGE_CACHE
    ]);

    const cacheNames = await caches.keys();

    await Promise.all(
      cacheNames
        .filter(name =>
          name.startsWith(`${PREFIX}-`) &&
          !keepCaches.has(name)
        )
        .map(name => caches.delete(name))
    );

    if (self.registration.navigationPreload) {
      try {
        await self.registration.navigationPreload.enable();
      } catch (error) {
        console.warn(
          "[GoldBot-ZA] Navigation preload unavailable:",
          error
        );
      }
    }

    await self.clients.claim();

    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of clients) {
      client.postMessage({
        type: "GOLDBOT_SW_ACTIVE",
        version: VERSION
      });
    }
  })());
});

/* ---------- OFFLINE NAVIGATION FALLBACK ---------- */

async function offlineFallback(request) {
  // First try the originally requested page.
  const requestedPage = await safeCacheMatch(
    SHELL_CACHE,
    request
  );

  if (requestedPage) return requestedPage;

  // Then try the dedicated offline page.
  const offlinePage = await safeCacheMatch(
    SHELL_CACHE,
    OFFLINE_URL
  );

  if (offlinePage) return offlinePage;

  // Finally try the main cached application shell.
  const appShell =
    await safeCacheMatch(SHELL_CACHE, INDEX_URL) ||
    await safeCacheMatch(SHELL_CACHE, APP_ROOT.href);

  if (appShell) return appShell;

  return new Response(
    "<!doctype html><html lang='en'><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>GoldBot-ZA Offline</title>" +
    "<body style='background:#080808;color:#d4af37;font-family:sans-serif;padding:32px'>" +
    "<h1>GoldBot-ZA</h1>" +
    "<p>You are offline. Reconnect to load the application and live market data.</p>" +
    "</body></html>",
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

/* ---------- NAVIGATION: NETWORK FIRST ---------- */

async function handleNavigation(request, event) {
  try {
    let response = null;

    // Use browser navigation preload if available.
    if (event.preloadResponse) {
      try {
        response = await Promise.race([
          event.preloadResponse,
          new Promise(resolve =>
            setTimeout(() => resolve(null), NETWORK_TIMEOUT)
          )
        ]);
      } catch {
        response = null;
      }
    }

    if (!response) {
      response = await fetchWithTimeout(request);
    }

    if (response && response.status === 200) {
      // Store successful app navigation as the main shell.
      await safeCachePut(
        SHELL_CACHE,
        INDEX_URL,
        response
      );
    }

    return response;
  } catch {
    return await offlineFallback(request);
  }
}

/* ---------- STATIC ASSETS: STALE WHILE REVALIDATE ---------- */

async function handleStaticAsset(request) {
  const cached = await safeCacheMatch(
    ASSET_CACHE,
    request
  );

  if (cached) {
    // Return cached asset immediately and refresh in background.
    fetchWithTimeout(request)
      .then(response =>
        safeCachePut(ASSET_CACHE, request, response)
      )
      .catch(() => {});

    return cached;
  }

  try {
    const response = await fetchWithTimeout(request);

    await safeCachePut(
      ASSET_CACHE,
      request,
      response
    );

    return response;
  } catch {
    return new Response("Asset unavailable offline.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

/* ---------- IMAGES: CACHE FIRST ---------- */

async function handleImage(request) {
  const cached = await safeCacheMatch(
    IMAGE_CACHE,
    request
  );

  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(request);

    await safeCachePut(
      IMAGE_CACHE,
      request,
      response
    );

    await trimCache(
      IMAGE_CACHE,
      MAX_IMAGE_ENTRIES
    );

    return response;
  } catch {
    return new Response("", {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}

/* ---------- REQUEST ROUTING ---------- */

self.addEventListener("fetch", event => {
  const request = event.request;

  // Never cache writes, POSTs, or other non-GET requests.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Supabase and other external services bypass this worker.
  if (
    url.origin !== self.location.origin ||
    isBackendRequest(url) ||
    isSensitiveRequest(request)
  ) {
    return;
  }

  if (!isInsideApp(url)) return;

  // Navigation requests receive the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      handleNavigation(request, event)
    );
    return;
  }

  // Never treat JSON or document responses as static assets.
  if (
    request.destination === "document" ||
    request.headers.get("Accept")?.includes("application/json")
  ) {
    return;
  }

  if (request.destination === "image") {
    event.respondWith(handleImage(request));
    return;
  }

  if (
    ["style", "script", "font", "worker"].includes(
      request.destination
    )
  ) {
    event.respondWith(handleStaticAsset(request));
  }
});

/* ---------- BACKGROUND SYNC ---------- */

const BACKGROUND_SYNC_TAG = "goldbot-background-sync";
const PERIODIC_SYNC_TAG = "goldbot-periodic-sync";

async function notifyGoldBotClients(message) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of clients) {
    client.postMessage(message);
  }

  return clients.length;
}

async function refreshAppShell() {
  try {
    const response = await fetch(
      new Request(INDEX_URL, {
        cache: "reload",
        credentials: "same-origin"
      })
    );

    if (isCacheableResponse(response)) {
      await safeCachePut(
        SHELL_CACHE,
        INDEX_URL,
        response
      );

      return true;
    }
  } catch (error) {
    console.warn(
      "[GoldBot-ZA] Background shell refresh failed:",
      error
    );
  }

  return false;
}

/*
 * Background Sync:
 * Ask the app to retry its own pending, safely queued operations.
 * The app must implement idempotent retries for journal writes.
 */
self.addEventListener("sync", event => {
  if (event.tag === BACKGROUND_SYNC_TAG) {
    event.waitUntil((async () => {
      await notifyGoldBotClients({
        type: "GOLDBOT_BACKGROUND_SYNC",
        action: "RETRY_PENDING_OPERATIONS"
      });

      // Refresh the app shell as an additional safe task.
      await refreshAppShell();
    })());
  }
});

/*
 * Periodic Background Sync:
 * Refresh the app shell and notify open app windows to fetch
 * fresh prices, analysis, signals and performance from Supabase.
 * Never cache these live API responses in the service worker.
 */
self.addEventListener("periodicsync", event => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil((async () => {
      await refreshAppShell();

      await notifyGoldBotClients({
        type: "GOLDBOT_PERIODIC_SYNC",
        action: "REFRESH_LIVE_DATA"
      });
    })());
  }
});

/* ---------- APP COMMUNICATION ---------- */

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }

  if (event.data?.type === "CLEAR_IMAGE_CACHE") {
    event.waitUntil(caches.delete(IMAGE_CACHE));
  }

  if (event.data?.type === "GET_VERSION") {
    event.source?.postMessage({
      type: "GOLDBOT_SW_VERSION",
      version: VERSION
    });
  }
});


/* ---------- PUSH NOTIFICATIONS ---------- */

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};

    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {
        title: "GoldBot-ZA",
        body: event.data?.text() || "You have a new notification."
      };
    }

    const title = data.title || "GoldBot-ZA Signal";
    const options = {
      body: data.body || "A new gold trading signal is available.",
      icon: new URL("./icons/icon-192.png", self.registration.scope).href,
      badge: new URL("./icons/icon-192.png", self.registration.scope).href,
      tag: data.signal_key || "goldbot-signal",
      renotify: false,
      data: {
        url: data.url || "./",
        signal_key: data.signal_key || null
      }
    };

    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "./",
    self.registration.scope
  ).href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of clients) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        client.postMessage({
          type: "GOLDBOT_NOTIFICATION_CLICK",
          signal_key: event.notification.data?.signal_key || null
        });
        return;
      }
    }

    await self.clients.openWindow(targetUrl);
  })());
});

