
// Minimal Service Worker
// Purpose: Enable install as PWA
// No data caching, no storage of user data

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Always fetch from network – no caching
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
