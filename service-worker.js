/**
 * SingWell service worker for offline support.
 *
 * Caches all app assets on install so the app works offline.
 * Uses a cache-first strategy for app shell resources and
 * network-first for everything else.
 */

const CACHE_NAME = 'singwell-v4';
// Use relative paths so the SW works whether the app is hosted at the
// root of a domain or inside a subdirectory (e.g. /SingWell/).
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/audio-engine.js',
  './js/exercises.js',
  './js/feedback.js',
  './js/formant-analyzer.js',
  './js/pitch-detector.js',
  './js/profile.js',
  './js/visualizer.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful same-origin responses
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
