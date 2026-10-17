
/* =========================================================
   GoldBot-ZA | Stacks Co.
   Resilient Progressive Web App Service Worker
   ========================================================= */

"use strict";

const VERSION = "goldbot-za-v3";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const IMAGE_CACHE = `${VERSION}-images`;

const APP_ROOT = new URL("./", self.registration.scope);

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const MAX_IMAGE_ENTRIES = 40;
const NETWORK_TIMEOUT_MS = 5000;

function isInsideApp(url) {
  return url.origin === APP_ROOT.origin &&
    url.pathname.startsWith(APP_ROOT.pathname);
}

function isBackendRequest(url) {
  return (
    url.hostname.endsWith(".supabase.co") ||
    url.pathname.includes("/functions/") ||
    url.pathname.includes("/rest/") ||
    url.pathname.includes("/auth/") ||
    url.pathname.includes("/storage/") ||
    url.pathname.includes("/realtime/")
  );
}

function isSensitiveRequest(request) {
  return (
    request.method !== "GET" ||
    request.headers.has("Authorization") ||
    request.headers.has("apikey") ||
    request.cache === "no-store"
  );
}

function isCacheableResponse(response) {
  return (
    response &&
    response.status === 200 &&
    response.type === "basic" &&
    !response.headers.has("Set-Cookie") &&
    response.headers.get("Cache-Control")?.includes("no-store") !== true
  );
}

async function putSafely(cacheName, request, response) {
  if (!isCacheableResponse(response)) return;

  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn("[GoldBot-ZA] Cache write failed:", error);
  }
}

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    while (keys.length > maxEntries) {
      const oldest = keys.shift();
      if (oldest) await cache.delete(oldest);
    }
  } catch (error) {
    console.warn("[GoldBot-ZA] Cache cleanup failed:", error);
  }
}

async function networkWithTimeout(request) {
  let timer;

  try {
    return await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Network timeout")),
          NETWORK_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);

    await Promise.allSettled(
      SHELL_FILES.map(async path => {
        const url = new URL(path, self.registration.scope);

        try {
          const response = await fetch(
            new Request(url, { cache: "reload" })
          );

          if (isCacheableResponse(response)) {
            await cache.put(url.href, response);
          }
        } catch (error) {
          console.warn(
            "[GoldBot-ZA] Shell asset unavailable:",
            path
          );
        }
      })
    );

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([
      SHELL_CACHE,
      ASSET_CACHE,
      IMAGE_CACHE
    ]);

    const names = await caches.keys();

    await Promise.all(
      names
        .filter(name =>
          name.startsWith("goldbot-za-") && !keep.has(name)
        )
        .map(name => caches.delete(name))
    );

    await self.clients.claim();

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windows) {
      client.postMessage({
        type: "GOLDBOT_SW_ACTIVE",
        version: VERSION
      });
    }
  })());
});

async function handleNavigation(request) {
  try {
    const response = await networkWithTimeout(request);

    if (response && response.status === 200) {
      await putSafely(
        SHELL_CACHE,
        new URL("./index.html", self.registration.scope).href,
        response
      );
    }

    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);

    return (
      await cache.match(request) ||
      await cache.match(
        new URL("./index.html", self.registration.scope).href
      ) ||
      new Response(
        "GoldBot-ZA is offline. Reconnect to load the latest app and market data.",
        {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        }
      )
    );
  }
}

async function handleStaticAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    fetch(request)
      .then(response =>
        putSafely(ASSET_CACHE, request, response)
      )
      .catch(() => {});

    return cached;
  }

  try {
    const response = await networkWithTimeout(request);

    if (isCacheableResponse(response)) {
      await putSafely(ASSET_CACHE, request, response);
    }

    return response;
  } catch {
    return new Response("Asset unavailable offline.", {
      status: 503
    });
  }
}

async function handleImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await networkWithTimeout(request);

    if (isCacheableResponse(response)) {
      await putSafely(IMAGE_CACHE, request, response);
      await trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
    }

    return response;
  } catch {
    return new Response("", { status: 503 });
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (
    url.origin !== self.location.origin ||
    isBackendRequest(url) ||
    isSensitiveRequest(request)
  ) {
    return;
  }

  if (!isInsideApp(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

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

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }

  if (event.data?.type === "CLEAR_IMAGE_CACHE") {
    event.waitUntil(caches.delete(IMAGE_CACHE));
  }
});
