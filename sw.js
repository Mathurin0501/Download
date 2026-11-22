const CACHE='transfert-qr-v5';
const FILES=['./','./index.html','./robust-transfer.js','./manifest.webmanifest'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('transfert-qr-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()]));
});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{
    if(res.ok){const copy=res.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(r,copy)));}
    return res;
  }).catch(()=>caches.match(r)));
});
