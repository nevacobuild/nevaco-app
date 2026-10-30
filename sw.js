// NEVACO Job Map service worker: always fetch the newest app files; fall back to cache only when offline
const CACHE='nevaco-v25';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
// Push notifications: new leads, replies and reminders
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'NEVACO Job Map',body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'NEVACO Job Map',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||undefined,renotify:!!d.tag,data:{url:d.url||'./'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const url=new URL(e.notification.data&&e.notification.data.url||'./',self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{for(const c of cs){if('focus' in c){return c.focus().then(w=>(w||c).navigate?(w||c).navigate(url):null).catch(()=>self.clients.openWindow(url))}}return self.clients.openWindow(url)}))});
