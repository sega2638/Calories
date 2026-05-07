// ═══════════════════════════════════════════════════════════════
//  app.js — 食物追蹤 PWA 主邏輯
// ═══════════════════════════════════════════════════════════════

// ── 工具 ──────────────────────────────────────────────────────
function today() {
  return new Date().toLocaleDateString("zh-TW", {
    year:"numeric", month:"2-digit", day:"2-digit", timeZone:"Asia/Taipei"
  }).replace(/\//g, "-");
}

function toast(msg, dur = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), dur);
}

function $(id) { return document.getElementById(id); }

// ── 頁面路由 ──────────────────────────────────────────────────
const pages = { home: "page-home", camera: "page-camera", report: "page-report", setting: "page-setting" };
const titles = { home: "今日飲食", camera: "拍照記錄", report: "每日報告", setting: "設定" };

function navigate(name) {
  Object.values(pages).forEach(id => document.getElementById(id).classList.remove("active"));
  document.getElementById(pages[name]).classList.add("active");
  document.querySelectorAll(".nav-item[data-page]").forEach(b => {
    b.classList.toggle("active", b.dataset.page === name);
  });
  $("page-title").textContent = titles[name];
  if (name === "home")    loadHome();
  if (name === "report")  loadReport();
  if (name === "setting") loadSettings();
}

document.querySelectorAll(".nav-item[data-page]").forEach(btn => {
  btn.addEventListener("click", () => navigate(btn.dataset.page));
});

// ── 日期顯示 ──────────────────────────────────────────────────
function initDateLabel() {
  const d = new Date();
  $("today-label").textContent = d.toLocaleDateString("zh-TW", {
    month: "long", day: "numeric", weekday: "short"
  });
}

// ── 首頁：載入今日紀錄 ────────────────────────────────────────
let _todayData = null;

async function loadHome() {
  try {
    const data = await API.getLogs(today());
    _todayData = data;
    renderRing(data.total, await getGoalCal());
    renderLogList(data.logs);
  } catch (e) {
    toast("⚠️ 載入失敗：" + e.message);
  }
}

async function getGoalCal() {
  const v = await DB.getSetting("每日目標熱量(kcal)");
  return Number(v) || 1800;
}

function renderRing(total, goal) {
  const pct    = Math.min((total.calories || 0) / goal, 1);
  const circum = 2 * Math.PI * 42;
  $("ring-progress").style.strokeDashoffset = circum * (1 - pct);
  $("total-kcal").textContent    = Math.round(total.calories || 0);
  $("total-protein").textContent = (total.protein || 0).toFixed(1);
  $("total-carbs").textContent   = (total.carbs   || 0).toFixed(1);
  $("total-fat").textContent     = (total.fat     || 0).toFixed(1);
  $("goal-label").textContent    = `目標 ${goal} kcal`;
}

const MEAL_EMOJI = { 早餐:"🌅", 午餐:"☀️", 晚餐:"🌙", 點心:"🍪" };
const MEAL_ORDER = ["早餐","午餐","點心","晚餐"];

function renderLogList(logs) {
  const container = $("log-list");
  if (!logs || logs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🍱</div><p>今天還沒有飲食紀錄<br>點擊下方相機開始拍照</p></div>`;
    return;
  }
  // 按餐別分組
  const groups = {};
  logs.forEach(l => { (groups[l.meal] = groups[l.meal] || []).push(l); });

  container.innerHTML = MEAL_ORDER
    .filter(m => groups[m])
    .map(meal => `
      <div class="meal-section">
        <div class="meal-title">${MEAL_EMOJI[meal] || "🍽"} ${meal}</div>
        <div class="card" style="padding:0 20px">
          ${groups[meal].map(l => `
            <div class="log-item" data-id="${l.id}">
              <div class="log-icon">${foodEmoji(l.food)}</div>
              <div class="log-info">
                <div class="log-name">${l.food}</div>
                <div class="log-meta">${l.weight}g・${l.time}</div>
              </div>
              <div class="log-kcal">${Math.round(l.calories)} kcal</div>
              <button class="log-del" onclick="deleteLog('${l.id}')" aria-label="刪除">✕</button>
            </div>
          `).join("")}
        </div>
      </div>
    `).join("");
}

function foodEmoji(name) {
  const map = { 白飯:"🍚", 糙米飯:"🍚", 麵:"🍜", 麵條:"🍜", 便當:"🍱", 雞:"🍗", 豬:"🥩",
    牛:"🥩", 魚:"🐟", 蛋:"🥚", 豆腐:"🧇", 沙拉:"🥗", 花椰菜:"🥦", 番茄:"🍅",
    香蕉:"🍌", 蘋果:"🍎", 橘:"🍊", 牛奶:"🥛", 優格:"🥛", 咖啡:"☕" };
  for (const [k, v] of Object.entries(map)) if (name.includes(k)) return v;
  return "🍽";
}

window.deleteLog = async function(id) {
  if (!confirm("確定刪除這筆紀錄？")) return;
  try {
    await API.deleteLog(id);
    toast("✓ 已刪除");
    loadHome();
  } catch(e) { toast("刪除失敗：" + e.message); }
};

// ── 拍照頁面 ──────────────────────────────────────────────────
let _stream = null;
let _capturedBase64 = null;
let _detectedFoods  = null;
let _currentMeal    = guessMeal();

function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return "早餐";
  if (h < 14) return "午餐";
  if (h < 17) return "點心";
  return "晚餐";
}

$("open-camera-btn").addEventListener("click", openCamera);

async function openCamera() {
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    $("video-preview").srcObject = _stream;
    $("video-preview").style.display = "block";
    $("cam-placeholder").style.display = "none";
    $("shutter-btn").style.display = "flex";
    $("open-camera-btn").style.display = "none";
  } catch(e) {
    toast("無法開啟相機：" + e.message);
  }
}

$("shutter-btn").addEventListener("click", capturePhoto);

function capturePhoto() {
  const video  = $("video-preview");
  const canvas = $("capture-canvas");
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  showPhotoPreview(dataUrl);
  stopCamera();
}

$("file-input").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => showPhotoPreview(ev.target.result);
  reader.readAsDataURL(file);
});

function showPhotoPreview(dataUrl) {
  _capturedBase64 = dataUrl.split(",")[1];
  $("photo-preview").src = dataUrl;
  $("photo-preview").style.display = "block";
  $("video-preview").style.display = "none";
  $("cam-placeholder").style.display = "none";
  $("shutter-btn").style.display = "none";
  $("open-camera-btn").style.display = "none";
  $("retake-btn").style.display = "";
  $("result-area").style.display = "none";
  analyzePhoto();
}

$("retake-btn").addEventListener("click", () => {
  _capturedBase64 = null;
  _detectedFoods  = null;
  $("photo-preview").style.display = "none";
  $("cam-placeholder").style.display = "flex";
  $("open-camera-btn").style.display = "";
  $("retake-btn").style.display = "none";
  $("result-area").style.display = "none";
  $("file-input").value = "";
});

async function analyzePhoto() {
  $("analyze-loading").style.display = "flex";
  try {
    const result = await API.analyzeFood(_capturedBase64, "image/jpeg");
    _detectedFoods = result.foods;
    renderResults(result);
    $("result-area").style.display = "block";
  } catch(e) {
    toast("辨識失敗：" + e.message);
  } finally {
    $("analyze-loading").style.display = "none";
  }
}

async function renderResults(result) {
  const itemsEl = $("result-items");
  // 查詢每個食物的營養（本機優先）
  const rows = await Promise.all(result.foods.map(async f => {
    const food = await DB.getFood(f.name);
    const kcalPer100 = food ? food.calories : 150;
    const kcal = Math.round(kcalPer100 * f.weight_g / 100);
    return { ...f, kcal, kcalPer100 };
  }));

  itemsEl.innerHTML = rows.map((f, i) => `
    <div class="result-item" data-index="${i}" data-name="${f.name}">
      <div class="result-food">${foodEmoji(f.name)} ${f.name}</div>
      <input class="weight-input" type="number" value="${f.weight_g}"
             min="1" max="9999" data-kcal100="${f.kcalPer100}"
             onchange="updateResultKcal(this)"
             aria-label="${f.name} 重量">
      <span style="font-size:11px;color:var(--ink-muted)">g</span>
      <div class="result-kcal" id="kcal-${i}">${f.kcal} kcal</div>
    </div>
  `).join("");
}

window.updateResultKcal = function(input) {
  const row  = input.closest(".result-item");
  const idx  = row.dataset.index;
  const kcal = Math.round(input.dataset.kcal100 * input.value / 100);
  $(`kcal-${idx}`).textContent = kcal + " kcal";
};

$("confirm-btn").addEventListener("click", async () => {
  const rows = document.querySelectorAll(".result-item");
  if (!rows.length) return;

  $("confirm-btn").disabled = true;
  $("confirm-btn").textContent = "記錄中…";

  try {
    for (const row of rows) {
      const food   = row.dataset.name;
      const weight = Number(row.querySelector(".weight-input").value);
      await API.addLog({
        date : today(),
        time : new Date().toLocaleTimeString("zh-TW", { hour:"2-digit", minute:"2-digit", hour12:false }),
        meal : _currentMeal,
        food, weight
      });
    }
    toast("✓ 已記錄！");
    navigate("home");
    // 重置相機頁
    _capturedBase64 = null;
    $("photo-preview").style.display = "none";
    $("cam-placeholder").style.display = "flex";
    $("open-camera-btn").style.display = "";
    $("retake-btn").style.display = "none";
    $("result-area").style.display = "none";
    $("file-input").value = "";
  } catch(e) {
    toast("記錄失敗：" + e.message);
  } finally {
    $("confirm-btn").disabled = false;
    $("confirm-btn").textContent = "✓ 確認記錄";
  }
});

function stopCamera() {
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
}

// ── 報告頁面 ──────────────────────────────────────────────────
async function loadReport() {
  try {
    const { report } = await API.getReport(today());
    if (report && report.score) {
      renderReport(report);
    }
  } catch {}
  drawMacroChart();
}

function renderReport(r) {
  $("report-content").innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:12px">
      <div class="score-badge">${"⭐".repeat(r.score)}</div>
      <span style="font-size:13px;color:var(--ink-muted)">${r.score} / 5</span>
    </div>
    <div class="report-section">
      <h4>今日評價</h4>
      <p>${r.suggestion || "（暫無評價）"}</p>
    </div>
    <button class="gen-btn mt-12" onclick="genReport()">🔄 重新產生報告</button>
  `;
}

window.genReport = async function() {
  const btn = document.querySelector(".gen-btn");
  if (btn) { btn.disabled = true; btn.textContent = "🤖 AI 分析中…"; }
  try {
    const { report } = await API.generateReport(today());
    renderReport(report);
    toast("✓ 報告產生完成");
  } catch(e) {
    toast("產生失敗：" + e.message);
    if (btn) { btn.disabled = false; btn.textContent = "🤖 產生今日 AI 建議報告"; }
  }
};

$("gen-report-btn")?.addEventListener("click", genReport);

function drawMacroChart() {
  const canvas = $("macro-chart");
  if (!canvas || !_todayData) return;
  const ctx  = canvas.getContext("2d");
  const t    = _todayData.total;
  const data = [t.protein*4, t.carbs*4, t.fat*9];  // 換算 kcal
  const cols = ["#74C69D", "#FFD166", "#EF476F"];
  const labels = ["蛋白質", "碳水", "脂肪"];
  const total = data.reduce((a,b)=>a+b,0) || 1;
  const W = canvas.width = canvas.offsetWidth;
  const H = canvas.height = 160;
  let angle = -Math.PI / 2;
  const cx = 70, cy = 80, r = 60;

  ctx.clearRect(0, 0, W, H);
  data.forEach((v, i) => {
    const slice = (v / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = cols[i];
    ctx.fill();
    angle += slice;
  });
  // 圓洞
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, 2 * Math.PI);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();

  // 圖例
  labels.forEach((l, i) => {
    const y = 40 + i * 36;
    ctx.fillStyle = cols[i];
    ctx.beginPath(); ctx.roundRect(W/2+10, y-10, 14, 14, 3); ctx.fill();
    ctx.fillStyle = "#1A1A18";
    ctx.font = "500 13px 'DM Sans', sans-serif";
    ctx.fillText(l, W/2+30, y+2);
    ctx.fillStyle = "#6B6B67";
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.fillText(Math.round(data[i]) + " kcal", W/2+30, y+16);
  });
}

// ── 設定頁面 ──────────────────────────────────────────────────
async function loadSettings() {
  const s = await DB.getAllSettings();
  const map = {
    "s-goal-cal"  : "每日目標熱量(kcal)",
    "s-goal-type" : "目標類型",
    "s-gemini-key": "Gemini API Key",
    "s-script-url": "Apps Script URL",
    "s-name"      : "姓名 / 暱稱",
    "s-protein"   : "蛋白質目標(g)"
  };
  for (const [elId, key] of Object.entries(map)) {
    const el = $(elId);
    if (el && s[key] !== undefined) el.value = s[key];
  }
}

$("save-settings-btn").addEventListener("click", async () => {
  const map = {
    "s-goal-cal"  : "每日目標熱量(kcal)",
    "s-goal-type" : "目標類型",
    "s-gemini-key": "Gemini API Key",
    "s-script-url": "Apps Script URL",
    "s-name"      : "姓名 / 暱稱",
    "s-protein"   : "蛋白質目標(g)"
  };
  for (const [elId, key] of Object.entries(map)) {
    const el = $(elId);
    if (el) {
      await DB.setSetting(key, el.value);
      if (navigator.onLine) {
        try { await API.updateSetting(key, el.value); } catch {}
      }
    }
  }
  toast("✓ 設定已儲存");
});

// ── 離線狀態偵測 ──────────────────────────────────────────────
function updateOnlineStatus() {
  document.body.classList.toggle("offline", !navigator.onLine);
}
window.addEventListener("online",  () => { updateOnlineStatus(); toast("✓ 網路已恢復，同步中…"); });
window.addEventListener("offline", () => { updateOnlineStatus(); toast("⚠️ 離線模式"); });

window.addEventListener("foodlog:synced", e => {
  toast(`✓ 已同步 ${e.detail.synced} 筆離線紀錄`);
  loadHome();
});

// ── Service Worker 註冊 ───────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then(reg => {
        console.log("[SW] 已註冊", reg.scope);
        // 監聽 SW 訊息（離線同步完成）
        navigator.serviceWorker.addEventListener("message", e => {
          if (e.data?.type === "SYNC_COMPLETE") {
            toast(`✓ 離線紀錄已同步 ${e.data.synced} 筆`);
            loadHome();
          }
        });
      })
      .catch(err => console.warn("[SW] 註冊失敗", err));
  });
}

// ── 初始化 ────────────────────────────────────────────────────
async function init() {
  initDateLabel();
  updateOnlineStatus();
  await API.syncFoodDB().catch(() => {});
  loadHome();
  // 啟動時清理舊資料
  await DB.clearOldLogs(14).catch(() => {});
}

init();
