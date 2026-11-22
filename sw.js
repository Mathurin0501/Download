/* Transfert QR : mise a jour automatique pour le site et l'application installee.
   Conserve l'interface, les transferts et l'historique (localStorage) intacts. */
const CACHE = 'transfert-qr-v6-20261122';
const APP_ASSETS = ['./', './index.html', './robust-transfer.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CHECK_ASSETS = ['./index.html', './robust-transfer.js'];
const appURL = path => new URL(path, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_ASSETS);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('transfert-qr-') && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Sur GitHub Pages, toujours privilegier le reseau quand il est disponible.
// Ne sert depuis le cache que pour une ouverture hors ligne.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res.ok) {
        const cache = await caches.open(CACHE);
        event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(req, { ignoreSearch: true });
      if (saved) return saved;
      if (req.mode === 'navigate') {
        const fallback = await cache.match(appURL('./index.html'));
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

// Compare les fichiers qui composent l'application aux versions publiees.
// Ceci continue de fonctionner si, lors d'une prochaine publication, seul index.html
// ou robust-transfer.js est modifie sans changer le nom du cache/service worker.
let checkingAssets = null;
async function checkForChangedAssets() {
  if (checkingAssets) return checkingAssets;
  checkingAssets = (async () => {
    const cache = await caches.open(CACHE);
    let changed = false;
    for (const path of CHECK_ASSETS) {
      const url = appURL(path);
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const old = await cache.match(url);
        if (old && (await old.text()) !== (await res.clone().text())) changed = true;
        await cache.put(url, res.clone());
      } catch (_) { /* Pas de reseau : ne pas annoncer de mise a jour imaginaire. */ }
    }
    if (changed) {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'APP_UPDATE_AVAILABLE' });
    }
  })().finally(() => { checkingAssets = null; });
  return checkingAssets;
}
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === 'CHECK_APP_ASSETS') {
    event.waitUntil(checkForChangedAssets());
  }
});
