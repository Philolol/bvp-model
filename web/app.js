const $ = (sel) => document.querySelector(sel);

function fmt(n, digits = 3) {
  if (n == null || Number.isNaN(n)) return "";
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(digits) : "";
}
function fmtOrDash(x) { return (x === '' || x == null) ? '—' : x; }

function getSiteBase() {
  try {
    const p = window.location?.pathname || '/';
    // Local dev serves UI from /web/, but api/ is at repo root
    if (p.startsWith('/web/')) return '/';
    // Otherwise, use the directory of index.html (e.g., /bvp-model/ on GH Pages)
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i + 1) : '/';
  } catch {
    return '/';
  }
}

function buildApiPath(dateStr) {
  const base = getSiteBase();
  return dateStr ? `${base}api/${dateStr}.json` : `${base}api/today.json`;
}

function formatDateInput(iso) {
  // iso like YYYY-MM-DD already good; otherwise try to normalize
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadData({ dateStr, minPa, sortKey = "score", sortDir = "desc" } = {}) {
  const status = $("#status");
  status.textContent = "Loading...";
  const url = buildApiPath(dateStr);
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();
    const hitters = Array.isArray(data?.hitters) ? data.hitters : collectFromEntries(data);
    renderCards(hitters, { minPa, sortKey, sortDir });
    status.textContent = `Loaded ${hitters.length} hitters from ${data?.date ?? "?"}`;
  } catch (e) {
    console.error(e);
    status.textContent = `Error: ${e.message}`;
  }
}

function collectFromEntries(data) {
  // Fallback to old structure: entries[].hitters
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries.flatMap(e => e.hitters || []);
}

function renderCards(rawHitters, { minPa = 85, sortKey = "score", sortDir = "desc" } = {}) {
  const container = $("#cards");
  container.innerHTML = "";
  const rows = (rawHitters || [])
    .filter(h => (h.season_pa ?? 0) >= Number(minPa || 0))
    .sort((a, b) => {
      const av = Number.isFinite(a?.[sortKey]) ? a[sortKey] : -Infinity;
      const bv = Number.isFinite(b?.[sortKey]) ? b[sortKey] : -Infinity;
      return sortDir === "desc" ? (bv - av) : (av - bv);
    });
  for (const h of rows) {
    const card = document.createElement('div');
    card.className = 'card';
    const bd = h.score_breakdown || {};
    const handCode = h.probable_pitcher_splits?.hand;
    const hand = handCode === 'L' ? 'LHP' : handCode === 'R' ? 'RHP' : '';
    const handLabel = hand || 'LHP/RHP';
    const siteLabel = h.site || 'Home/Away';
    const wtbStr = h.wtb_percent != null ? fmt(h.wtb_percent, 3) : '';
    const vsHandPA = h.ops_vs_pitcher_hand?.pa ?? '';
    const vsHandOPS = fmt(h.ops_vs_pitcher_hand?.ops);
    const sitePA = h.ops_site?.pa ?? '';
    const siteOPS = fmt(h.ops_site?.ops);
    const l7PA = h.ops_last_7_days?.pa ?? '';
    const l7OPS = fmt(h.ops_last_7_days?.ops);
    const vsPitcherName = h.probable_pitcher_splits?.name || '';
    const vsPitcherAB = h.ops_vs_pitcher?.ab ?? '';
    const vsPitcherOPS = fmt(h.ops_vs_pitcher?.ops);
    const breakdownOrder = ['wtb','h9_side','h9_28','ops_hand','ops_site','last7','opp','h2h'];
    const breakdownLabels = {
      wtb: 'WTB',
      h9_side: 'H9 vs Side',
      h9_28: 'H9 (28d)',
      ops_hand: 'OPS vs Hand',
      ops_site: 'OPS Site',
      last7: 'Last 7',
      opp: 'Opportunity',
      h2h: 'H2H'
    };
    const breakdownRows = breakdownOrder.map(k => {
      const v = bd?.[k];
      const pts = Number.isFinite(v) ? v : '—';
      return `<tr><th scope="row">${breakdownLabels[k] || k}</th><td>${pts}</td></tr>`;
    }).join('');

    card.innerHTML = `
      <h3>${h.name ?? ''}</h3>
      ${h.headshot ? `<img src="${h.headshot}" alt="${h.name}" />` : ''}
      <div class="score">${fmt(h.score, 0)}</div>
      <div class="meta">Batting ${h.projectedBattingOrder ?? ''} • Season PA ${h.season_pa ?? ''}</div>
      <div class="stats">
        <div class="stat stat-full">
          <span class="label">wTB %:</span>
          <div class="line">${wtbStr}</div>
        </div>
        <div class="stats-two">
          <div class="stats-two-headers">
            <div class="stat"><span class="label">Splits Breakdown:</span></div>
            <div class="stat score-col"><span class="label">Score Breakdown:</span></div>
          </div>
          <div class="stats-two-body">
            <div class="stat">
              <table class="stats-table">
                <thead>
                  <tr><th></th><th>PA</th><th>OPS</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">vs ${handLabel}</th>
                    <td>${fmtOrDash(vsHandPA)}</td>
                    <td>${fmtOrDash(vsHandOPS)}</td>
                  </tr>
                  <tr>
                    <th scope="row">${siteLabel}</th>
                    <td>${fmtOrDash(sitePA)}</td>
                    <td>${fmtOrDash(siteOPS)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Last 7 Days</th>
                    <td>${fmtOrDash(l7PA)}</td>
                    <td>${fmtOrDash(l7OPS)}</td>
                  </tr>
                </tbody>
              </table>
              <table class="stats-table" style="margin-top:8px;">
                <thead>
                  <tr><th></th><th>AB</th><th>OPS</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">vs ${vsPitcherName}</th>
                    <td>${fmtOrDash(vsPitcherAB)}</td>
                    <td>${fmtOrDash(vsPitcherOPS)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="stat score-col">
              <table class="stats-table">
                <thead>
                  <tr><th></th><th>Pts</th></tr>
                </thead>
                <tbody>
                  ${breakdownRows}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  }
}

function addDaysISO(iso, delta) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + delta);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function getSortParamsFromControls() {
  const sel = document.getElementById('sortSelect');
  const btn = document.getElementById('sortDirBtn');
  const sortKey = sel?.value || 'score';
  const sortDir = (btn?.dataset?.dir) || 'desc';
  return { sortKey, sortDir };
}

function setControlsFromQuery() {
  const sp = new URLSearchParams(location.search);
  const qSort = sp.get('sort');
  const qDir = sp.get('dir');
  const sel = document.getElementById('sortSelect');
  const btn = document.getElementById('sortDirBtn');
  if (qSort && sel) sel.value = qSort;
  if (btn) {
    const dir = (qDir === 'asc' || qDir === 'desc') ? qDir : 'desc';
    btn.dataset.dir = dir;
    btn.textContent = dir === 'desc' ? 'Desc' : 'Asc';
  }
}

function updateQueryFromControls() {
  const { sortKey, sortDir } = getSortParamsFromControls();
  const url = new URL(location.href);
  url.searchParams.set('sort', sortKey);
  url.searchParams.set('dir', sortDir);
  history.replaceState(null, '', url);
}

function initControls() {
  const dateInput = $("#dateInput");
  const loadBtn = $("#loadBtn");
  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  const sortSelect = document.getElementById('sortSelect');
  const sortDirBtn = document.getElementById('sortDirBtn');

  // Prefer ?date=YYYY-MM-DD, else today
  const sp = new URLSearchParams(location.search);
  const qDate = sp.get('date');
  const qSort = sp.get('sort');
  const qDir = sp.get('dir');
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  dateInput.value = qDate || todayISO;
  // Initialize sort controls from query
  setControlsFromQuery();

  loadBtn.addEventListener("click", () => {
    const dateStr = dateInput.value?.trim();
    const url = new URL(location.href);
    url.searchParams.set('date', dateStr);
    history.replaceState(null, '', url);
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr, minPa: 85, sortKey, sortDir });
  });

  // Auto-load when the date input changes or Enter is pressed
  const triggerLoad = () => {
    const dateStr = dateInput.value?.trim();
    const url = new URL(location.href);
    url.searchParams.set('date', dateStr);
    history.replaceState(null, '', url);
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr, minPa: 85, sortKey, sortDir });
  };
  dateInput.addEventListener('change', triggerLoad);
  dateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerLoad();
  });

  prevBtn.addEventListener('click', () => {
    const dateStr = dateInput.value?.trim();
    const prev = addDaysISO(dateStr, -1);
    dateInput.value = prev;
    const url = new URL(location.href);
    url.searchParams.set('date', prev);
    history.replaceState(null, '', url);
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr: prev, minPa: 85, sortKey, sortDir });
  });

  nextBtn.addEventListener('click', () => {
    const dateStr = dateInput.value?.trim();
    const next = addDaysISO(dateStr, 1);
    dateInput.value = next;
    const url = new URL(location.href);
    url.searchParams.set('date', next);
    history.replaceState(null, '', url);
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr: next, minPa: 85, sortKey, sortDir });
  });

  sortSelect?.addEventListener('change', () => {
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr: dateInput.value?.trim(), minPa: 85, sortKey, sortDir });
  });

  sortDirBtn?.addEventListener('click', () => {
    const dir = (sortDirBtn.dataset.dir === 'asc') ? 'desc' : 'asc';
    sortDirBtn.dataset.dir = dir;
    sortDirBtn.textContent = dir === 'desc' ? 'Desc' : 'Asc';
    updateQueryFromControls();
    const { sortKey, sortDir } = getSortParamsFromControls();
    loadData({ dateStr: dateInput.value?.trim(), minPa: 85, sortKey, sortDir });
  });
}

initControls();
// Initial load based on current controls
(() => {
  const dateStr = $("#dateInput").value;
  const { sortKey, sortDir } = getSortParamsFromControls();
  loadData({ dateStr, minPa: 85, sortKey, sortDir });
})();
