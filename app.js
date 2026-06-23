/* ============================================================
   Campaign Studio — outbound campaign runner
   Endpoints used:
     GET  /agents
     POST /campaigns            GET /campaigns      GET /campaigns/{id}
     POST /campaigns/{id}/pause     /resume     /stop     /cancel
   ============================================================ */

const API_BASE = "https://api.levrage.ai/v1";   // Levrage — used ONLY for call history (/calls) + agent list (/agents)
const MAX_CONCURRENT = 20; // account slots (no API for this; reference showed ~11)
const API_TOKEN = "lev_iFeIGO5CboduSWjYOp9ujzZIu_IfF-Z3X_GEg2R6KLI"; // gs pre-sales key
const SOURCE_NUMBER = "+13057034997"; // default source/caller number (batch + follow-up)
const SOURCE_NUMBERS = ["+13057034997", "00919240012505"]; // selectable source/caller numbers

// Knowlarity is reached through our own serverless proxy (browser can't call it
// directly — otpcall's CORS preflight returns 403). See api/call.js.
const KNOWLARITY_PROXY = "/api/call";
const GAP_BETWEEN_CALLS_MS = 4000; // pause between manual batch dials (Knowlarity rate-limits / 429s rapid calls)
const FOLLOWUP_LOOKBACK_MS = 5 * 60 * 1000; // follow-up scan only considers calls from the last 5 minutes

// Hardcoded follow-up rule: as soon as PCA marks interested_to_take_loan == yes,
// place the follow-up call (delay 0 — purely PCA-driven, no artificial wait).
// The follow-up target (SR number + IVR id) is NOT here — it comes from the
// per-batch "Follow-up call settings" entered at batch creation.
const HARDCODED_FOLLOWUP_RULES = [{
  field: "interested_to_take_loan",
  operator: "equals",
  value: "yes",
  delay: 0,
  unit: "seconds",
}];

// Place a Knowlarity call via the proxy. endpoint: "otpcall" (default) | "makecall".
async function knowlarityCall(params) {
  const res = await fetch(KNOWLARITY_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  let data; try { data = await res.json(); } catch { data = null; }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && (data.error || (data.error && data.error.message))) || `Knowlarity HTTP ${res.status}`);
  }
  return data;
}
// Normalize a phone number for matching (strip spaces, dashes, parens; keep leading +).
function normPhone(s) {
  if (!s) return "";
  let v = String(s).trim().replace(/[\s\-()]/g, "");
  if (v && !v.startsWith("+") && /^\d{10,}$/.test(v)) {
    if (v.length === 10) v = "+91" + v;          // bare 10-digit Indian number
    else if (/^91\d{10}$/.test(v)) v = "+" + v;  // 91XXXXXXXXXX
    else v = "+" + v;
  }
  return v;
}

const state = {
  token: API_TOKEN,
  agentId: "",
  phoneNumber: SOURCE_NUMBER,
  contacts: [],
  columns: [],
  colMap: {},
  fileName: "",
  agents: [],
  agentFields: [],   // details_to_collect of the selected batch agent
  recentNumbers: [],   // loaded per-account in refreshNumberOptions()
};
// Purge legacy global keys (stale/hardcoded values not account-scoped).
localStorage.removeItem("levrage_numbers");
localStorage.removeItem("gupshup_followups");
localStorage.removeItem("gupshup_followup_runs");

// Follow-up condition operators (kept broad — user picks)
const FU_OPERATORS = [
  { v: "equals", label: "is equal to", needsValue: true },
  { v: "not_equals", label: "is not equal to", needsValue: true },
  { v: "contains", label: "contains", needsValue: true },
  { v: "not_contains", label: "does not contain", needsValue: true },
  { v: "greater_than", label: "is greater than", needsValue: true },
  { v: "less_than", label: "is less than", needsValue: true },
  { v: "is_truthy", label: "is yes / true", needsValue: false },
  { v: "is_falsy", label: "is no / false", needsValue: false },
  { v: "is_collected", label: "was collected", needsValue: false },
  { v: "not_collected", label: "was not collected", needsValue: false },
];

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ============================================================
   Icons — Lucide SVG paths, used semantically (no emojis)
   ============================================================ */
const ICONS = {
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  sliders: '<line x1="21" y1="7" x2="11" y2="7"/><line x1="14" y1="17" x2="3" y2="17"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
  "file-spreadsheet": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  "chevron-down": '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  "arrow-left": '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  voicemail: '<circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><line x1="6" y1="16" x2="18" y2="16"/>',
  "phone-off": '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 8.63 18.42"/><path d="M5.05 5.05A19.79 19.79 0 0 0 4.11 2 2 2 0 0 1 6.11 0"/><line x1="23" y1="1" x2="1" y2="23"/>',
  "alert-triangle": '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  "x-circle": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "alert-octagon": '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  "corner-up-right": '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  "bar-chart": '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  "message-square": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  "phone-call": '<path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  "list-checks": '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
};
function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
// Replace any element with [data-icon] by its SVG (for static markup).
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    const name = el.getAttribute("data-icon");
    if (el.dataset.iconDone === name) return;
    el.innerHTML = icon(name);
    el.dataset.iconDone = name;
  });
}

function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + type;
  setTimeout(() => (t.className = "toast " + type), 3400);
}

async function api(path, { method = "GET", body } = {}) {
  if (!state.token) throw new Error("No API token set. Paste your Bearer token in the sidebar.");
  const headers = { Authorization: "Bearer " + state.token };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data; try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const d = data && data.detail;
    const msg = d ? (Array.isArray(d) ? d.map(x => `${(x.loc || []).slice(1).join(".")}: ${x.msg}`).join("; ") : d)
                  : (data && data.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(d) { if (!d) return "—"; try { return new Date(d).toLocaleString(); } catch { return d; } }
function shortId(id) { return id ? id.slice(0, 8) + "…" : ""; }

/* ============================================================
   Reusable Combobox
   opts: { placeholder, searchPlaceholder, editable, onChange(value,label) }
   ============================================================ */
function Combobox(host, opts = {}) {
  let options = [];
  let value = "", label = "";
  host.innerHTML = `
    <div class="combo-trigger placeholder"><span class="combo-label">${escapeHtml(opts.placeholder || "Select…")}</span><span class="caret">▾</span></div>
    <div class="combo-pop">
      <div class="combo-search"><input type="text" placeholder="${escapeHtml(opts.searchPlaceholder || "Search…")}" /></div>
      <div class="combo-list"></div>
    </div>`;
  const trigger = host.querySelector(".combo-trigger");
  const labelEl = host.querySelector(".combo-label");
  const pop = host.querySelector(".combo-pop");
  const search = host.querySelector(".combo-search input");
  const list = host.querySelector(".combo-list");

  function render(filter = "") {
    const f = filter.trim().toLowerCase();
    let items = options.filter(o => !f || o.label.toLowerCase().includes(f) || (o.sub || "").toLowerCase().includes(f));
    let html = items.map(o =>
      `<div class="combo-opt${o.value === value ? " active" : ""}" data-v="${escapeHtml(o.value)}">${escapeHtml(o.label)}${o.sub ? `<div class="sub">${escapeHtml(o.sub)}</div>` : ""}</div>`
    ).join("");
    if (opts.editable && f && !options.some(o => o.value.toLowerCase() === f)) {
      html += `<div class="combo-opt add" data-add="${escapeHtml(filter.trim())}">+ Use "${escapeHtml(filter.trim())}"</div>`;
    }
    if (!html) html = `<div class="combo-empty">No matches</div>`;
    list.innerHTML = html;
  }
  function open() { pop.classList.add("open"); search.value = ""; render(); search.focus(); }
  function close() { pop.classList.remove("open"); }

  trigger.addEventListener("click", () => pop.classList.contains("open") ? close() : open());
  search.addEventListener("input", () => render(search.value));
  list.addEventListener("click", (e) => {
    const opt = e.target.closest(".combo-opt");
    if (!opt) return;
    if (opt.dataset.add !== undefined) { setValue(opt.dataset.add, opt.dataset.add); }
    else { const o = options.find(x => x.value === opt.dataset.v); setValue(o.value, o.label); }
    close();
  });
  document.addEventListener("click", (e) => { if (!host.contains(e.target)) close(); });

  function setValue(v, l) {
    value = v; label = l || v;
    labelEl.textContent = label;
    trigger.classList.toggle("placeholder", !value);
    if (!value) labelEl.textContent = opts.placeholder || "Select…";
    opts.onChange && opts.onChange(value, label);
  }
  return {
    setOptions(o) { options = o; render(); },
    setValue, getValue: () => value, getLabel: () => label,
  };
}

/* ============================================================
   View switching (sidebar)
   ============================================================ */
function showView(name, { sidebar } = {}) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
  $$(".side-item").forEach(i => i.classList.toggle("active", i.dataset.view === (sidebar || name)));
  window.scrollTo(0, 0);
}
$$(".side-item").forEach(item => {
  item.addEventListener("click", () => {
    showView(item.dataset.view);
    if (item.dataset.view === "list") loadCampaigns();
    if (item.dataset.view === "calls") loadCalls();
    if (item.dataset.view === "followups") { renderFollowups(); scanFollowups(); }
  });
});
$("#batchBack").addEventListener("click", () => { showView("list", { sidebar: "list" }); loadCampaigns(); });

/* ============================================================
   Comboboxes: agent, phone, download-format
   ============================================================ */
const agentCombo = Combobox($("#agentCombo"), {
  placeholder: "Select an agent", searchPlaceholder: "Search agents…",
  onChange: (v) => { state.agentId = v; validate(); },
});
const phoneCombo = Combobox($("#phoneCombo"), {
  placeholder: "Select your phone number", searchPlaceholder: "Search or type a number…", editable: true,
  onChange: (v) => { state.phoneNumber = v; validate(); },
});
// Source numbers are saved per API key (account-scoped). No hardcoded defaults.
function numbersKey() { return state.token ? "gs_src_numbers::" + state.token : null; }
function loadNumbers() { const k = numbersKey(); return k ? JSON.parse(localStorage.getItem(k) || "[]") : []; }
function saveNumbers(arr) { const k = numbersKey(); if (k) localStorage.setItem(k, JSON.stringify(arr)); }
function refreshNumberOptions() {
  state.recentNumbers = loadNumbers();
  // Always offer the hardcoded sources first, then any saved numbers.
  const nums = [...SOURCE_NUMBERS, ...state.recentNumbers.filter(n => !SOURCE_NUMBERS.includes(n))];
  phoneCombo.setOptions(nums.map(n => ({ value: n, label: n })));
}
refreshNumberOptions();
phoneCombo.setValue(SOURCE_NUMBER, SOURCE_NUMBER);   // preselect the hardcoded source

const downloadCombo = Combobox($("#downloadCombo"), {
  placeholder: "Download Sample", searchPlaceholder: "Format…",
  onChange: (v) => { if (v === "csv") downloadSample("csv"); if (v === "xlsx") downloadSample("xlsx"); downloadCombo.setValue("", ""); },
});
downloadCombo.setOptions([{ value: "csv", label: "CSV (.csv)" }, { value: "xlsx", label: "Excel (.xlsx)" }]);

/* Concurrent calls dropdown */
const concSel = $("#c_concurrent");
concSel.innerHTML = Array.from({ length: MAX_CONCURRENT }, (_, i) =>
  `<option value="${i + 1}"${i === 0 ? " selected" : ""}>${i + 1}</option>`).join("");
$("#concurrentHint").textContent = `Your account has up to ${MAX_CONCURRENT} concurrent call slots.`;

/* ============================================================
   Agents
   ============================================================ */
async function loadAgents() {
  if (!state.token) return;
  try {
    const res = await api("/agents?page=1&page_size=100");
    state.agents = res.data || [];   // full list kept for name resolution
    agentCombo.setOptions(selectableAgents().map(a => ({
      value: a.id, label: a.name,
      sub: [a.language, a.agent_type, a.voice].filter(Boolean).join(" · "),
    })));
  } catch (e) { toast("Agents: " + e.message, "err"); }
}
// Only agents whose name contains "karn" are selectable (empty if none).
function selectableAgents() {
  return state.agents.filter(a => /karn/i.test(a.name || ""));
}

/* ============================================================
   File upload + preview (SheetJS handles CSV & XLSX)
   ============================================================ */
$("#browseBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  state.fileName = file.name;
  $("#fileName").textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rows.length) { toast("Sheet has no rows", "err"); return; }
      state.contacts = rows;
      state.columns = Object.keys(rows[0]);
      state.colMap = buildColMap(state.columns);
      buildPhoneColumnPicker();
      renderPreview();
      validate();
    } catch (err) { toast("Could not parse file: " + err.message, "err"); }
  };
  reader.readAsArrayBuffer(file);
}

// API only accepts column names with letters, numbers, underscores.
// Build a stable original→sanitized map (handles spaces, symbols, collisions).
function sanitizeKey(s) {
  let k = String(s).trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!k) k = "col";
  if (/^[0-9]/.test(k)) k = "c_" + k; // avoid leading digit
  return k;
}
function buildColMap(cols) {
  const map = {}, seen = {};
  cols.forEach(c => {
    let k = sanitizeKey(c);
    if (seen[k]) { let n = 2; while (seen[`${k}_${n}`]) n++; k = `${k}_${n}`; }
    seen[k] = true; map[c] = k;
  });
  return map;
}

function buildPhoneColumnPicker() {
  const sel = $("#c_phone_column");
  const guess = state.columns.find(c => /phone|mobile|number|contact/i.test(c)) || state.columns[0];
  sel.innerHTML = state.columns.map(c =>
    `<option value="${escapeHtml(c)}"${c === guess ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
}

function renderPreview() {
  $("#previewEmpty").style.display = "none";
  $("#previewWrap").style.display = "block";
  $("#totalRows").style.display = "inline";
  $("#totalRows").textContent = "Total Rows: " + state.contacts.length;
  const cols = state.columns;
  const head = "<tr>" + cols.map(c => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>";
  const body = state.contacts.slice(0, 100).map(r =>
    "<tr>" + cols.map(c => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("") + "</tr>").join("");
  $("#previewTable").innerHTML = head + body;
}

$("#c_phone_column").addEventListener("change", validate);

/* Sample format */
const SAMPLE = [
  { phone: "+919876543210", name: "Rahul Sharma", company: "TechCo", language: "English" },
  { phone: "+919876543211", name: "Priya Patel", company: "FinCo", language: "Hindi" },
];
function downloadSample(fmt) {
  const ws = XLSX.utils.json_to_sheet(SAMPLE);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contacts");
  XLSX.writeFile(wb, "contacts_sample." + fmt);
}
$("#viewSample").addEventListener("click", () => {
  const cols = Object.keys(SAMPLE[0]);
  $("#modalBody").innerHTML = `
    <h2>Sample file format</h2>
    <p class="muted">Your sheet needs one column with phone numbers (E.164, e.g. <b>+91…</b>).
       Every other column is passed to the agent as a per-contact variable.</p>
    <div class="table-scroll sample-table">
      <table><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr>
      ${SAMPLE.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(r[c])}</td>`).join("")}</tr>`).join("")}</table>
    </div>
    <div class="row"><button class="btn btn-primary" id="dlCsv">Download CSV</button>
    <button class="btn btn-ghost" id="dlXlsx">Download Excel</button></div>`;
  $(".modal").classList.remove("modal-lg");
  $("#modal").style.display = "flex";
  $("#dlCsv").addEventListener("click", () => downloadSample("csv"));
  $("#dlXlsx").addEventListener("click", () => downloadSample("xlsx"));
});

/* ============================================================
   Advanced settings interactions
   ============================================================ */
$("#advToggle").addEventListener("click", () => {
  const body = $("#advBody"), chev = $("#advChevron");
  const collapsed = body.classList.toggle("collapsed");
  chev.classList.toggle("collapsed", collapsed);
});
$("#r_enabled").addEventListener("change", (e) => {
  $("#retryBody").style.display = e.target.checked ? "block" : "none";
});
$("#addBlackout").addEventListener("click", () => addBlackoutRow());
function addBlackoutRow(start = "21:00", end = "09:00") {
  const div = document.createElement("div");
  div.className = "blackout-row";
  div.innerHTML = `<input type="time" class="bo-start" value="${start}" />
    <span class="muted">to</span><input type="time" class="bo-end" value="${end}" />
    <button class="btn btn-ghost btn-sm bo-remove">${icon("x")}</button>`;
  div.querySelector(".bo-remove").addEventListener("click", () => div.remove());
  $("#blackoutList").appendChild(div);
}

/* ============================================================
   Follow-up rules — config UI. Field options come from the batch
   agent's details_to_collect via GET /agents/{id}. All follow-up
   storage is ACCOUNT-SCOPED (keyed by API token) so it never
   shows stale data from another account.
   ============================================================ */
function opLabel(v) { return (FU_OPERATORS.find(o => o.v === v) || {}).label || v; }

async function loadAgentFields(agentId) {
  state.agentFields = [];
  if (agentId) {
    try {
      const res = await api(`/agents/${agentId}`);
      const list = res.data && res.data.details_to_collect;
      if (Array.isArray(list)) {
        state.agentFields = list.map(f =>
          typeof f === "string" ? { key: f, type: "string", description: "" }
                                : { key: f.key || f.name, type: f.type || "string", description: f.description || "" }
        ).filter(f => f.key);
      }
    } catch (e) { /* non-fatal */ }
  }
  const has = state.agentFields.length > 0;
  $("#addFollowup").disabled = !agentId;
  $("#followupHint").textContent = !agentId
    ? "Automatically place a follow-up call when a collected field meets a condition. Select an agent above to load its collected fields."
    : has ? "Add one or more rules. When a call's collected field meets the condition, a follow-up call is placed after the chosen delay using the chosen agent."
          : "This agent has no configured fields to collect. You can still type a field name manually.";
  $$("#followupList .fu-rule").forEach(refreshRuleFieldOptions);
}
function fieldOptionsHtml(selected) {
  if (!state.agentFields.length) return `<option value="">(type field name)</option>`;
  return `<option value="">— field —</option>` + state.agentFields.map(f =>
    `<option value="${escapeHtml(f.key)}"${f.key === selected ? " selected" : ""}>${escapeHtml(f.key)}${f.type ? " · " + escapeHtml(f.type) : ""}</option>`).join("");
}
function refreshRuleFieldOptions(row) {
  const sel = row.querySelector(".fu-field");
  const cur = sel.value;
  sel.innerHTML = fieldOptionsHtml(cur);
}

$("#addFollowup").addEventListener("click", () => addFollowupRow());
function addFollowupRow() {
  const div = document.createElement("div");
  div.className = "fu-rule";
  const opts = FU_OPERATORS.map(o => `<option value="${o.v}">${o.label}</option>`).join("");
  const agentOpts = `<option value="">— agent —</option>` + selectableAgents().map(a =>
    `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  div.innerHTML = `
    <div class="fu-line">
      <span class="fu-tag">When</span>
      <select class="fu-field">${fieldOptionsHtml("")}</select>
      <select class="fu-op">${opts}</select>
      <input class="fu-val" placeholder="value" />
    </div>
    <div class="fu-line">
      <span>then call within</span>
      <input type="number" class="fu-delay" value="5" min="1" />
      <select class="fu-unit"><option value="minutes">minutes</option><option value="hours">hours</option></select>
      <span>with agent</span>
      <select class="fu-agent">${agentOpts}</select>
      <span class="grow"></span>
      <button class="btn btn-ghost btn-sm fu-remove">${icon("x")} Remove</button>
    </div>`;
  const valInput = div.querySelector(".fu-val");
  const opSel = div.querySelector(".fu-op");
  const syncVal = () => {
    const op = FU_OPERATORS.find(o => o.v === opSel.value);
    valInput.style.display = op && op.needsValue ? "" : "none";
  };
  opSel.addEventListener("change", syncVal); syncVal();
  div.querySelector(".fu-remove").addEventListener("click", () => div.remove());
  $("#followupList").appendChild(div);
}
function collectFollowupRules() {
  return [...$$("#followupList .fu-rule")].map(r => {
    const op = r.querySelector(".fu-op").value;
    const needsValue = (FU_OPERATORS.find(o => o.v === op) || {}).needsValue;
    return {
      field: (r.querySelector(".fu-field").value || "").trim(),
      operator: op,
      value: needsValue ? r.querySelector(".fu-val").value.trim() : "",
      delay: parseInt(r.querySelector(".fu-delay").value) || 5,
      unit: r.querySelector(".fu-unit").value,
      followup_agent_id: r.querySelector(".fu-agent").value,
      followup_agent_name: agentName(r.querySelector(".fu-agent").value),
    };
  }).filter(r => r.field && r.followup_agent_id);
}

/* ---- Account-scoped persistence (keyed by API token) ---- */
function fuStoreKey() { return state.token ? "gs_followups::" + state.token : null; }
function fuRunsKey() { return state.token ? "gs_followup_runs::" + state.token : null; }
function loadFollowupStore() { const k = fuStoreKey(); return k ? JSON.parse(localStorage.getItem(k) || "{}") : {}; }
// One follow-up config per batch. Keyed by the local batch id. Stores the
// condition rule, the follow-up routing (SR/IVR), and the dialed phone list so
// the scan only follows up numbers WE dialed in this batch (never organic calls).
function saveFollowupConfig(batch) {
  const k = fuStoreKey(); if (!k) return;
  const store = loadFollowupStore();
  store[batch.id] = {
    created_at: batch.created_at,
    batch_agent_id: batch.agent_id,
    batch_agent_name: batch.agent_name,
    followup_sr: batch.followup_sr,
    followup_ivr: batch.followup_ivr,
    phones: batch.phones,                 // numbers dialed in this batch
    rules: HARDCODED_FOLLOWUP_RULES,
  };
  localStorage.setItem(k, JSON.stringify(store));
}
function loadRuns() { const k = fuRunsKey(); return k ? JSON.parse(localStorage.getItem(k) || "{}") : {}; }
function saveRuns(r) { const k = fuRunsKey(); if (k) localStorage.setItem(k, JSON.stringify(r)); }
function isArmed() { return localStorage.getItem("gupshup_followup_armed") !== "0"; } // on by default
function setArmed(v) { localStorage.setItem("gupshup_followup_armed", v ? "1" : "0"); }
function delayMs(rule) {
  const n = rule.delay || 0;
  if (rule.unit === "hours") return n * 3600000;
  if (rule.unit === "seconds") return n * 1000;
  return n * 60000;
}

/* ---- Condition match + the follow-up call (POST /call) ---- */
function matchesCondition(detailsCollection, rule) {
  const dc = detailsCollection || {};
  const values = dc.collected_values || {};
  const collectedList = dc.collected_details || [];
  const raw = values[rule.field];
  const present = (rule.field in values && raw != null && raw !== "") || collectedList.includes(rule.field);
  const sval = raw == null ? "" : String(raw).trim().toLowerCase();
  const target = String(rule.value || "").trim().toLowerCase();
  const num = parseFloat(raw), tnum = parseFloat(rule.value);
  switch (rule.operator) {
    case "equals": return sval === target;
    case "not_equals": return sval !== target;
    case "contains": return sval.includes(target);
    case "not_contains": return !sval.includes(target);
    case "greater_than": return !isNaN(num) && !isNaN(tnum) && num > tnum;
    case "less_than": return !isNaN(num) && !isNaN(tnum) && num < tnum;
    case "is_truthy": return ["yes", "true", "1", "y"].includes(sval);
    case "is_falsy": return ["no", "false", "0", "n"].includes(sval);
    case "is_collected": return present;
    case "not_collected": return !present;
    default: return false;
  }
}
// Follow-up call is a Knowlarity otpcall (via proxy) to the batch's follow-up
// SR number + IVR — NOT a Levrage agent call.
async function fireFollowup({ followup_sr, followup_ivr, phone_number }) {
  return knowlarityCall({
    endpoint: "otpcall",
    ivr_id: followup_ivr,
    k_number: followup_sr,
    customer_number: phone_number,
    caller_id: followup_sr,
    is_promotional: false,
  });
}

/* ============================================================
   Follow-up ENGINE — uses Call History as source. A call links to
   a batch config when call.agent_id === batch agent and the call
   happened after the batch was created (no phone matching).
   ============================================================ */
let fuScanning = false;
async function scanFollowups() {
  if (fuScanning || !state.token) { renderFollowups(); return; }
  const configs = loadFollowupStore();
  const ids = Object.keys(configs);
  if (!ids.length) { renderFollowups(); return; }
  fuScanning = true;
  setFuStatus(`${icon("clock")} Scanning call history…`);
  try {
    // Only pull calls from the last 5 minutes — never sweep the whole history
    // (so we don't "catch up" and fire follow-ups for old calls).
    const since = new Date(Date.now() - FOLLOWUP_LOOKBACK_MS).toISOString();
    const path = "/calls?page=1&page_size=100&direction=outbound&from_date=" + encodeURIComponent(since);
    const res = await api(path);
    const calls = res.data || [];
    const runs = loadRuns();
    const rule = HARDCODED_FOLLOWUP_RULES[0];   // single global rule
    // Every call id that already has a run (any status / any old key) → never handle again.
    const handledCallIds = new Set(Object.values(runs).map(r => r.callId));
    for (const call of calls) {
      if (call.status !== "completed" || !call.details_collection) continue;
      if (handledCallIds.has(call.id)) continue;   // dedup per call, even across old keys
      // Hard recency guard in case the API returns anything older than the window.
      const startedMs = new Date(call.started_at || call.ended_at).getTime();
      if (isNaN(startedMs) || Date.now() - startedMs > FOLLOWUP_LOOKBACK_MS) continue;
      const phone = normPhone(call.phone_number);
      // Link the call to a batch: same Karn agent + the number was in THIS batch's
      // dialed list + the call happened after the batch was created. The phone-list
      // match ensures we never follow up organic (non-batch) calls by the same agent.
      const cid = ids.find(id => {
        const cfg = configs[id];
        if (cfg.batch_agent_id && cfg.batch_agent_id !== call.agent_id) return false;
        if (cfg.created_at && new Date(call.started_at) < new Date(cfg.created_at)) return false;
        return Array.isArray(cfg.phones) && cfg.phones.includes(phone);
      });
      if (!cid) continue;
      const cfg = configs[cid];
      const key = `${call.id}::fu`;
      if (runs[key]) continue;
      if (!matchesCondition(call.details_collection, rule)) continue;
      const base = new Date(call.ended_at || call.started_at).getTime();
      runs[key] = {
        key, campaignId: cid, callId: call.id,
        phone: call.phone_number,
        followup_sr: cfg.followup_sr, followup_ivr: cfg.followup_ivr,
        reason: `${rule.field} ${opLabel(rule.operator)}${rule.value ? " " + rule.value : ""}`,
        summary: call.call_summary || "", collected: (call.details_collection.collected_values || {}),
        fireAt: base + delayMs(rule), status: "scheduled",
      };
    }
    saveRuns(runs);
    await processDue();
    setFuStatus(`Last scan: ${new Date().toLocaleTimeString()} · ${calls.length} calls checked`);
  } catch (e) {
    setFuStatus("Scan error: " + e.message, "warn");
  } finally { fuScanning = false; renderFollowups(); }
}
async function processDue() {
  const now = Date.now(), armed = isArmed();
  // Snapshot the keys to process; sendFollowup re-reads/re-persists the store per run,
  // so we don't keep a stale `runs` object around to save back (which would clobber it).
  const keys = Object.keys(loadRuns());
  if (!armed) {
    const runs = loadRuns();
    for (const key of keys) {
      const r = runs[key];
      if (!r || (r.status !== "scheduled" && r.status !== "due")) continue;
      if (r.fireAt <= now) r.status = "due";
    }
    saveRuns(runs);
    return;
  }
  for (const key of keys) {
    const r = loadRuns()[key];   // re-read each iteration so claims/sends are seen
    if (!r || (r.status !== "scheduled" && r.status !== "due")) continue;
    if (r.fireAt > now) continue;
    await sendFollowup(r);
  }
}
async function sendFollowup(r, runs) {
  // Claim the run BEFORE the network call: persist "sending" synchronously so any
  // overlapping scan/poller (or a "Send now" click) re-reads the store, sees it's
  // already in-flight, and skips it — preventing duplicate calls for one run.
  const store = loadRuns();
  const cur = store[r.key];
  if (cur && cur.status !== "scheduled" && cur.status !== "due") return; // already claimed/sent
  if (cur) { cur.status = "sending"; saveRuns(store); }
  r.status = "sending";
  if (runs) runs[r.key] = r;
  try {
    await fireFollowup({ followup_sr: r.followup_sr, followup_ivr: r.followup_ivr, phone_number: r.phone });
    r.status = "sent"; r.sentAt = Date.now();
  } catch (e) { r.status = "failed"; r.error = e.message; }
  // Persist the final status against the latest store (re-read, since we awaited).
  const after = loadRuns(); after[r.key] = r; saveRuns(after);
  if (runs) runs[r.key] = r;
}
function setFuStatus(html, cls = "") { const el = $("#fuStatus"); if (el) { el.innerHTML = html; el.className = "fu-status " + cls; } }

function renderFollowups() {
  const configs = loadFollowupStore();
  const ids = Object.keys(configs);
  const cc = $("#fuConfigs");
  if (!cc) return;
  if (!ids.length) {
    cc.innerHTML = `<div class="empty">No follow-up rules configured yet. Add them while creating a campaign.</div>`;
    $("#fuRuns").innerHTML = ""; return;
  }
  cc.innerHTML = `<div class="fu-configs-card">
    <h3>${icon("list-checks")} Active rule</h3>
    ${HARDCODED_FOLLOWUP_RULES.map(r =>
      `<div class="fu-summary"><span class="fu-ic">${icon("corner-up-right")}</span>
       <div>When <b>${escapeHtml(r.field)}</b> ${escapeHtml(opLabel(r.operator))}${r.value ? ` <b>${escapeHtml(r.value)}</b>` : ""} → call within <b>${r.delay} ${escapeHtml(r.unit)}</b> via the batch's follow-up IVR (Knowlarity otpcall)</div></div>`
    ).join("")}
  </div>`;

  const runs = Object.values(loadRuns()).sort((a, b) => (b.fireAt || 0) - (a.fireAt || 0));
  const wrap = $("#fuRuns");
  if (!runs.length) { wrap.innerHTML = `<div class="empty">No matching calls found yet. Run a batch, then “Scan now”.</div>`; return; }
  wrap.innerHTML = "";
  const now = Date.now();
  runs.forEach(r => {
    const el = document.createElement("div");
    el.className = "fu-run";
    let when = "";
    if (r.status === "scheduled") when = r.fireAt > now ? "in " + fmtCountdown(r.fireAt - now) : "due now";
    else if (r.status === "due") when = "ready to send";
    else if (r.status === "sent") when = "sent " + (r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : "");
    else if (r.status === "failed") when = escapeHtml(r.error || "failed");
    el.innerHTML = `
      <div class="main">
        <div class="who">${icon("phone")} ${escapeHtml(r.phone || "—")} <span style="color:var(--muted);font-weight:400">→ IVR ${escapeHtml(r.followup_ivr || "—")} on ${escapeHtml(r.followup_sr || "—")}</span></div>
        <div class="reason">When <b>${escapeHtml(r.reason)}</b></div>
        ${r.summary ? `<div class="snippet">${escapeHtml(r.summary)}</div>` : ""}
      </div>
      <div class="when">${when}</div>
      <span class="fu-pill ${r.status}">${r.status}</span>
      <div class="actions"></div>`;
    const actions = el.querySelector(".actions");
    if (r.status === "scheduled" || r.status === "due") {
      actions.appendChild(btn("Send now", "btn-outline", async () => {
        const runs2 = loadRuns(); await sendFollowup(runs2[r.key] || r, runs2); renderFollowups();
      }, "phone"));
      actions.appendChild(btn("Skip", "", () => {
        const runs2 = loadRuns(); if (runs2[r.key]) { runs2[r.key].status = "skipped"; saveRuns(runs2); } renderFollowups();
      }, "x"));
    }
    wrap.appendChild(el);
  });
}
function fmtCountdown(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60); return `${h}h ${m % 60}m`;
}

/* ============================================================
   Validation + payload
   ============================================================ */
function validate() {
  const ok = $("#c_name").value.trim() && state.agentId &&
             state.contacts.length > 0 && $("#c_phone_column").value &&
             $("#c_batch_sr").value.trim() && $("#c_batch_ivr").value.trim() &&
             $("#c_fu_sr").value.trim() && $("#c_fu_ivr").value.trim();
  $("#startNowBtn").disabled = !ok;
  $("#scheduleBtn").disabled = !ok;
  return ok;
}
$("#c_name").addEventListener("input", validate);
["#c_batch_sr", "#c_batch_ivr", "#c_fu_sr", "#c_fu_ivr"].forEach(s => $(s).addEventListener("input", validate));

// Build the local batch object from the form (no Levrage API).
function buildBatch() {
  const phoneCol = $("#c_phone_column").value;
  const phones = [];
  const seen = new Set();
  for (const row of state.contacts) {
    const p = normPhone(row[phoneCol]);
    if (p && !seen.has(p)) { seen.add(p); phones.push(p); }
  }
  return {
    id: localId(),
    name: $("#c_name").value.trim(),
    created_at: new Date().toISOString(),
    agent_id: state.agentId,
    agent_name: agentName(state.agentId),
    phone_column: phoneCol,
    contacts: state.contacts,
    phones,
    dialed: {},
    dialing: false,
    batch_sr: normPhone($("#c_batch_sr").value.trim()),
    batch_ivr: $("#c_batch_ivr").value.trim(),
    followup_sr: normPhone($("#c_fu_sr").value.trim()),
    followup_ivr: $("#c_fu_ivr").value.trim(),
  };
}

async function submitCampaign(startNow) {
  if (!validate()) return;
  if (state.contacts.length > 2000) {
    setMsg(`Max 2000 contacts (sheet has ${state.contacts.length}).`, "err"); return;
  }
  const b = buildBatch();
  if (!b.phones.length) { setMsg("No valid phone numbers found in the selected column.", "err"); return; }
  putBatch(b);
  // Persist the follow-up config (condition + follow-up routing + the dialed phone list).
  saveFollowupConfig(b);
  setMsg(`Created "${b.name}" — ${b.phones.length} numbers · follow-up active`, "ok");
  toast(startNow ? "Batch created — dialing…" : "Batch created", "ok");
  resetForm();
  $('.side-item[data-view="list"]').click();
  if (startNow) startDialing(b.id);
}
function setMsg(html, cls = "") { const m = $("#createMsg"); m.innerHTML = html; m.className = "msg " + cls; }

$("#startNowBtn").addEventListener("click", () => submitCampaign(true));
$("#scheduleBtn").addEventListener("click", () => submitCampaign(false));
$("#cancelBtn").addEventListener("click", () => { if (confirm("Clear the form?")) resetForm(); });

function rememberNumber(n) {
  if (!n) return;
  const list = [n, ...loadNumbers().filter(x => x !== n)].slice(0, 10);
  saveNumbers(list);
  refreshNumberOptions();
}
function resetForm() {
  $("#c_name").value = "";
  state.contacts = []; state.columns = []; state.colMap = {}; state.fileName = "";
  $("#fileName").textContent = "No file chosen"; $("#fileInput").value = "";
  $("#c_phone_column").innerHTML = '<option value="">Select column containing phone numbers</option>';
  $("#previewWrap").style.display = "none"; $("#previewEmpty").style.display = "flex";
  $("#totalRows").style.display = "none";
  $("#followupList").innerHTML = "";
  // Keep SR/IVR routing values — they're usually reused across batches.
  setMsg("");
}

/* ============================================================
   Local batch store (NO Levrage campaign API). A batch holds the
   uploaded contacts, the Karn agent (for matching call history),
   and the Knowlarity routing (batch + follow-up SR/IVR). Initial
   calls are placed manually one-by-one via the otpcall proxy.
   ============================================================ */
function batchesKey() { return state.token ? "gs_batches::" + state.token : null; }
function loadBatches() { const k = batchesKey(); return k ? JSON.parse(localStorage.getItem(k) || "{}") : {}; }
function saveBatches(b) { const k = batchesKey(); if (k) localStorage.setItem(k, JSON.stringify(b)); }
function getBatch(id) { return loadBatches()[id]; }
function putBatch(b) { const all = loadBatches(); all[b.id] = b; saveBatches(all); }
function localId() { return "b_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

// ---- Sequential dialer: places one otpcall per contact, with a gap ----
const dialers = {};   // batchId -> { stop: bool }
async function startDialing(id) {
  const b = getBatch(id); if (!b) return;
  if (dialers[id] && !dialers[id].stop) return;   // already running
  dialers[id] = { stop: false };
  b.dialing = true; putBatch(b);
  renderBatchesIfVisible(); openBatchIfVisible(id);
  for (const phone of b.phones) {
    if (dialers[id].stop) break;
    const cur = getBatch(id);                       // re-read for latest statuses
    const st = cur.dialed[phone];
    if (st && (st.status === "placed" || st.status === "calling")) continue;  // skip already done
    cur.dialed[phone] = { status: "calling", at: Date.now() };
    putBatch(cur); openBatchIfVisible(id);
    try {
      const r = await knowlarityCall({
        endpoint: "otpcall",
        ivr_id: cur.batch_ivr,
        k_number: cur.batch_sr,
        customer_number: phone,
        caller_id: cur.batch_sr,
        is_promotional: false,
      });
      const callId = r && r.call_ids && r.call_ids[0] && r.call_ids[0].call_id;
      const after = getBatch(id);
      after.dialed[phone] = { status: "placed", call_id: callId || null, at: Date.now() };
      putBatch(after);
    } catch (e) {
      const after = getBatch(id);
      after.dialed[phone] = { status: "failed", error: e.message, at: Date.now() };
      putBatch(after);
    }
    openBatchIfVisible(id); renderBatchesIfVisible();
    if (dialers[id].stop) break;
    await sleep(GAP_BETWEEN_CALLS_MS);              // respect Knowlarity rate limits
  }
  const done = getBatch(id); if (done) { done.dialing = false; putBatch(done); }
  dialers[id] = { stop: true };
  renderBatchesIfVisible(); openBatchIfVisible(id);
}
function stopDialing(id) { if (dialers[id]) dialers[id].stop = true; const b = getBatch(id); if (b) { b.dialing = false; putBatch(b); } renderBatchesIfVisible(); openBatchIfVisible(id); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function batchProgress(b) {
  const vals = Object.values(b.dialed || {});
  return {
    total: b.phones.length,
    placed: vals.filter(v => v.status === "placed").length,
    failed: vals.filter(v => v.status === "failed").length,
    calling: vals.filter(v => v.status === "calling").length,
  };
}

/* ============================================================
   Batches list (local)
   ============================================================ */
function loadCampaigns() {
  const wrap = $("#campaignsList");
  const all = Object.values(loadBatches()).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  if (!all.length) { wrap.innerHTML = '<div class="empty">No batches yet. Create one from “Outbound Campaign”.</div>'; return; }
  wrap.innerHTML = ""; all.forEach(c => wrap.appendChild(campaignCard(c)));
}
function renderBatchesIfVisible() { if ($("#view-list").classList.contains("active")) loadCampaigns(); }
$("#reloadCampaigns").addEventListener("click", loadCampaigns);
$("#statusFilter").addEventListener("change", loadCampaigns);

function campaignCard(c) {
  const el = document.createElement("div");
  el.className = "campaign-card";
  const p = batchProgress(c);
  const status = c.dialing ? "in_progress" : (p.placed + p.failed >= p.total && p.total ? "completed" : "pending");
  el.innerHTML = `
    <div class="campaign-main">
      <div class="campaign-name">${escapeHtml(c.name)}</div>
      <div class="campaign-meta">${escapeHtml(c.agent_name || "—")} · ${fmtDate(c.created_at)}</div>
    </div>
    <div class="campaign-stats">
      <div class="stat"><b>${p.total}</b><span>total</span></div>
      <div class="stat"><b>${p.placed}</b><span>placed</span></div>
      <div class="stat"><b>${p.calling}</b><span>calling</span></div>
      <div class="stat"><b>${p.failed}</b><span>failed</span></div>
    </div>
    <span class="pill ${status}">${status.replace("_", " ")}</span>
    <div class="campaign-actions"></div>`;
  const actions = el.querySelector(".campaign-actions");
  if (c.dialing)
    actions.appendChild(btn("Pause", "", (e) => { e.stopPropagation(); stopDialing(c.id); }, "pause"));
  else if (p.placed + p.failed < p.total)
    actions.appendChild(btn(p.placed + p.failed > 0 ? "Resume" : "Start calling", "", (e) => { e.stopPropagation(); startDialing(c.id); }, "play"));
  el.addEventListener("click", () => openBatch(c.id));
  return el;
}
function btn(label, cls, onClick, iconName) {
  const b = document.createElement("button");
  b.className = "btn btn-sm " + cls;
  b.innerHTML = (iconName ? icon(iconName) + " " : "") + escapeHtml(label);
  b.addEventListener("click", onClick); return b;
}

/* ============================================================
   Batch Details — local batch (per-contact dial status + controls)
   ============================================================ */
let openBatchId = null;
function openBatch(id) {
  openBatchId = id;
  showView("batch", { sidebar: "list" });
  const c = getBatch(id);
  if (!c) { $("#batchBody").innerHTML = `<div class="empty">Batch not found.</div>`; return; }
  renderBatch(c);
}
// Re-render the open batch in place (used by the dialer as statuses change).
function openBatchIfVisible(id) {
  if (openBatchId === id && $("#view-batch").classList.contains("active")) {
    const c = getBatch(id); if (c) renderBatch(c);
  }
}

function statCard(label, iconName, value, foot, tone = "") {
  return `<div class="stat-card ${tone}">
    <div class="top"><span class="label">${label}</span>${icon(iconName)}</div>
    <div class="num">${value}</div>
    <div class="foot">${foot}</div>
  </div>`;
}

function renderBatch(c) {
  const p = batchProgress(c);
  const pending = p.total - p.placed - p.failed - p.calling;
  const status = c.dialing ? "in_progress" : (p.placed + p.failed >= p.total && p.total ? "completed" : "pending");
  const pill = `<span class="pill ${status}">${status.replace("_", " ")}</span>`;
  const statusLabel = (ph) => (c.dialed[ph] && c.dialed[ph].status) || "pending";

  const rows = c.phones.map(ph => {
    const d = c.dialed[ph] || {};
    const cls = { placed: "good", failed: "bad", calling: "warn" }[d.status] || "";
    const extra = d.status === "placed" ? (d.call_id ? shortId(d.call_id) : "ok")
                : d.status === "failed" ? escapeHtml(d.error || "error") : "";
    return `<tr><td>${escapeHtml(ph)}</td>
      <td><span class="tagchip ${cls}">${statusLabel(ph)}</span></td>
      <td class="muted">${extra}</td></tr>`;
  }).join("");

  $("#batchBody").innerHTML = `
    <div class="batch-head-card">
      <div class="batch-title-row"><h2>${escapeHtml(c.name)}</h2>${pill}</div>
      <div class="batch-meta-row">
        <div><div class="k">Created</div><div class="v">${icon("calendar")} ${fmtDate(c.created_at)}</div></div>
        <div><div class="k">Agent</div><div class="v">${icon("user")} ${escapeHtml(c.agent_name || "—")}</div></div>
        <div><div class="k">Batch SR / IVR</div><div class="v">${escapeHtml(c.batch_sr)} · ${escapeHtml(c.batch_ivr)}</div></div>
        <div><div class="k">Follow-up SR / IVR</div><div class="v">${escapeHtml(c.followup_sr)} · ${escapeHtml(c.followup_ivr)}</div></div>
      </div>
    </div>

    <div class="stat-grid">
      ${statCard("Numbers", "phone-call", p.total, "In this batch", "accent")}
      ${statCard("Placed", "check-circle", p.placed, "Calls triggered", "good")}
      ${statCard("Calling", "phone", p.calling, "In progress", "warn")}
      ${statCard("Failed", "x-circle", p.failed, p.failed ? "See rows below" : "No failures", "bad")}
      ${statCard("Pending", "clock", pending < 0 ? 0 : pending, "Not yet dialed", "")}
    </div>

    ${followupSectionHtml(c.id)}

    <div class="batch-section" style="margin-top:20px">
      <h3>${icon("phone-call")} Contacts</h3>
      <div class="table-scroll"><table class="data-table">
        <tr><th>Number</th><th>Status</th><th>Detail</th></tr>${rows}
      </table></div>
    </div>

    <div class="actionbar" id="batchActions" style="border-top:none"></div>`;

  $("#batchCredits").textContent = String(p.placed);

  const ba = $("#batchActions");
  if (c.dialing) ba.appendChild(btn("Pause dialing", "", () => stopDialing(c.id), "pause"));
  else if (p.placed + p.failed < p.total) ba.appendChild(btn(p.placed + p.failed > 0 ? "Resume dialing" : "Start calling", "", () => startDialing(c.id), "play"));
  ba.appendChild(btn("Refresh", "", () => openBatch(c.id), "refresh"));

  hydrateIcons($("#batchBody"));
}
function kvline(k, v) { return `<div class="kvline"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

function followupSectionHtml(batchId) {
  const cfg = loadFollowupStore()[batchId];
  if (!cfg || !cfg.rules || !cfg.rules.length) return "";
  const rows = cfg.rules.map(r => `
    <div class="fu-summary"><span class="fu-ic">${icon("corner-up-right")}</span>
      <div>When <b>${escapeHtml(r.field)}</b> ${escapeHtml(opLabel(r.operator))}${r.value ? ` <b>${escapeHtml(r.value)}</b>` : ""},
      call within <b>${r.delay} ${escapeHtml(r.unit)}</b> via IVR <b>${escapeHtml(cfg.followup_ivr || "—")}</b> on <b>${escapeHtml(cfg.followup_sr || "—")}</b>.</div>
    </div>`).join("");
  return `
    <div class="batch-section" style="margin-top:20px">
      <h3>${icon("corner-up-right")} Follow-up Rule</h3>
      ${rows}
      <p class="hint" style="margin-top:10px">${icon("clock")} Evaluated from Levrage Call History after each call's PCA — see the Follow-ups tab.</p>
    </div>`;
}

/* ============================================================
   Call History (GET /calls) — table + tabbed detail
   ============================================================ */
let callsCache = [];

function sentimentClass(s) {
  if (!s) return "neu"; s = s.toLowerCase();
  if (s.includes("pos")) return "pos";
  if (s.includes("neg")) return "neg";
  return "neu";
}
function fmtDur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}
function phoneDisplay(c) {
  if (c.phone_number && c.phone_number !== "None") return c.phone_number;
  return c.direction === "web" ? "Web call" : "—";
}
function dpart(d) { if (!d) return "—"; try { return new Date(d).toLocaleDateString(); } catch { return d; } }
function tpart(d) { if (!d) return "—"; try { return new Date(d).toLocaleTimeString(); } catch { return d; } }
function agentName(id) {
  const a = state.agents.find(x => x.id === id);
  return a ? a.name : (id ? id.slice(0, 8) : "—");
}
function isKarnAgent(id) {
  const a = state.agents.find(x => x.id === id);
  return !!(a && /karn/i.test(a.name || ""));
}
function rangeFromDate() {
  const days = $("#callRange").value;
  if (!days) return null;
  const d = new Date(Date.now() - parseInt(days) * 86400000);
  return d.toISOString();
}

async function loadCalls() {
  const tbl = $("#callsTable");
  tbl.innerHTML = `<tr><td><div class="empty"><span class="spinner"></span> Loading…</div></td></tr>`;
  $("#callsFoot").textContent = "";
  try {
    let path = "/calls?page=1&page_size=100";
    const st = $("#callStatusFilter").value; if (st) path += "&status=" + encodeURIComponent(st);
    const dir = $("#callDirectionFilter").value; if (dir) path += "&direction=" + encodeURIComponent(dir);
    const from = rangeFromDate(); if (from) path += "&from_date=" + encodeURIComponent(from);
    const res = await api(path);
    // Only show calls from "karn" (Karnataka Bank) agents.
    callsCache = (res.data || []).filter(c => isKarnAgent(c.agent_id));
    renderCallsTable();
    $("#callsFoot").textContent = `Showing ${callsCache.length} Karnataka-agent call${callsCache.length === 1 ? "" : "s"}`;
  } catch (e) { tbl.innerHTML = `<tr><td><div class="empty">Error: ${escapeHtml(e.message)}</div></td></tr>`; }
}
$("#reloadCalls").addEventListener("click", loadCalls);
$("#callStatusFilter").addEventListener("change", loadCalls);
$("#callDirectionFilter").addEventListener("change", loadCalls);
$("#callRange").addEventListener("change", loadCalls);

function renderCallsTable() {
  const tbl = $("#callsTable");
  if (!callsCache.length) { tbl.innerHTML = `<tr><td><div class="empty">No calls found.</div></td></tr>`; return; }
  const head = `<thead><tr>
    <th>Agent Name</th><th>Phone Number</th><th>Start Date</th><th>Start Time</th><th>End Date</th><th>End Time</th>
    <th>Duration</th><th>Direction</th><th>Status</th><th>Credits</th><th class="actions-th">Actions</th>
  </tr></thead>`;
  const rows = callsCache.map((c, i) => `
    <tr data-i="${i}">
      <td><span class="agent-cell"><span class="av">${icon("user")}</span>${escapeHtml(agentName(c.agent_id))}</span></td>
      <td>${escapeHtml(phoneDisplay(c))}</td>
      <td>${dpart(c.started_at || c.created_at)}</td>
      <td>${tpart(c.started_at || c.created_at)}</td>
      <td>${dpart(c.ended_at)}</td>
      <td>${tpart(c.ended_at)}</td>
      <td>${fmtDur(c.duration_seconds)}</td>
      <td><span class="tag ${escapeHtml(c.direction || "")}">${escapeHtml(c.direction || "—")}</span></td>
      <td><span class="tag st-${escapeHtml(c.status || "")}">${(c.status || "—").replace("_", " ")}</span></td>
      <td>${c.total_cost != null ? Number(c.total_cost).toFixed(2) : "—"}</td>
      <td><div class="row-actions"><button class="icon-btn view-call" title="View">${icon("eye")}</button></div></td>
    </tr>`).join("");
  tbl.innerHTML = head + "<tbody>" + rows + "</tbody>";
  tbl.querySelectorAll("tbody tr").forEach(tr =>
    tr.addEventListener("click", () => openCallDetail(callsCache[+tr.dataset.i])));
}

/* CSV / Excel export (client-side from loaded rows) */
function callsToRows() {
  return callsCache.map(c => ({
    agent_name: agentName(c.agent_id), phone_number: c.phone_number, direction: c.direction,
    status: c.status, started_at: c.started_at, ended_at: c.ended_at,
    duration_seconds: c.duration_seconds, sentiment: c.sentiment, credits: c.total_cost,
    call_summary: c.call_summary,
  }));
}
function exportCalls(fmt) {
  if (!callsCache.length) { toast("Nothing to export", "err"); return; }
  const ws = XLSX.utils.json_to_sheet(callsToRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Calls");
  XLSX.writeFile(wb, "call_history." + fmt);
}
$("#exportCsv").addEventListener("click", () => exportCalls("csv"));
$("#exportXlsx").addEventListener("click", () => exportCalls("xlsx"));

/* ---------- Tabbed call detail ---------- */
function openCallDetail(c) {
  const phone = (c.phone_number && c.phone_number !== "None") ? c.phone_number : (c.direction === "web" ? "Web Call" : "Unknown");
  const dirLabel = (c.direction || "").charAt(0).toUpperCase() + (c.direction || "").slice(1);
  const transcript = Array.isArray(c.transcript) ? c.transcript : [];
  const cost = (v) => v != null ? Number(v).toFixed(2) : "—";
  const dc = c.details_collection || {};
  const collected = dc.collected_values || {};
  const collectedNames = dc.collected_details || [];

  // Build tab panes
  const overview = `
    <div class="ov-card">
      <div class="head">
        <span class="title">${escapeHtml(dirLabel)} · ${escapeHtml(phone)}</span>
        <span class="tag st-${escapeHtml(c.status||"")}">${(c.status||"—").replace("_"," ")}</span>
      </div>
      ${c.call_summary ? `<p style="line-height:1.65;margin:0 0 4px">${escapeHtml(c.call_summary)}</p>` : `<p class="muted">No summary available.</p>`}
      <div class="ov-meta">
        <span>${icon("calendar")} ${fmtDate(c.started_at || c.created_at)}</span>
        <span>${icon("clock")} ${fmtDur(c.duration_seconds)}</span>
        <span>${icon("coins")} Cost ${cost(c.total_cost)}</span>
        ${c.sentiment ? `<span>${icon("message-square")} ${escapeHtml(c.sentiment)}</span>` : ""}
      </div>
      <div class="ov-three">
        <div><div class="k">Agent</div><div>${escapeHtml(agentName(c.agent_id))}</div></div>
        <div><div class="k">Type</div><div>${escapeHtml(c.agent_type || "—")}</div></div>
        <div><div class="k">Session</div><div>${escapeHtml((c.session_id||"").slice(0,12) || "—")}</div></div>
      </div>
    </div>
    ${(c.call_end_reason || c.ended_by) ? `
      <div class="ended-card">
        <span class="ic">${icon("phone")}</span>
        <div>
          <div class="lbl">Call ended by <b>${escapeHtml(c.ended_by || "—")}</b></div>
          <div style="margin-top:4px">${escapeHtml(c.call_end_reason || "")}</div>
        </div>
      </div>` : ""}
    ${c.recording_url ? `<div class="ov-card"><div class="head"><span class="title">${icon("headphones")} Recording</span></div>
      <audio controls src="${escapeHtml(c.recording_url)}" style="width:100%"></audio></div>` : ""}`;

  const transcriptPane = transcript.length ? `
    <div class="transcript chat">${transcript.map(t => {
      const who = (t.speaker || "").toLowerCase();
      const side = who === "user" ? "user" : "agent";
      const initial = side === "user" ? "U" : "A";
      return `
      <div class="turn ${side}">
        <div class="avatar">${initial}</div>
        <div class="bubble">
          <div class="meta">${escapeHtml(t.speaker || "?")}<span class="ts">${escapeHtml(t.timestamp || "")}</span></div>
          <div class="txt">${escapeHtml(t.text || "")}</div>
        </div>
      </div>`;
    }).join("")}</div>`
    : `<div class="empty-tab"><span class="ic" style="font-size:40px">${icon("message-square")}</span>No transcript available</div>`;

  const detailKeys = Object.keys(collected);
  const detailsPane = detailKeys.length ? `
    <div class="score-row">
      <span style="font-weight:600">Collection score</span>
      <div class="progress"><div style="width:${Math.round((dc.score || 0) * 10)}%"></div></div>
      <b>${dc.score != null ? Math.round(dc.score * 10) + "%" : "—"}</b>
    </div>
    <div class="ov-card" style="padding:6px 18px">
      ${detailKeys.map(k => {
        const v = collected[k];
        const has = v != null && v !== "";
        return `<div class="field-row">
          <div class="fname">${escapeHtml(k)}</div>
          <div class="fval">${has ? escapeHtml(String(v)) : "—"}</div>
          <div class="fstat ${has ? "yes" : "no"}">${has ? icon("check-circle") + " collected" : "not collected"}</div>
        </div>`;
      }).join("")}
    </div>`
    : `<div class="empty-tab"><span class="ic" style="font-size:40px">${icon("users")}</span>No details collected</div>`;

  const metricsPane = `
    <div class="metric-grid">
      <div class="metric-tile"><div class="k">Duration</div><div class="v">${fmtDur(c.duration_seconds)}</div></div>
      <div class="metric-tile"><div class="k">Total cost (credits)</div><div class="v">${cost(c.total_cost)}</div></div>
      <div class="metric-tile"><div class="k">AI cost</div><div class="v">${cost(c.ai_cost)}</div></div>
      <div class="metric-tile"><div class="k">Telephony cost</div><div class="v">${cost(c.telephony_cost)}</div></div>
      <div class="metric-tile"><div class="k">Transcript turns</div><div class="v">${transcript.length}</div></div>
      <div class="metric-tile"><div class="k">Handover</div><div class="v">${c.handover ? "Yes" : "No"}</div></div>
    </div>`;

  // Metadata: per-contact fields a batch attaches to the call. Not exposed by this API → empty state.
  const meta = c.metadata || c.variables || null;
  const metadataPane = meta && Object.keys(meta).length ? `
    <div class="ov-card" style="padding:6px 18px">
      ${Object.entries(meta).map(([k, v]) => `<div class="field-row">
        <div class="fname">${escapeHtml(k)}</div><div class="fval">${escapeHtml(String(v))}</div></div>`).join("")}
    </div>`
    : `<div class="empty-tab"><span class="ic" style="font-size:40px">${icon("database")}</span>No metadata available
        <div class="muted" style="font-size:12px;margin-top:6px">Contact fields from the uploaded batch sheet appear here for campaign calls.</div></div>`;

  $("#modalBody").innerHTML = `
    <div class="modal-head">
      <div><h2>Call Details</h2><div class="sub">${escapeHtml(phone)} · ${escapeHtml(dirLabel)}</div></div>
    </div>
    <div class="tabs" id="callTabs">
      <button class="active" data-pane="overview">${icon("phone-call")} Overview</button>
      <button data-pane="metrics">${icon("bar-chart")} Metrics</button>
      <button data-pane="transcript">${icon("message-square")} Transcript <span class="count">${transcript.length}</span></button>
      <button data-pane="details">${icon("users")} Details Collected</button>
      <button data-pane="metadata">${icon("database")} Metadata</button>
    </div>
    <div class="tab-panes">
      <div class="tab-pane active" data-pane="overview">${overview}</div>
      <div class="tab-pane" data-pane="metrics">${metricsPane}</div>
      <div class="tab-pane" data-pane="transcript">${transcriptPane}</div>
      <div class="tab-pane" data-pane="details">${detailsPane}</div>
      <div class="tab-pane" data-pane="metadata">${metadataPane}</div>
    </div>`;

  $("#modalBody").querySelectorAll("#callTabs button").forEach(b =>
    b.addEventListener("click", () => {
      $("#modalBody").querySelectorAll("#callTabs button").forEach(x => x.classList.remove("active"));
      $("#modalBody").querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      b.classList.add("active");
      $("#modalBody").querySelector(`.tab-pane[data-pane="${b.dataset.pane}"]`).classList.add("active");
    }));

  $(".modal").classList.add("modal-lg");
  $("#modal").style.display = "flex";
}
function closeModal() { $("#modal").style.display = "none"; $(".modal").classList.remove("modal-lg"); }
$("#modalClose").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/* ============================================================
   Follow-up controls + background poller
   ============================================================ */
$("#fuScan").addEventListener("click", scanFollowups);
$("#fuArm").addEventListener("change", (e) => {
  setArmed(e.target.checked);
  if (e.target.checked) { toast("Auto-send armed — due follow-ups will place real calls", "ok"); processDue().then(renderFollowups); }
});
// Poll every 15s while the app is open so the 30s follow-up fires on time.
setInterval(() => { if (state.token && Object.keys(loadFollowupStore()).length) scanFollowups(); }, 15000);

/* ============================================================
   Init
   ============================================================ */
hydrateIcons();
$("#fuArm").checked = isArmed();
if (state.token) loadAgents();
