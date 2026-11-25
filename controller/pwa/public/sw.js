const CACHE = "adarsh-controller-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("adarsh-controller-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Never cache Supabase, bearer requests, private JSON, pairing codes or sessions.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    request.headers.has("Authorization") ||
    url.pathname.startsWith("/api/") ||
    url.search
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }
  if (
    !SHELL.includes(url.pathname) &&
    !/^\/assets\/[^/]+\.(js|css|woff2)$/.test(url.pathname)
  )
    return;
  event.respondWith(
    caches.match(request).then(
      (found) =>
        found ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
