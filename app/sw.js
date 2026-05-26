/* ============================================
   GmI 클랜 서비스 워커 (PWA)
   - 정적 자산 캐싱 (네비게이션 빠르게)
   - API는 항상 네트워크 (실시간 데이터)
   ============================================ */

const CACHE_VERSION = "gmi-v4";
const STATIC_ASSETS = [
  "index.html",
  "casino.html",
  "duel.html",
  "matches.html",
  "holdem.html",
  "htable.html",
  "crash.html",
  "login.html",
  "style.css?v=2",
  "holdem.css?v=1",
  "htable.css?v=1",
  "crash.css?v=1",
  "casino.css?v=1",
  "app.js?v=4",
  "holdem.js?v=1",
  "htable.js?v=1",
  "crash.js?v=1",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // API 호출은 캐시 안 함 (실시간 데이터)
  if (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/auth/") ||
      url.host.includes("railway.app") ||
      url.host.includes("localhost")) {
    return;  // 기본 fetch 동작
  }

  // 정적 자산은 cache-first
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // 새 자산도 캐시에 추가
        if (res.ok && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(cache =>
            cache.put(e.request, clone)
          );
        }
        return res;
      }).catch(() => {
        // 오프라인 fallback
        if (e.request.mode === "navigate") {
          return caches.match("index.html");
        }
      });
    })
  );
});
