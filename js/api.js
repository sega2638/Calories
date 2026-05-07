// ═══════════════════════════════════════════════════════════════
//  api.js — Apps Script API 封裝層
//  所有與 Google Sheets 的通訊都經過這裡
// ═══════════════════════════════════════════════════════════════

const API = (() => {
  let _baseUrl = "";

  async function _init() {
    _baseUrl = await DB.getSetting("appsScriptUrl") || "";
  }

  function _today() {
    return new Date().toLocaleDateString("zh-TW", {
      year: "numeric", month: "2-digit", day: "2-digit",
      timeZone: "Asia/Taipei"
    }).replace(/\//g, "-");
  }

  // ── 基礎請求 ──────────────────────────────────────────────

  async function _get(params) {
    if (!_baseUrl) await _init();
    if (!_baseUrl) throw new Error("尚未設定 Apps Script URL");
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(`${_baseUrl}?${qs}`);
    const json = await res.json();
    if (json.status === "error") throw new Error(json.message);
    return json.data;
  }

  async function _post(body) {
    if (!_baseUrl) await _init();
    if (!_baseUrl) throw new Error("尚未設定 Apps Script URL");
    const res = await fetch(_baseUrl, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(body)
    });
    const json = await res.json();
    // 離線佇列回應
    if (json.status === "queued") return { queued: true, message: json.message };
    if (json.status === "error")  throw new Error(json.message);
    return json.data;
  }

  // ── 飲食紀錄 ──────────────────────────────────────────────

  async function getLogs(date = _today()) {
    try {
      const data = await _get({ action: "getLogs", date });
      // 同步到本機 IndexedDB
      if (data.logs) {
        for (const log of data.logs) await DB.saveLog(log);
      }
      return data;
    } catch (err) {
      // 離線 fallback：從本機讀取
      console.warn("[API] getLogs 離線，讀取本機資料", err.message);
      const logs  = await DB.getLogsByDate(date);
      const total = logs.reduce((acc, l) => ({
        calories: +(acc.calories + (l.calories||0)).toFixed(1),
        protein : +(acc.protein  + (l.protein ||0)).toFixed(1),
        carbs   : +(acc.carbs    + (l.carbs   ||0)).toFixed(1),
        fat     : +(acc.fat      + (l.fat     ||0)).toFixed(1)
      }), { calories:0, protein:0, carbs:0, fat:0 });
      return { date, logs, total, offline: true };
    }
  }

  async function addLog(payload) {
    // 先寫本機
    const tempId = "TMP" + Date.now();
    await DB.saveLog({ id: tempId, ...payload, _pending: true });

    try {
      const data = await _post({ action: "addLog", ...payload });
      // 成功：更新本機 id
      await DB.deleteLog(tempId);
      await DB.saveLog({ id: data.id, ...payload, _pending: false });
      return data;
    } catch (err) {
      if (!navigator.onLine) {
        await DB.enqueue({ action: "addLog", ...payload, tempId });
        return { queued: true, tempId };
      }
      throw err;
    }
  }

  async function updateLog(payload) {
    try {
      return await _post({ action: "updateLog", ...payload });
    } catch (err) {
      if (!navigator.onLine) {
        await DB.enqueue({ action: "updateLog", ...payload });
        return { queued: true };
      }
      throw err;
    }
  }

  async function deleteLog(id) {
    await DB.deleteLog(id);
    try {
      return await _post({ action: "deleteLog", id });
    } catch (err) {
      if (!navigator.onLine) {
        await DB.enqueue({ action: "deleteLog", id });
        return { queued: true };
      }
      throw err;
    }
  }

  // ── 食物資料庫 ─────────────────────────────────────────────

  async function searchFood(query) {
    // 先查本機快取
    const local = await DB.searchFood(query);
    if (local.length > 0) return local;
    // 沒有再查遠端
    try {
      const data = await _get({ action: "getFoodDB", q: query });
      if (data.results?.length) await DB.saveFoods(data.results);
      return data.results || [];
    } catch {
      return [];
    }
  }

  async function syncFoodDB() {
    try {
      const data = await _get({ action: "getFoodDB", q: "" });
      if (data.results?.length) {
        await DB.saveFoods(data.results);
        return data.results.length;
      }
      return 0;
    } catch (err) {
      console.warn("[API] 食物資料庫同步失敗", err.message);
      return 0;
    }
  }

  // ── 報告 ──────────────────────────────────────────────────

  async function getReport(date = _today()) {
    return _get({ action: "getReport", date });
  }

  async function generateReport(date = _today()) {
    return _post({ action: "generateReport", date });
  }

  async function getDailySummary(date = _today()) {
    return _get({ action: "dailySummary", date });
  }

  // ── 設定 ──────────────────────────────────────────────────

  async function getSettings() {
    try {
      const data = await _get({ action: "getSettings" });
      // 快取到本機
      for (const [k, v] of Object.entries(data)) await DB.setSetting(k, v);
      return data;
    } catch {
      return await DB.getAllSettings();
    }
  }

  async function updateSetting(key, value) {
    await DB.setSetting(key, value);
    if (key === "Apps Script URL") { _baseUrl = value; }
    return _post({ action: "updateSetting", key, value });
  }

  // ── 離線佇列重送 ──────────────────────────────────────────

  async function flushQueue() {
    const queue = await DB.getQueue();
    if (!queue.length) return 0;
    let synced = 0;
    for (const item of queue) {
      try {
        await _post(item);
        await DB.dequeue(item.qid);
        synced++;
      } catch { /* 保留，下次再試 */ }
    }
    return synced;
  }

  // ── Gemini Vision（前端直接呼叫）────────────────────────────

  async function analyzeFood(base64Image, mimeType = "image/jpeg") {
    const apiKey = await DB.getSetting("Gemini API Key") || "";
    if (!apiKey) throw new Error("請先在設定頁填入 Gemini API Key");

    const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          {
            inline_data: { mime_type: mimeType, data: base64Image }
          },
          {
            text: `請辨識這張照片中的食物，以繁體中文 JSON 格式回覆（不要其他文字）：
{
  "foods": [
    {
      "name": "食物名稱",
      "weight_g": 估算克數(整數),
      "confidence": 0到1的信心度
    }
  ],
  "scene": "整體場景描述一句話"
}`
          }
        ]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
    };

    const res  = await fetch(url, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(body)
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);

    const text = json.candidates[0].content.parts[0].text
                   .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(text);
  }

  return {
    getLogs, addLog, updateLog, deleteLog,
    searchFood, syncFoodDB,
    getReport, generateReport, getDailySummary,
    getSettings, updateSetting,
    flushQueue, analyzeFood,
    today: _today
  };
})();

// 上線時自動重送離線佇列
window.addEventListener("online", async () => {
  const synced = await API.flushQueue();
  if (synced > 0) {
    window.dispatchEvent(new CustomEvent("foodlog:synced", { detail: { synced } }));
  }
});
