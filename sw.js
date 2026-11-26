/* Minimální service worker: uloží základ aplikace (HTML/CSS/JS/ikony) pro rychlé
   spuštění. Mapové dlaždice, routing a GeoJSON jdou vždy přes síť. */
const CACHE = 'cykloplanovac-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (event) {
    event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.geojson')) { return; }
    // Nejdřív síť (aktuální verze), při výpadku uložená kopie.
    event.respondWith(
        fetch(req).then(function (res) {
            const copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
            return res;
        }).catch(function () { return caches.match(req); })
    );
});
