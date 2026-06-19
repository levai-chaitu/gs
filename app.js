/* ============================================================
   Campaign Studio — outbound campaign runner
   Endpoints used:
     GET  /agents
     POST /campaigns            GET /campaigns      GET /campaigns/{id}
     POST /campaigns/{id}/pause     /resume     /stop     /cancel
   ============================================================ */

const API_BASE = "https://api.levrage.ai/v1";
const MAX_CONCURRENT = 20; // account slots (no API for this; reference showed ~11)
const API_TOKEN = "lev_iFeIGO5CboduSWjYOp9ujzZIu_IfF-Z3X_GEg2R6KLI"; // gs pre-sales key

// Hardcoded follow-up rule applied to every campaign (UI for it is hidden):
// when interested_to_take_loan == yes, after 30s call the Karnataka follow-up agent.
const HARDCODED_FOLLOWUP_RULES = [{
  field: "interested_to_take_loan",
  operator: "equals",
  value: "yes",
  delay: 30,
  unit: "seconds",
  followup_agent_id: "413aed2c-0c2d-4a3a-bf84-dd384b80f9be",
  followup_agent_name: "Karnataka Bank Limited - follow up agent",
}];

const state = {
  token: API_TOKEN,
  agentId: "",
  phoneNumber: "",
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
  phoneCombo.setOptions(state.recentNumbers.map(n => ({ value: n, label: n })));
}
refreshNumberOptions();

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
function saveFollowupConfig(campaignId, createdAt, rules) {
  if (!rules.length) return;
  const k = fuStoreKey(); if (!k) return;
  const store = loadFollowupStore();
  store[campaignId] = {
    created_at: createdAt, source_number: state.phoneNumber,
    batch_agent_id: state.agentId, batch_agent_name: agentName(state.agentId), rules,
  };
  localStorage.setItem(k, JSON.stringify(store));
}
// Collapse stored configs so there is at most ONE per batch agent (keep the
// most recent) and force its rule to the current hardcoded rule. This removes
// stale duplicates like an old "1 minutes" rule alongside the "30 seconds" one.
function normalizeFollowupStore() {
  const k = fuStoreKey(); if (!k) return;
  const store = loadFollowupStore();
  const byAgent = {};
  for (const id of Object.keys(store)) {
    const cfg = store[id], a = cfg.batch_agent_id || "";
    if (!byAgent[a] || (cfg.created_at || "") > (byAgent[a].cfg.created_at || "")) byAgent[a] = { id, cfg };
  }
  const next = {};
  for (const a of Object.keys(byAgent)) {
    const { id, cfg } = byAgent[a];
    next[id] = { ...cfg, rules: HARDCODED_FOLLOWUP_RULES };
  }
  localStorage.setItem(k, JSON.stringify(next));
}
function loadRuns() { const k = fuRunsKey(); return k ? JSON.parse(localStorage.getItem(k) || "{}") : {}; }
function saveRuns(r) { const k = fuRunsKey(); if (k) localStorage.setItem(k, JSON.stringify(r)); }
function isArmed() { return localStorage.getItem("gupshup_followup_armed") === "1"; }
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
async function fireFollowup({ followup_agent_id, source_number, phone_number, metadata }) {
  return api("/call", {
    method: "POST",
    body: { agent_id: followup_agent_id, source_number, phone_number, metadata: metadata || {} },
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
    const earliest = ids.map(id => configs[id].created_at).filter(Boolean).sort()[0];
    let path = "/calls?page=1&page_size=100&direction=outbound";
    if (earliest) path += "&from_date=" + encodeURIComponent(earliest);
    const res = await api(path);
    const calls = res.data || [];
    const runs = loadRuns();
    const rule = HARDCODED_FOLLOWUP_RULES[0];   // single global rule
    // Every call id that already has a run (any status / any old key) → never handle again.
    const handledCallIds = new Set(Object.values(runs).map(r => r.callId));
    for (const call of calls) {
      if (call.status !== "completed" || !call.details_collection) continue;
      if (handledCallIds.has(call.id)) continue;   // dedup per call, even across old keys
      // Find the campaign this call belongs to (batch agent + time) — only to get its source number.
      const cid = ids.find(id => configs[id].batch_agent_id === call.agent_id &&
        (!configs[id].created_at || new Date(call.started_at) >= new Date(configs[id].created_at)));
      if (!cid) continue;
      const key = `${call.id}::${rule.followup_agent_id}`;
      if (runs[key]) continue;
      if (!matchesCondition(call.details_collection, rule)) continue;
      const base = new Date(call.ended_at || call.started_at).getTime();
      runs[key] = {
        key, campaignId: cid, callId: call.id,
        phone: call.phone_number, source_number: configs[cid].source_number,
        followup_agent_id: rule.followup_agent_id, followup_agent_name: rule.followup_agent_name,
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
  const runs = loadRuns();
  const now = Date.now(), armed = isArmed();
  for (const key of Object.keys(runs)) {
    const r = runs[key];
    if (r.status !== "scheduled" && r.status !== "due") continue;
    if (r.fireAt > now) continue;
    if (!armed) { r.status = "due"; continue; }
    await sendFollowup(r, runs);
  }
  saveRuns(runs);
}
async function sendFollowup(r, runs) {
  try {
    await fireFollowup({
      followup_agent_id: r.followup_agent_id, source_number: r.source_number, phone_number: r.phone,
      metadata: { ...r.collected, followup_reason: r.reason, previous_call_id: r.callId, previous_call_summary: r.summary },
    });
    r.status = "sent"; r.sentAt = Date.now();
  } catch (e) { r.status = "failed"; r.error = e.message; }
  if (runs) { runs[r.key] = r; saveRuns(runs); }
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
       <div>When <b>${escapeHtml(r.field)}</b> ${escapeHtml(opLabel(r.operator))}${r.value ? ` <b>${escapeHtml(r.value)}</b>` : ""} → call within <b>${r.delay} ${escapeHtml(r.unit)}</b> with <b>${escapeHtml(r.followup_agent_name || "agent")}</b></div></div>`
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
        <div class="who">${icon("phone")} ${escapeHtml(r.phone || "—")} <span style="color:var(--muted);font-weight:400">→ ${escapeHtml(r.followup_agent_name || "agent")}</span></div>
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
  const ok = $("#c_name").value.trim() && state.agentId && state.phoneNumber &&
             state.contacts.length > 0 && $("#c_phone_column").value;
  $("#startNowBtn").disabled = !ok;
  $("#scheduleBtn").disabled = !ok;
  return ok;
}
$("#c_name").addEventListener("input", validate);

function buildPayload({ scheduled } = {}) {
  const map = state.colMap || {};
  // Remap every contact key to its sanitized name so the API accepts them.
  const contacts = state.contacts.map(row => {
    const out = {};
    for (const k in row) out[map[k] || sanitizeKey(k)] = row[k];
    return out;
  });
  const selected = $("#c_phone_column").value;
  const payload = {
    name: $("#c_name").value.trim(),
    agent_id: state.agentId,
    phone_number: state.phoneNumber,
    phone_column: map[selected] || sanitizeKey(selected),
    contacts,
    max_concurrent_calls: parseInt(concSel.value) || 1,
  };
  if (scheduled) {
    const d = $("#c_sched_date").value, t = $("#c_sched_time").value;
    payload.schedule_time = new Date(`${d}T${t || "00:00"}`).toISOString();
  }
  if ($("#c_daily_start").value) payload.daily_start_time = $("#c_daily_start").value;
  if ($("#c_daily_end").value) payload.daily_end_time = $("#c_daily_end").value;
  if ($("#r_enabled").checked) {
    payload.retry_config = {
      enabled: true,
      on_statuses: $("#r_on_statuses").value.split(",").map(s => s.trim()).filter(Boolean),
      interval_value: parseInt($("#r_interval_value").value) || 30,
      interval_unit: $("#r_interval_unit").value,
      max_retries: parseInt($("#r_max_retries").value) || 3,
      respect_calling_hours: $("#r_respect_hours").checked,
    };
  }
  const bos = [...$$("#blackoutList .blackout-row")].map(r => ({
    start: r.querySelector(".bo-start").value, end: r.querySelector(".bo-end").value,
  })).filter(b => b.start && b.end);
  if (bos.length) payload.blackout_periods = bos;
  return payload;
}

async function submitCampaign(scheduled) {
  if (!validate()) return;
  if (scheduled && !$("#c_sched_date").value) {
    setMsg("Pick a schedule date & time to schedule later.", "err"); return;
  }
  if (state.contacts.length > 2000) {
    setMsg(`Max 2000 contacts (sheet has ${state.contacts.length}).`, "err"); return;
  }
  const payload = buildPayload({ scheduled });
  $("#startNowBtn").disabled = true; $("#scheduleBtn").disabled = true;
  setMsg('<span class="spinner"></span> Creating…');
  try {
    const res = await api("/campaigns", { method: "POST", body: payload });
    const c = res.data;
    rememberNumber(state.phoneNumber);
    saveFollowupConfig(c.id, c.created_at, HARDCODED_FOLLOWUP_RULES);   // rule is hardcoded
    normalizeFollowupStore();   // keep a single config per agent
    setMsg(`Created "${c.name}" — ${c.valid_contacts ?? c.total_contacts} valid contacts (${c.status}) · follow-up active`, "ok");
    toast(scheduled ? "Campaign scheduled" : "Campaign launched", "ok");
    resetForm();
    $('.side-item[data-view="list"]').click();
  } catch (e) {
    setMsg(e.message, "err"); toast("Failed: " + e.message, "err");
  } finally { validate(); }
}
function setMsg(html, cls = "") { const m = $("#createMsg"); m.innerHTML = html; m.className = "msg " + cls; }

$("#startNowBtn").addEventListener("click", () => submitCampaign(false));
$("#scheduleBtn").addEventListener("click", () => submitCampaign(true));
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
  setMsg("");
}

/* ============================================================
   Campaigns list
   ============================================================ */
async function loadCampaigns() {
  const wrap = $("#campaignsList");
  wrap.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  try {
    let path = "/campaigns?page=1&page_size=50";
    const s = $("#statusFilter").value; if (s) path += "&status=" + encodeURIComponent(s);
    const res = await api(path);
    const items = res.data || [];
    if (!items.length) { wrap.innerHTML = '<div class="empty">No campaigns yet.</div>'; return; }
    wrap.innerHTML = ""; items.forEach(c => wrap.appendChild(campaignCard(c)));
  } catch (e) { wrap.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`; }
}
$("#reloadCampaigns").addEventListener("click", loadCampaigns);
$("#statusFilter").addEventListener("change", loadCampaigns);

function campaignCard(c) {
  const el = document.createElement("div");
  el.className = "campaign-card";
  const pickup = c.pickup_rate != null ? c.pickup_rate.toFixed(1) + "%" : "—";
  el.innerHTML = `
    <div class="campaign-main">
      <div class="campaign-name">${escapeHtml(c.name)}</div>
      <div class="campaign-meta">${shortId(c.id)} · ${fmtDate(c.created_at)}</div>
    </div>
    <div class="campaign-stats">
      <div class="stat"><b>${c.total ?? 0}</b><span>total</span></div>
      <div class="stat"><b>${c.completed ?? 0}</b><span>done</span></div>
      <div class="stat"><b>${c.failed ?? 0}</b><span>failed</span></div>
      <div class="stat"><b>${c.no_answer ?? 0}</b><span>no ans</span></div>
      <div class="stat"><b>${pickup}</b><span>pickup</span></div>
    </div>
    <span class="pill ${c.status}">${(c.status || "").replace("_", " ")}</span>
    <div class="campaign-actions"></div>`;
  const actions = el.querySelector(".campaign-actions");
  if (c.status === "in_progress" || c.status === "pending")
    actions.appendChild(btn("Pause", "", (e) => { e.stopPropagation(); act(c.id, "pause"); }, "pause"));
  else if (c.status === "paused")
    actions.appendChild(btn("Resume", "", (e) => { e.stopPropagation(); act(c.id, "resume"); }, "play"));
  if (["in_progress", "pending", "paused"].includes(c.status))
    actions.appendChild(btn("Stop", "btn-danger", (e) => { e.stopPropagation(); if (confirm("Stop this campaign?")) act(c.id, "stop"); }, "stop"));
  el.addEventListener("click", () => openBatch(c.id));
  return el;
}
function btn(label, cls, onClick, iconName) {
  const b = document.createElement("button");
  b.className = "btn btn-sm " + cls;
  b.innerHTML = (iconName ? icon(iconName) + " " : "") + escapeHtml(label);
  b.addEventListener("click", onClick); return b;
}
async function act(id, action, after) {
  try { const r = await api(`/campaigns/${id}/${action}`, { method: "POST" });
    toast(r.message || (action + " ok"), "ok"); (after || loadCampaigns)(); }
  catch (e) { toast(`${action} failed: ${e.message}`, "err"); }
}

/* ============================================================
   Batch Details — full page (only data GET /campaigns/{id} returns)
   ============================================================ */
async function openBatch(id) {
  showView("batch", { sidebar: "list" });
  $("#batchCredits").textContent = "—";
  $("#batchBody").innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  try {
    const res = await api(`/campaigns/${id}`);
    const c = res.data;
    renderBatch(c);
  } catch (e) { $("#batchBody").innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`; }
}

function statCard(label, iconName, value, foot, tone = "") {
  return `<div class="stat-card ${tone}">
    <div class="top"><span class="label">${label}</span>${icon(iconName)}</div>
    <div class="num">${value}</div>
    <div class="foot">${foot}</div>
  </div>`;
}

function renderBatch(c) {
  const done = c.completed || 0, fail = c.failed || 0, na = c.no_answer || 0, vm = c.voicemail || 0;
  const placed = done + fail + na + vm;
  const total = c.total_contacts || 0;
  const placePct = total ? Math.round(placed / total * 100) : 0;
  const pctOf = (n) => placed ? Math.round(n / placed * 100) + "% of placed" : "—";
  const pill = `<span class="pill ${c.status}">${(c.status || "").replace("_", " ")}</span>`;

  $("#batchBody").innerHTML = `
    <div class="batch-head-card">
      <div class="batch-title-row">
        <h2>${escapeHtml(c.name)}</h2>
        ${pill}
      </div>
      <span class="batch-id">${escapeHtml(c.id)}<button class="copy" data-copy="${escapeHtml(c.id)}">${icon("copy")}</button></span>
      <div class="batch-meta-row">
        <div><div class="k">Created</div><div class="v">${icon("calendar")} ${fmtDate(c.created_at)}</div></div>
        <div><div class="k">Total Calls</div><div class="v">${icon("phone")} ${total}</div></div>
        <div><div class="k">Updated</div><div class="v">${icon("clock")} ${fmtDate(c.updated_at)}</div></div>
        <div><div class="k">Description</div><div class="v">${escapeHtml(c.description || "—")}</div></div>
      </div>
    </div>

    <div class="stat-grid">
      ${statCard("Calls placed / total", "phone-call", `${placed} <span class="of">/ ${total}</span>`, `${placePct}% placement rate`, "accent")}
      ${statCard("Completed", "check-circle", done, pctOf(done), "good")}
      ${statCard("Voicemail", "voicemail", vm, vm ? pctOf(vm) : "No voicemails", "warn")}
      ${statCard("No answer", "phone-off", na, na ? pctOf(na) : "No missed", "")}
      ${statCard("Failed", "x-circle", fail, fail ? pctOf(fail) : "No failures", "bad")}
      ${statCard("Skipped", "alert-triangle", c.skipped_contacts || 0, "Invalid / skipped contacts", "")}
      ${statCard("Valid contacts", "list-checks", c.valid_contacts || 0, "Passed validation", "")}
      ${statCard("Pending retries", "refresh", c.pending_retries || 0, "Queued for retry", "")}
    </div>

    <div class="batch-sections">
      <div class="batch-section">
        <h3>${icon("clock")} Scheduling</h3>
        ${kvline("Start time", c.start_time ? fmtDate(c.start_time) : "—")}
        ${kvline("End time", c.end_time ? fmtDate(c.end_time) : "—")}
        ${kvline("Daily window", (c.daily_start_time && c.daily_end_time) ? c.daily_start_time + " – " + c.daily_end_time : "—")}
      </div>
      <div class="batch-section">
        <h3>${icon("refresh")} Retries</h3>
        ${kvline("Retry enabled", c.retry_enabled ? `<span class="tagchip on">Enabled</span>` : `<span class="tagchip off">Disabled</span>`)}
        ${kvline("Max retries", c.max_retries ?? "—")}
        ${kvline("Pending retries", (c.pending_retries || 0) + " calls")}
      </div>
      <div class="batch-section">
        <h3>${icon("sliders")} Configuration</h3>
        ${kvline("Max concurrent calls", c.max_concurrent_calls ?? "—")}
        ${kvline("Pickup rate", c.pickup_rate != null ? c.pickup_rate.toFixed(1) + "%" : "—")}
        ${kvline("Collection rate", c.collection_rate != null ? c.collection_rate.toFixed(1) + "%" : "—")}
      </div>
    </div>

    ${followupSectionHtml(c.id)}

    <div class="actionbar" id="batchActions" style="border-top:none"></div>`;

  // Credits used = sum of placed-call costs isn't available; show total cost if present
  $("#batchCredits").textContent = c.total_cost != null ? Number(c.total_cost).toFixed(2) : "0.00";

  const ba = $("#batchActions");
  const reload = () => openBatch(c.id);
  if (c.status === "in_progress" || c.status === "pending")
    ba.appendChild(btn("Pause", "", () => act(c.id, "pause", reload), "pause"));
  else if (c.status === "paused")
    ba.appendChild(btn("Resume", "", () => act(c.id, "resume", reload), "play"));
  if (["in_progress", "pending", "paused"].includes(c.status))
    ba.appendChild(btn("Stop", "btn-danger", () => { if (confirm("Stop this campaign?")) act(c.id, "stop", reload); }, "stop"));
  ba.appendChild(btn("Refresh", "", reload, "refresh"));

  hydrateIcons($("#batchBody"));
  $("#batchBody").querySelectorAll("[data-copy]").forEach(b =>
    b.addEventListener("click", () => { navigator.clipboard.writeText(b.dataset.copy); toast("Copied ID", "ok"); }));
}
function kvline(k, v) { return `<div class="kvline"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

function followupSectionHtml(campaignId) {
  const cfg = loadFollowupStore()[campaignId];
  if (!cfg || !cfg.rules || !cfg.rules.length) return "";
  const rows = cfg.rules.map(r => `
    <div class="fu-summary"><span class="fu-ic">${icon("corner-up-right")}</span>
      <div>When <b>${escapeHtml(r.field)}</b> ${escapeHtml(opLabel(r.operator))}${r.value ? ` <b>${escapeHtml(r.value)}</b>` : ""},
      call within <b>${r.delay} ${escapeHtml(r.unit)}</b> with <b>${escapeHtml(r.followup_agent_name || "agent")}</b>.</div>
    </div>`).join("");
  return `
    <div class="batch-section" style="margin-top:20px">
      <h3>${icon("corner-up-right")} Follow-up Rules</h3>
      ${rows}
      <p class="hint" style="margin-top:10px">${icon("clock")} Evaluated from Call History after each call completes — see the Follow-ups tab.</p>
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
normalizeFollowupStore();   // collapse any stale/duplicate follow-up configs on load
if (state.token) loadAgents();
