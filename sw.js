const CACHE_NAME = 'spp-static-v1';
const STATIC_FILES = [
  './',
  './index.html',
  './install.html',
  './styles.css',
  './scripts.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/install-qr.png'
];
const SENSITIVE_PATH = /(?:^|\/)(?:api|login|session|token|customer)(?:\/|$)/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.search ||
      request.headers.has('Authorization') ||
      SENSITIVE_PATH.test(url.pathname)) {
    return;
  }

  const scopePath = new URL(self.registration.scope).pathname;
  const relativePath = url.pathname.slice(scopePath.length);
  const staticPath = relativePath ? `./${relativePath}` : './';
  if (!STATIC_FILES.includes(staticPath)) return;

  event.respondWith(networkFirst(request, staticPath));
});

async function networkFirst(request, staticPath) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(new URL(staticPath, self.registration.scope), { method: 'GET' });
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match(new URL('./', self.registration.scope));
      if (shell) return shell;
    }
    throw error;
  }
}
