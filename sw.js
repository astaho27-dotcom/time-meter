// 시간 계량기 — offline shell. Bump V when files change.
const V='tm-v4',FONTS='tm-fonts';
const SHELL=['./','./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V&&k!==FONTS).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const url=new URL(r.url);
  if(url.origin===self.location.origin){
    // stale-while-revalidate: open instantly, pick up updates on the next launch
    e.respondWith(caches.open(V).then(async c=>{
      const hit=await c.match(r,{ignoreSearch:true});
      const net=fetch(r).then(res=>{if(res&&res.ok)c.put(r,res.clone());return res}).catch(()=>hit);
      return hit||net;
    }));
  }else if(/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    e.respondWith(caches.open(FONTS).then(async c=>{
      const hit=await c.match(r);if(hit)return hit;
      const res=await fetch(r);c.put(r,res.clone());return res;
    }));
  }
});
