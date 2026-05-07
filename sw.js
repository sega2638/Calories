// ═══════════════════════════════════════════════════════════════
//  Service Worker — 食物追蹤 PWA
//  策略：靜態資源 Cache First，API 請求 Network First + 離線佇列
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME    = "foodlog-v1";
const OFFLINE_QUEUE = "foodlog-offline-queue";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/app.js",
  "/js/api.js",
  "/js/db.js",
  "/manifest.json"
];

// ── Install：預快取靜態資源 ─────────────────────────────────────
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate：清除舊快取 ────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch：請求攔截策略 ─────────────────────────────────────────
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Apps Script API → Network First，失敗加入離線佇列
  if (url.hostname === "script.google.com" || url.hostname === "script.googleusercontent.com") {
    e.respondWith(networkFirstWithQueue(e.request));
    return;
  }

  // Gemini API → Network Only（不快取）
  if (url.hostname === "generativelanguage.googleapis.com") {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: "offline" }), { headers: { "Content-Type": "application/json" } })
    ));
    return;
  }

  // 靜態資源 → Cache First
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return resp;
    }))
  );
});

async function networkFirstWithQueue(request) {
  try {
    const resp = await fetch(request.clone());
    return resp;
  } catch {
    // 離線：只有 POST 才需要佇列（GET 暫時回傳快取或空值）
    if (request.method === "POST") {
      await queueRequest(request);
      return new Response(JSON.stringify({
        status : "queued",
        message: "目前離線，紀錄已暫存，上線後自動同步"
      }), { headers: { "Content-Type": "application/json" } });
    }
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ status: "offline", data: null }),
      { headers: { "Content-Type": "application/json" } });
  }
}

async function queueRequest(request) {
  const body = await request.text();
  const queue = await getQueue();
  queue.push({
    url      : request.url,
    method   : request.method,
    body,
    timestamp: Date.now()
  });
  await saveQueue(queue);
}

// ── Background Sync：上線後自動重送佇列 ────────────────────────
self.addEventListener("sync", e => {
  if (e.tag === "sync-food-logs") {
    e.waitUntil(syncOfflineQueue());
  }
});

async function syncOfflineQueue() {
  const queue = await getQueue();
  if (queue.length === 0) return;

  const remaining = [];
  for (const item of queue) {
    try {
      const resp = await fetch(item.url, {
        method  : item.method,
        body    : item.body,
        headers : { "Content-Type": "application/json" }
      });
      if (!resp.ok) remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  await saveQueue(remaining);

  // 通知主頁面同步完成
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => c.postMessage({ type: "SYNC_COMPLETE", synced: queue.length - remaining.length }));
}

// ── Push Notification：每日提醒 ────────────────────────────────
self.addEventListener("push", e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || "FoodLog 提醒", {
      body : data.body || "記得記錄今天的飲食！",
      icon : "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag  : "foodlog-reminder",
      data : { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(e.notification.data.url || "/")
  );
});

// ── IndexedDB 佇列工具 ─────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("foodlog-sw", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("queue");
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function getQueue() {
  const db  = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction("queue", "readonly");
    const req = tx.objectStore("queue").get(OFFLINE_QUEUE);
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}

async function saveQueue(queue) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction("queue", "readwrite");
    const req = tx.objectStore("queue").put(queue, OFFLINE_QUEUE);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}
