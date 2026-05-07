// ═══════════════════════════════════════════════════════════════
//  db.js — IndexedDB 本機資料層
//  負責：離線暫存今日飲食、快取食物資料庫、儲存使用者設定
// ═══════════════════════════════════════════════════════════════

const DB_NAME    = "foodlog";
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      // 本機飲食紀錄（離線用）
      if (!db.objectStoreNames.contains("logs")) {
        const store = db.createObjectStore("logs", { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
      }
      // 食物資料庫快取
      if (!db.objectStoreNames.contains("foods")) {
        db.createObjectStore("foods", { keyPath: "name" });
      }
      // 使用者設定
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
      // 待同步佇列
      if (!db.objectStoreNames.contains("syncQueue")) {
        db.createObjectStore("syncQueue", { keyPath: "qid", autoIncrement: true });
      }
    };

    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

// ── 飲食紀錄 ──────────────────────────────────────────────────

async function dbSaveLog(log) {
  const db = await openDB();
  return tx(db, "logs", "readwrite", s => s.put(log));
}

async function dbGetLogsByDate(date) {
  const db = await openDB();
  return new Promise(async (res, rej) => {
    const db_ = await openDB();
    const t   = db_.transaction("logs", "readonly");
    const idx = t.objectStore("logs").index("date");
    const req = idx.getAll(IDBKeyRange.only(date));
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbDeleteLog(id) {
  const db = await openDB();
  return tx(db, "logs", "readwrite", s => s.delete(id));
}

async function dbClearOldLogs(keepDays = 7) {
  const db      = await openDB();
  const cutoff  = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutDate = cutoff.toISOString().slice(0, 10);

  return new Promise((res, rej) => {
    const t   = db.transaction("logs", "readwrite");
    const idx = t.objectStore("logs").index("date");
    const req = idx.openCursor(IDBKeyRange.upperBound(cutDate, true));
    let   del = 0;
    req.onsuccess = e => {
      const cur = e.target.result;
      if (cur) { cur.delete(); del++; cur.continue(); }
      else res(del);
    };
    req.onerror = e => rej(e.target.error);
  });
}

// ── 食物資料庫 ─────────────────────────────────────────────────

async function dbSaveFoods(foods) {
  const db = await openDB();
  const t  = db.transaction("foods", "readwrite");
  const s  = t.objectStore("foods");
  foods.forEach(f => s.put(f));
  return new Promise((res, rej) => {
    t.oncomplete = () => res(foods.length);
    t.onerror    = e => rej(e.target.error);
  });
}

async function dbSearchFood(query) {
  const db  = await openDB();
  const all = await tx(db, "foods", "readonly", s => s.getAll());
  return all.filter(f => f.name && f.name.includes(query));
}

async function dbGetFood(name) {
  const db = await openDB();
  return tx(db, "foods", "readonly", s => s.get(name));
}

// ── 使用者設定 ─────────────────────────────────────────────────

async function dbGetSetting(key) {
  const db = await openDB();
  return tx(db, "settings", "readonly", s => s.get(key));
}

async function dbSetSetting(key, value) {
  const db = await openDB();
  return tx(db, "settings", "readwrite", s => s.put(value, key));
}

async function dbGetAllSettings() {
  const db   = await openDB();
  const keys = await tx(db, "settings", "readonly", s => s.getAllKeys());
  const vals = await tx(db, "settings", "readonly", s => s.getAll());
  const map  = {};
  keys.forEach((k, i) => { map[k] = vals[i]; });
  return map;
}

// ── 同步佇列 ──────────────────────────────────────────────────

async function dbEnqueue(item) {
  const db = await openDB();
  return tx(db, "syncQueue", "readwrite", s => s.add({ ...item, ts: Date.now() }));
}

async function dbGetQueue() {
  const db = await openDB();
  return tx(db, "syncQueue", "readonly", s => s.getAll());
}

async function dbDequeue(qid) {
  const db = await openDB();
  return tx(db, "syncQueue", "readwrite", s => s.delete(qid));
}

// ── 工具 ──────────────────────────────────────────────────────

function tx(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const t   = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// 導出（非 module 環境用 window 掛載）
window.DB = {
  saveLog: dbSaveLog, getLogsByDate: dbGetLogsByDate,
  deleteLog: dbDeleteLog, clearOldLogs: dbClearOldLogs,
  saveFoods: dbSaveFoods, searchFood: dbSearchFood, getFood: dbGetFood,
  getSetting: dbGetSetting, setSetting: dbSetSetting, getAllSettings: dbGetAllSettings,
  enqueue: dbEnqueue, getQueue: dbGetQueue, dequeue: dbDequeue
};
