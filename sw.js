/* Service worker: makes the app installable and lets it open with no signal.

   Network-first, not cache-first. The original cache-first version meant a
   device that had loaded the app once kept serving that copy forever —
   redeploys were invisible, which made it look like fixes hadn't shipped.
   Now the network wins whenever it's reachable and the cache is only a
   fallback, so the app is still fully usable offline. */

const CACHE = "today-v3";
const SHELL = [
  "./",
  "./index.html",
  "./sync.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch Firebase traffic

  /* Bypass the browser's HTTP cache explicitly. GitHub Pages serves these
     files with a 10-minute max-age, so a plain fetch() here still returned a
     stale copy after a redeploy — which repeatedly looked like fixes hadn't
     shipped. The service worker's own cache below still covers offline. */
  e.respondWith(
    fetch(req.url, { cache: "no-store", credentials: "same-origin" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
