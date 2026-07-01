// Self-destructing service worker. Earlier builds shipped a caching SW that
// served stale JS bundles across deploys (hard refresh didn't help, because a
// controlling SW intercepts the request). This no-op replaces it: on activate
// it clears all caches, unregisters itself, and reloads open clients so they
// fetch the latest deploy directly from the network. The app no longer
// registers any SW (see main.tsx).
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        // Reload each open tab so it drops this SW and loads fresh assets.
        client.navigate(client.url);
      }
    })(),
  );
});

// No fetch handler — requests go straight to the network.
