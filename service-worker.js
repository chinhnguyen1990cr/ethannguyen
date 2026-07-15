const CACHE_NAME = 'ren-luyen-cache-v6';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './nhua.html'];
// Giới hạn thời gian chờ mạng khi mở app (navigate). Nếu mạng chậm/treo lâu hơn mức này,
// lập tức trả bản đã lưu trong cache để app luôn mở ra ngay — tránh kẹt ở màn hình splash
// (đây là nguyên nhân khiến trước đây phải gỡ cài đặt rồi cài lại app mới mở được).
const NAV_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // QUAN TRỌNG — NGUYÊN NHÂN GỐC của lỗi "bấm đồng bộ vẫn tải ảnh cũ":
  // Trước đây Service Worker áp dụng cache-first cho MỌI request không phải điều hướng HTML,
  // kể cả các request gọi Google Drive API (googleapis.com) — vì URL tải file Drive
  // (.../files/{fileId}?alt=media) không đổi giữa các lần gọi, nên sau lần đầu tiên,
  // Service Worker luôn trả lại bản PHẢN HỒI CŨ đã cache thay vì thực sự gọi lại Drive,
  // dù người dùng bấm "đồng bộ lại" bao nhiêu lần và dữ liệu trên Drive đã thay đổi.
  // => Chỉ can thiệp cache cho tài nguyên CÙNG GỐC (index.html, icon, manifest...); mọi request
  // khác gốc (Drive API, v.v.) phải luôn đi thẳng ra mạng, không qua Service Worker.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const isHTML = req.mode === 'navigate' || (req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html'));

  if (isHTML) {
    // Network-first có giới hạn thời gian: cố lấy bản mới nhất, nhưng nếu mạng không phản hồi
    // kịp trong NAV_TIMEOUT_MS thì dùng ngay bản cache để mở app tức thì, không bị treo splash.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedFallback = (await cache.match(req)) || (await cache.match('./index.html'));
      try {
        const networkResponse = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('nav-timeout')), NAV_TIMEOUT_MS))
        ]);
        cache.put(req, networkResponse.clone());
        return networkResponse;
      } catch (e) {
        if (cachedFallback) return cachedFallback;
        // Không có cache lẫn mạng chưa kịp trả lời — thử fetch bình thường (không giới hạn) làm phương án cuối.
        return fetch(req);
      }
    })());
    return;
  }

  // Cache-first for static assets (icons, manifest) — these rarely change and benefit from speed/offline.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((networkResponse) => {
        if (req.method === 'GET' && networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      });
    })
  );
});
