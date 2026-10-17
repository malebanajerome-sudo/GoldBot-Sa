
importScripts(
  "https://storage.googleapis.com/workbox-cdn/releases/7.3.0/workbox-sw.js"
);

if (workbox) {
  workbox.setConfig({ debug: false });

  const { registerRoute } = workbox.routing;
  const { NetworkFirst, CacheFirst } = workbox.strategies;
  const { ExpirationPlugin } = workbox.expiration;

  registerRoute(
    ({ request, url }) =>
      url.origin === self.location.origin &&
      url.pathname === "/GoldBot-Sa/" &&
      request.mode === "navigate",
    new NetworkFirst({
      cacheName: "goldbot-app-shell",
      networkTimeoutSeconds: 4
    })
  );

  registerRoute(
    ({ request, url }) =>
      url.origin === self.location.origin &&
      /\.(png|jpg|jpeg|svg|webp)$/i.test(url.pathname),
    new CacheFirst({
      cacheName: "goldbot-images",
      plugins: [
        new ExpirationPlugin({
          maxEntries: 30,
          maxAgeSeconds: 30 * 24 * 60 * 60
        })
      ]
    })
  );
}
