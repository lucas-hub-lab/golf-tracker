// ─── Golf Companion Service Worker ───────────────────────────────────
// Handles: offline caching, background sync, install prompt

const CACHE_NAME = "golf-companion-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/static/js/main.chunk.js",
  "/static/js/bundle.js",
  "/static/css/main.chunk.css",
  "/manifest.json",
  "https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap"
];

// ─── INSTALL: cache static assets ────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache what we can; ignore failures for external fonts etc.
      return Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: clean old caches ──────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH: cache-first for static, network-first for API ────────────
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Supabase API calls: network first, don't cache
  if (url.hostname.includes("supabase.co")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    return;
  }

  // Google Fonts: cache first
  if (url.hostname.includes("fonts.g")) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return resp;
      }))
    );
    return;
  }

  // App shell: cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp.ok && event.request.method === "GET") {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      }).catch(() =>
        // Fallback to index.html for navigation requests (SPA)
        event.request.mode === "navigate"
          ? caches.match("/index.html")
          : new Response("Offline", { status: 503 })
      );
    })
  );
});

// ─── BACKGROUND SYNC: flush queue when online ────────────────────────
self.addEventListener("sync", event => {
  if (event.tag === "golf-sync") {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(client => client.postMessage({ type: "SYNC_REQUESTED" }))
      )
    );
  }
});

// ─── PUSH NOTIFICATIONS (optional, future use) ───────────────────────
self.addEventListener("push", event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || "Golf Companion", {
    body: data.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "golf-notification"
  });
});
