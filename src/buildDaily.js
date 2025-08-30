
// For ALL games tomorrow, for each listed probable pitcher:
// - Find opposing hitters who batted 1–5 at least once in last 7 days
// - Compute projected batting order from last 7 games (mode of lineup slots; tiebreak = most recent)
// - Fetch each hitter's OPS vs that probable pitcher (season)
// - Emit compact JSON with projectedOrder + evidence

import fs from "fs";
import path from "path";

const BASE = "https://statsapi.mlb.com/api/v1";
const MLB_IMG_BASE = "https://img.mlbstatic.com/mlb-photos/image/upload";

// ---------- utils ----------
function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Build MLB headshot URL for a player id (default width 213)
function headshotUrl(personId, width = 213) {
  if (!personId) return null;
  const w = Number(width) || 213;
  return `${MLB_IMG_BASE}/d_people:generic:headshot:67:current.png/w_${w},q_auto:best/v1/people/${personId}/headshot/67/current`;
}

// Estimated plate appearances by batting slot and site
// Values provided by user for slots 1–5
const PROJECTED_PA_TABLE = {
  home: { 1: 4.49, 2: 4.40, 3: 4.30, 4: 4.20, 5: 4.10 },
  away: { 1: 4.69, 2: 4.59, 3: 4.49, 4: 4.39, 5: 4.28 }
};
function projectedPAFor(slot, isHome) {
  if (!Number.isFinite(slot)) return null;
  const site = isHome ? 'home' : 'away';
  const val = PROJECTED_PA_TABLE[site]?.[slot];
  return typeof val === 'number' ? val : null;
}

// ---------- scoring helpers ----------
const OPS_BASELINE = 0.72; // league-ish baseline
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function normOPS(ops) {
  if (ops == null) return 0.5; // neutral
  const min = 0.40, max = 1.050; // reasonable OPS band
  return clamp((ops - min) / (max - min), 0, 1);
}
function normH9(h9) {
  if (!Number.isFinite(h9)) return 0.5;
  const min = 6.0, max = 12.0; // typical H/9 band
  return clamp((h9 - min) / (max - min), 0, 1);
}
function normPA(pa) {
  if (!Number.isFinite(pa)) return 0.5;
  const min = 3.8, max = 4.8; // PA range for 1–5 hitters
  return clamp((pa - min) / (max - min), 0, 1);
}
// Weight WTB by season PA confidence: below MIN dampens, MAX reaches full weight
const WTB_PA_MIN = 150;   // start of confidence ramp
const WTB_PA_MAX = 500;   // full confidence at/above this PA
const WTB_PA_FLOOR = 0.65; // minimum fraction of WTB weight
function wtbPAConfidence(pa) {
  if (!Number.isFinite(pa)) return WTB_PA_FLOOR; // conservative if missing
  const x = clamp((pa - WTB_PA_MIN) / (WTB_PA_MAX - WTB_PA_MIN), 0, 1);
  const eased = Math.sqrt(x); // faster early gain, smoother tail
  return WTB_PA_FLOOR + (1 - WTB_PA_FLOOR) * eased;
}
// Normalize weighted TB% around league baseline and elite threshold
function normWTB(w) {
  if (!Number.isFinite(w)) return 0.5; // neutral if missing
  const floor = 0.190;      // poor
  const base = 0.223;      // league average
  const elite = 0.272;     // elite (and above)
  if (w <= floor) return 0;
  if (w >= elite) return 1;
  if (w === base) return 0.5;
  if (w > base) {
    return 0.5 + 0.5 * ((w - base) / (elite - base));
  }
  // w between floor and base
  return 0.5 * ((w - floor) / (base - floor));
}

// H2H calibration grid from user-provided expectations (points out of 30)
// Columns = OPS bins: 0.2, 0.4, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.2, 1.4, 2.0+
// Rows = AB 1..25
const H2H_OPS_BINS = [0.2, 0.4, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.2, 1.4, 2.0];
const H2H_GRID_POINTS = [
  [14, 14, 14, 14, 14, 16, 16, 16, 16, 17, 17, 19], // 1
  [10, 11, 13, 13, 14, 16, 16, 17, 17, 18, 24, 29], // 2
  [10, 11, 12, 12, 14, 16, 19, 19, 19, 20, 24, 29], // 3
  [6, 7, 11, 11, 14, 17, 20, 19, 20, 22, 28, 30], // 4
  [5, 7, 10, 11, 14, 17, 20, 20, 23, 25, 28, 30], // 5
  [5, 7, 8, 11, 14, 17, 20, 20, 24, 26, 29, 30], // 6
  [5, 7, 7, 10, 14, 17, 20, 22, 25, 26, 29, 30], // 7
  [4, 6, 7, 10, 14, 18, 20, 22, 25, 28, 29, 30], // 8
  [4, 6, 7, 10, 14, 18, 20, 22, 25, 28, 29, 30], // 9
  [4, 5, 7, 10, 14, 18, 20, 22, 26, 28, 29, 30], // 10
  [2, 4, 7, 10, 14, 18, 20, 22, 26, 28, 29, 30], // 11
  [2, 4, 7, 8, 14, 19, 20, 22, 28, 28, 29, 30], // 12
  [2, 4, 7, 8, 14, 19, 22, 23, 28, 29, 29, 30], // 13
  [2, 2, 7, 8, 14, 19, 22, 23, 28, 29, 30, 30], // 14
  [2, 2, 6, 8, 14, 19, 22, 23, 28, 29, 30, 30], // 15
  [2, 2, 6, 7, 14, 20, 23, 23, 29, 29, 30, 30], // 16
  [2, 2, 6, 7, 14, 20, 23, 24, 29, 29, 30, 30], // 17
  [2, 2, 5, 7, 14, 20, 23, 24, 29, 30, 30, 30], // 18
  [2, 2, 5, 7, 14, 22, 23, 25, 29, 30, 30, 30], // 19
  [1, 1, 5, 7, 14, 22, 24, 25, 29, 30, 30, 30], // 20
  [1, 1, 4, 6, 14, 22, 24, 26, 30, 30, 30, 30], // 21
  [1, 1, 4, 6, 14, 22, 24, 26, 30, 30, 30, 30], // 22
  [1, 1, 4, 6, 14, 22, 25, 26, 30, 30, 30, 30], // 23
  [1, 1, 4, 6, 14, 22, 25, 28, 30, 30, 30, 30], // 24
  [1, 1, 4, 6, 14, 22, 25, 28, 30, 30, 30, 30]  // 25
];

// Bilinear interpolation over AB (1..25) and OPS bins to get share in [0, 0.30]
function h2hWeightFromGrid(ab, ops) {
  if (!Number.isFinite(ab)) ab = 0;
  if (!Number.isFinite(ops)) ops = OPS_BASELINE;
  // Clamp AB to [1,25], map 0/negatives to 1
  const abClamped = clamp(Math.round(ab), 1, 25);
  const r0 = abClamped - 1;
  const r1 = r0; // AB are integers; if fractional AB appear, extend to interpolate
  const t = 0;   // no AB interpolation needed for integer AB

  // Clamp OPS to [first_bin, last_bin]
  const opsClamped = clamp(ops, H2H_OPS_BINS[0], H2H_OPS_BINS[H2H_OPS_BINS.length - 1]);
  // Find bin indices i (low) and i+1 (high)
  let i = 0;
  for (let k = 0; k < H2H_OPS_BINS.length - 1; k++) {
    if (opsClamped >= H2H_OPS_BINS[k] && opsClamped <= H2H_OPS_BINS[k + 1]) { i = k; break; }
  }
  const lo = H2H_OPS_BINS[i];
  const hi = H2H_OPS_BINS[Math.min(i + 1, H2H_OPS_BINS.length - 1)];
  const u = hi > lo ? (opsClamped - lo) / (hi - lo) : 0;

  const row0 = H2H_GRID_POINTS[r0];
  const row1 = H2H_GRID_POINTS[r1];
  const v0 = row0[i] + u * (row0[Math.min(i + 1, row0.length - 1)] - row0[i]);
  const v1 = row1[i] + u * (row1[Math.min(i + 1, row1.length - 1)] - row1[i]);
  const points = v0 + t * (v1 - v0);
  return clamp(points / 100, 0, 0.30); // 30% weight on H2H
}
const SCORE_WEIGHTS = {
  // baseline skill
  wtb: 0.30,
  h9_side: 0.04,
  h9_28: 0.02,
  // ops splits
  ops_hand: 0.15,
  ops_site: 0.04,
  // recency
  last7: 0.10,
  // opportunity volume
  opp: 0.05,
  // head-to-head (gated by AB)
  h2h: 0.15
};
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} :: ${url}`);
  return r.json();
}
// battingOrder like "101","201"..."901" → hundreds digit = lineup slot (1..9)
function battingOrderSlot(bo) {
  if (!bo) return null;
  const n = Number(bo);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / 100) || null;
}

function chooseProjectedOrder(counts, latestSlot) {
  let bestSlot = null, bestCount = -1;
  for (const [slotStr, count] of Object.entries(counts)) {
    const slot = Number(slotStr);
    if (count > bestCount) { bestCount = count; bestSlot = slot; }
    else if (count === bestCount && slot === latestSlot) { bestSlot = slot; } // tie-breaker to latest
  }
  return bestSlot;
}

// ---------- MLB calls ----------
async function getScheduleByDate(dateStr) {
  const url = `${BASE}/schedule?sportId=1&date=${dateStr}&hydrate=team,probablePitcher`;
  return fetchJSON(url);
}
async function getTeamScheduleRange(teamId, startDate, endDate) {
  const url = `${BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}`;
  return fetchJSON(url);
}
async function getBoxscore(gamePk) {
  return fetchJSON(`${BASE}/game/${gamePk}/boxscore`);
}

async function getVsPitcherOPS(batterIds, pitcherId, season) {
  if (!batterIds.length) return [];
  const hydrate = `stats(group=[hitting],type=[vsPlayer],opposingPlayerId=${pitcherId},sportId=1,gameType=R,season=${season})`;
  const qs = new URLSearchParams({ personIds: batterIds.join(","), hydrate });
  const url = `${BASE}/people?${qs.toString()}`;
  const data = await fetchJSON(url);

  const rows = [];
  for (const p of data.people ?? []) {
    const splits = p?.stats?.[0]?.splits ?? [];
    const stat = splits[0]?.stat ?? {};
    const ops = typeof stat.ops === "number" ? stat.ops
      : typeof stat.ops === "string" ? Number(stat.ops) : null;
    rows.push({
      id: Number(p.id),
      name: p.fullName,
      ops_vs_pitcher: ops,
      ab_vs_pitcher: stat.atBats ?? null,
      pa_vs_pitcher: plateAppearances(stat ?? {})
    });
  }
  return rows;
}

// Fetch a single probable pitcher's season pitching stat object
async function getPitcherSeasonPitchingStats(pitcherId, season) {
  if (!pitcherId) return null;
  const hydrate = `stats(group=[pitching],type=[season],sportId=1,gameType=R,season=${season})`;
  const url = `${BASE}/people?personIds=${pitcherId}&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJSON(url);
  const person = (data?.people ?? [])[0];
  const stat = person?.stats?.[0]?.splits?.[0]?.stat ?? null;
  return stat || null;
}

// ----- Pitcher hand ("L"/"R") -----
async function getPitcherHand(pitcherId) {
  if (!pitcherId) return null;
  const url = `${BASE}/people/${pitcherId}`;
  const data = await fetchJSON(url);
  const p = (data?.people ?? [])[0];
  return p?.pitchHand?.code ?? null; // "L" | "R" | null
}

async function getOpsVsPitcherHandFromStatSplits(batterIds, season) {
  const map = new Map();
  if (!batterIds.length) return map;

  const hydrate = `stats(group=[hitting],type=[statSplits],sportId=1,gameType=R,season=${season},sitCodes=[vl,vr])`;
  const qs = new URLSearchParams({ personIds: batterIds.join(","), hydrate });
  const url = `${BASE}/people?${qs.toString()}`;
  const data = await fetchJSON(url);

  for (const p of data.people ?? []) {
    let vsLHP = null, vsRHP = null, vsLHP_PA = null, vsRHP_PA = null;
    const splits = p?.stats?.[0]?.splits ?? [];
    for (const s of splits) {
      const code = s?.split?.code?.toLowerCase?.(); // "vl" / "vr" / others
      const rawOps = s?.stat?.ops;
      const ops = typeof rawOps === "number" ? rawOps
          : typeof rawOps === "string" ? Number(rawOps) : null;
      const pa = plateAppearances(s?.stat ?? {});

      if (code === "vl") { vsLHP = ops; vsLHP_PA = Number.isFinite(pa) ? pa : null; }
      else if (code === "vr") { vsRHP = ops; vsRHP_PA = Number.isFinite(pa) ? pa : null; }
    }
    map.set(Number(p.id), { vsLHP, vsRHP, vsLHP_PA, vsRHP_PA });
  }
  return map;
}
function pickOpsVsHand(entry, pitcherHand) {
  if (!entry || !pitcherHand) return null;
  return pitcherHand === "L" ? (entry.vsLHP ?? null) : (entry.vsRHP ?? null);
}
function pickPA_VsHand(entry, pitcherHand) {
  if (!entry || !pitcherHand) return null;
  return pitcherHand === "L" ? (entry.vsLHP_PA ?? null) : (entry.vsRHP_PA ?? null);
}

// Reusable probable pitcher splits object (expand with split stats later)
function buildProbablePitcherSplits(pitcher) {
  if (!pitcher) return null;
  return {
    id: pitcher.id ?? null,
    name: pitcher.name ?? null,
    headshotUrl: headshotUrl(pitcher.id) ?? null,
    hitsPer9Inn: (Number.isFinite(pitcher.hitsPer9Inn) ? Number(pitcher.hitsPer9Inn) : null),
    hitsPer9Inn_site: (Number.isFinite(pitcher.hitsPer9Inn_site) ? Number(pitcher.hitsPer9Inn_site) : null),
    hitsPer9Inn_last_28_days: (Number.isFinite(pitcher.hitsPer9Inn_last_28_days) ? Number(pitcher.hitsPer9Inn_last_28_days) : null)
  };
}

async function getSeasonStats(batterIds, season) {
  if (!batterIds.length) return [];
  const hydrate = `stats(group=[hitting],type=[season],sportId=1,gameType=R,season=${season})`;
  const url = `${BASE}/people?personIds=${batterIds.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;
  return fetchJSON(url);
}

function plateAppearances(stat) {
  if (typeof stat.plateAppearances === "number") return stat.plateAppearances;
  const ab = stat.atBats ?? 0;
  const bb = stat.baseOnBalls ?? 0;
  const hbp = stat.hitByPitch ?? 0;
  const sf = stat.sacFlies ?? 0;
  const sh = stat.sacBunts ?? 0;
  return ab + bb + hbp + sf + sh;
}

function computeWTB(stat) {
  const hits = stat.hits ?? 0;
  const pa = plateAppearances(stat);
  return pa > 0 ? hits / pa : 0;
}

// Format Date -> MM/DD/YYYY (US style) for dateRange hydrates
function fmtUSDate(y, m, d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(m)}/${pad(d)}/${y}`;
}

function pacificTodayYMD() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

function addDaysYMD({ y, m, d }, delta) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// Fetch OPS over a date range (inclusive) for each batter
async function getRangeOPS(batterIds, startMDY, endMDY) {
  const map = new Map();
  if (!batterIds?.length) return map;
  const hydrate = `stats(group=[hitting],type=[byDateRange],startDate=${startMDY},endDate=${endMDY},force=True)`;
  const qs = new URLSearchParams({ personIds: batterIds.join(","), hydrate });
  const url = `${BASE}/people?${qs.toString()}`;
  const data = await fetchJSON(url);
  for (const p of data.people ?? []) {
    const stat = p?.stats?.[0]?.splits?.[0]?.stat ?? null;
    const rawOps = stat?.ops;
    const ops = typeof rawOps === 'number' ? rawOps : typeof rawOps === 'string' ? Number(rawOps) : null;
    const pa = plateAppearances(stat ?? {});
    map.set(Number(p.id), { ops: ops ?? null, pa: Number.isFinite(pa) ? pa : null });
  }
  return map;
}

// Fetch a single pitcher's hitsPer9Inn over a date range (inclusive, based on Pacific dates)
async function getPitcherHitsPer9ByDateRange(pitcherId, startMDY, endMDY) {
  if (!pitcherId) return null;
  const hydrate = `stats(group=[pitching],type=[byDateRange],startDate=${startMDY},endDate=${endMDY},force=True)`;
  const url = `${BASE}/people?personIds=${pitcherId}&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJSON(url);
  const stat = data?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat ?? null;
  const raw = stat?.hitsPer9Inn;
  const val = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
  return Number.isFinite(val) ? Number(val) : null;
}

// Get season home/away OPS splits for a list of batters
async function getHomeAwaySplits(batterIds, season) {
  if (!batterIds.length) return new Map();
  // homeAndAway returns two splits: HOME and AWAY
  const hydrate = `stats(group=[hitting],type=[homeAndAway],sportId=1,gameType=R,season=${season})`;
  const url = `${BASE}/people?personIds=${batterIds.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJSON(url);


  const map = new Map(); // id -> { home: { ops, pa }, away: { ops, pa } }
  for (const p of data.people ?? []) {
    let home = { ops: null, pa: null }, away = { ops: null, pa: null };
    const splits = p?.stats?.[0]?.splits ?? [];
    for (const s of splits) {
      const stat = s?.stat ?? {};
      const ops =
        typeof stat.ops === "number"
          ? stat.ops
          : typeof stat.ops === "string"
          ? Number(stat.ops)
          : null;
      const pa = plateAppearances(stat);
      const labelRaw = s?.homeOrAway ?? s?.homeAway ?? s?.split ?? s?.label ?? "";
      const label = String(labelRaw).toLowerCase();
      const isHome = s?.isHome === true || label === "home" || label.includes("home");
      const isAway = s?.isHome === false || label === "away" || label.includes("away");
      if (isHome) home = { ops: ops ?? null, pa: Number.isFinite(pa) ? pa : null };
      if (isAway) away = { ops: ops ?? null, pa: Number.isFinite(pa) ? pa : null };
    }
    map.set(Number(p.id), { home, away });
  }
  return map;
}

// Get season Home/Away pitching hitsPer9Inn for a probable pitcher
async function getPitcherHomeAwayHitsPer9(pitcherId, season) {
  if (!pitcherId) return { home: null, away: null };
  const hydrate = `stats(group=[pitching],type=[homeAndAway],sportId=1,gameType=R,season=${season})`;
  const url = `${BASE}/people?personIds=${pitcherId}&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJSON(url);

  let home = null, away = null;
  const splits = data?.people?.[0]?.stats?.[0]?.splits ?? [];
  for (const s of splits) {
    const stat = s?.stat ?? {};
    const raw = stat.hitsPer9Inn;
    const val = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
    const labelRaw = s?.homeOrAway ?? s?.homeAway ?? s?.split ?? s?.label ?? '';
    const label = String(labelRaw).toLowerCase();
    const isHome = s?.isHome === true || label === 'home' || label.includes('home');
    const isAway = s?.isHome === false || label === 'away' || label.includes('away');
    if (isHome && Number.isFinite(val)) home = Number(val);
    if (isAway && Number.isFinite(val)) away = Number(val);
  }
  return { home, away };
}

function pickHomeAwayOPS(haMapEntry, isOpponentHome) {
  if (!haMapEntry) return null;
  // Support both old shape ({homeOPS, awayOPS}) and new shape ({home:{ops,pa}, away:{ops,pa}})
  if (haMapEntry.home && haMapEntry.away) {
    return isOpponentHome ? (haMapEntry.home?.ops ?? null) : (haMapEntry.away?.ops ?? null);
  }
  return isOpponentHome ? haMapEntry.homeOPS ?? null : haMapEntry.awayOPS ?? null;
}

function pickHomeAwayPA(haMapEntry, isOpponentHome) {
  if (!haMapEntry) return null;
  if (haMapEntry.home && haMapEntry.away) {
    return isOpponentHome ? (haMapEntry.home?.pa ?? null) : (haMapEntry.away?.pa ?? null);
  }
  return null;
}

// Get pitcher's hitsPer9Inn vs LHB and vs RHB (season)
async function getPitcherVsBatterHandHitsPer9(pitcherId, season) {
  if (!pitcherId) return { vsLHB: null, vsRHB: null };
  const hydrate = `stats(group=[pitching],type=[statSplits],sportId=1,gameType=R,season=${season},sitCodes=[vl,vr])`;
  const url = `${BASE}/people?personIds=${pitcherId}&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJSON(url);
  let vsLHB = null, vsRHB = null;
  const splits = data?.people?.[0]?.stats?.[0]?.splits ?? [];
  for (const s of splits) {
    const code = s?.split?.code?.toLowerCase?.(); // 'vl' or 'vr'
    const raw = s?.stat?.hitsPer9Inn;
    const val = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
    if (code === 'vl' && Number.isFinite(val)) vsLHB = Number(val);
    else if (code === 'vr' && Number.isFinite(val)) vsRHB = Number(val);
  }
  return { vsLHB, vsRHB };
}

// Batch fetch bat-side ('L' | 'R' | 'S') for hitters
async function getBatSides(batterIds) {
  const map = new Map();
  if (!batterIds?.length) return map;
  const url = `${BASE}/people?personIds=${batterIds.join(',')}`;
  const data = await fetchJSON(url);
  for (const p of data.people ?? []) {
    const code = p?.batSide?.code ?? null; // 'L','R','S'
    map.set(Number(p.id), code ?? null);
  }
  return map;
}


// ---------- core per-probable workflow ----------
async function analyzeProbable({ game, probableSide, season, start7, endDate }) {
  const pObj = game?.teams?.[probableSide]?.probablePitcher;
  if (!pObj?.id) return null;

  const pitcher = {
    id: pObj.id,
    name: pObj.fullName,
    side: probableSide,
    teamId: game.teams[probableSide].team.id,
    teamName: game.teams[probableSide].team.name,
    headshot: headshotUrl(pObj.id)
  };

  // Enrich probable pitcher with season pitching stat: hitsPer9Inn
  try {
    const pStat = await getPitcherSeasonPitchingStats(pitcher.id, season);
    const raw = pStat?.hitsPer9Inn;
    const val = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
    pitcher.hitsPer9Inn = Number.isFinite(val) ? Number(val) : null;
  } catch {
    pitcher.hitsPer9Inn = null;
  }

  // Add site-specific hitsPer9Inn (home vs away) for the probable pitcher
  try {
    const { home, away } = await getPitcherHomeAwayHitsPer9(pitcher.id, season);
    const pitcherIsHome = probableSide === 'home';
    pitcher.hitsPer9Inn_site = pitcherIsHome ? (Number.isFinite(home) ? home : null)
                                             : (Number.isFinite(away) ? away : null);
  } catch {
    pitcher.hitsPer9Inn_site = null;
  }

  // Add last-28 days hitsPer9Inn for the probable pitcher (Pacific dates)
  try {
    const todayPT = pacificTodayYMD();
    const start28 = addDaysYMD(todayPT, -28);
    const start28MDY = fmtUSDate(start28.y, start28.m, start28.d);
    const endMDY = fmtUSDate(todayPT.y, todayPT.m, todayPT.d);

    const h9_28 = await getPitcherHitsPer9ByDateRange(pitcher.id, start28MDY, endMDY);
    pitcher.hitsPer9Inn_last_28_days = Number.isFinite(h9_28) ? Number(h9_28) : null;
  } catch {
    pitcher.hitsPer9Inn_last_28_days = null;
  }


  // Opponent is the other side
  const oppSide = probableSide === "home" ? "away" : "home";
  const opponentTeamId = game.teams[oppSide].team.id;
  const opponentTeamName = game.teams[oppSide].team.name;

  // Pull opponent's last 7 days of games
  const oppSched = await getTeamScheduleRange(opponentTeamId, start7, endDate);
  const oppGames = (oppSched?.dates ?? []).flatMap(d => d.games ?? []);

  // Track lineup slots per player across last 7 days
  // ordersByPlayer: Map<playerId, { counts: { [slot]: number }, latestSlot: number|null, latestGameDate: string }>
  const ordersByPlayer = new Map();
  const candidateBatterIds = new Set();

  for (const g of oppGames) {
    const gameDate = g.officialDate;
    try {
      const box = await getBoxscore(g.gamePk);
      const sides = [box?.teams?.home, box?.teams?.away].filter(Boolean);
      for (const side of sides) {
        if (!side?.team?.id || side.team.id !== opponentTeamId) continue;
        const players = side.players ?? {};
        for (const key of Object.keys(players)) {
          const pl = players[key];
          const pid = pl?.person?.id;
          const bo = battingOrderSlot(pl?.battingOrder);
          const posCode = pl?.position?.code;
          if (!pid || !bo || posCode === "P") continue;

          // record this slot occurrence
          let entry = ordersByPlayer.get(pid);
          if (!entry) {
            entry = { counts: {}, latestSlot: null, latestGameDate: null };
            ordersByPlayer.set(pid, entry);
          }
          entry.counts[bo] = (entry.counts[bo] ?? 0) + 1;
          // update "latest" (game list is chronological in schedule; if unsure, compare dates)
          if (!entry.latestGameDate || gameDate >= entry.latestGameDate) {
            entry.latestGameDate = gameDate;
            entry.latestSlot = bo;
          }
          // mark candidate if ever batted 1–5
          if (bo >= 1 && bo <= 5) candidateBatterIds.add(pid);
        }
      }
    } catch {
      // skip if boxscore missing
    }
  }

  const batterIds = Array.from(candidateBatterIds);

  const isOpponentHome = game.teams.away.team.id !== opponentTeamId; // opponent is the "home" side if its id matches game.teams.home
  const opponentIsHome = game.teams.home.team.id === opponentTeamId;
  // Fetch season home/away OPS splits for those batters
  const siteSplitsMap = await getHomeAwaySplits(batterIds, season);
  // Fetch last-7-days OPS (based on current Pacific date)
  const todayPT = pacificTodayYMD();
  const start7d = addDaysYMD(todayPT, -7);
  const startMDY = fmtUSDate(start7d.y, start7d.m, start7d.d);
  const endMDY = fmtUSDate(todayPT.y, todayPT.m, todayPT.d);
  const last7Map = await getRangeOPS(batterIds, startMDY, endMDY);
  // (removed) day/night OPS splits

  // Build projected order per player from collected counts
  const projections = new Map(); // playerId -> { projectedOrder, orderCounts, orderSampleSize }
  for (const pid of batterIds) {
    const entry = ordersByPlayer.get(pid);
    if (!entry) continue;
    const projectedOrder = chooseProjectedOrder(entry.counts, entry.latestSlot ?? null);
    const orderCounts = entry.counts;
    const orderSampleSize = Object.values(orderCounts).reduce((a,b)=>a+b,0);
    projections.set(pid, { projectedOrder, orderCounts, orderSampleSize });
  }

  const seasonData = await getSeasonStats(batterIds, season);
  const seasonWTBMap = new Map();
  const seasonPAMap = new Map();
  for (const p of seasonData.people ?? []) {
    const stat = p?.stats?.[0]?.splits?.[0]?.stat ?? {};
    const pid = Number(p.id);
    seasonWTBMap.set(pid, computeWTB(stat));
    seasonPAMap.set(pid, plateAppearances(stat));
  }

  const pitcherHand = await getPitcherHand(pitcher.id); // "L" or "R"
  // Fetch OPS vs this probable pitcher
  const vsRows = await getVsPitcherOPS(batterIds, pitcher.id, season);

  const vsHandMap = await getOpsVsPitcherHandFromStatSplits(batterIds, season);

  // Fetch pitcher's splits vs LHB/RHB (hitsPer9Inn) and bat-side for each hitter
  const pitcherVsBatterSideH9 = await getPitcherVsBatterHandHitsPer9(pitcher.id, season); // { vsLHB, vsRHB }
  const batSideMap = await getBatSides(batterIds); // id -> 'L' | 'R' | 'S'

  // Final rows (apply your AB≥5 gate if desired)
  const hitters = vsRows
    .map(r => {
      const proj = projections.get(r.id) || { projectedOrder: null, orderCounts: {}, orderSampleSize: 0 };
      const wtb = seasonWTBMap.get(r.id) ?? null;
      const season_pa = seasonPAMap.get(r.id) ?? null;
      const siteSplits = siteSplitsMap.get(r.id);
      const opsHomeAwayForGame = pickHomeAwayOPS(siteSplits, opponentIsHome);
      const paHomeAwayForGame = pickHomeAwayPA(siteSplits, opponentIsHome);
      const handSplits = vsHandMap.get(r.id);
      const opsVsPitcherHand = pickOpsVsHand(handSplits, pitcherHand);
      const paVsPitcherHand = pickPA_VsHand(handSplits, pitcherHand);
      // (removed) ops_day_night computation
      const last7Entry = last7Map.get(r.id);
      const opsLast7 = last7Entry?.ops ?? null;
      const paLast7 = last7Entry?.pa ?? null;

      // Decide batter-side for this matchup
      const batSide = batSideMap.get(r.id) || null; // 'L' | 'R' | 'S' | null
      let pitcherH9VsBatterSide = null;
      if (batSide === 'L') pitcherH9VsBatterSide = pitcherVsBatterSideH9.vsLHB ?? null;
      else if (batSide === 'R') pitcherH9VsBatterSide = pitcherVsBatterSideH9.vsRHB ?? null;
      else if (batSide === 'S') {
        // Switch hitters bat opposite the pitcher's hand
        if (pitcherHand === 'R') pitcherH9VsBatterSide = pitcherVsBatterSideH9.vsLHB ?? null;
        else if (pitcherHand === 'L') pitcherH9VsBatterSide = pitcherVsBatterSideH9.vsRHB ?? null;
      }

      // H2H weight from calibrated grid
      const baseW = SCORE_WEIGHTS;
      const abH2H = r.ab_vs_pitcher ?? 0;
      const w_h2h_dyn = h2hWeightFromGrid(abH2H, r.ops_vs_pitcher);

      // last7 dynamic weight with neutral baseline when PA is insufficient
      let w_last7_dyn;
      if (paLast7 != null && paLast7 >= 3 && Number.isFinite(opsLast7)) {
        const linScaleL7 = clamp(((paLast7 ?? 0) - 3) / (20 - 3), 0, 1);
        const sqrtScaleL7 = Math.sqrt(linScaleL7);
        w_last7_dyn = baseW.last7 * (0.50 + 0.50 * sqrtScaleL7);
      } else {
        // Neutral half-weight when PA insufficient or OPS missing
        w_last7_dyn = baseW.last7 * 0.50;
      }

      // Redistribute only from h9_side, h9_28, ops_hand, ops_site, last7.
      // Do NOT shrink from wtb and opp; keep them fixed.
      const fixedSum = baseW.wtb + baseW.opp + w_h2h_dyn;
      const shrinkPre = {
        h9_side: baseW.h9_side,
        h9_28: baseW.h9_28,
        ops_hand: baseW.ops_hand,
        ops_site: baseW.ops_site,
        last7: w_last7_dyn
      };
      const shrinkSum = Object.values(shrinkPre).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      const remaining = 1 - fixedSum;
      const scaleShrink = shrinkSum > 0 ? Math.max(0, remaining) / shrinkSum : 1;
      const w = {
        wtb: baseW.wtb,                  // fixed
        opp: baseW.opp,                  // fixed
        h2h: w_h2h_dyn,                  // dynamic, not scaled with others
        h9_side: shrinkPre.h9_side * scaleShrink,
        h9_28: shrinkPre.h9_28 * scaleShrink,
        ops_hand: shrinkPre.ops_hand * scaleShrink,
        ops_site: shrinkPre.ops_site * scaleShrink,
        // Cap last7 so it never exceeds its base weight
        last7: Math.min(shrinkPre.last7 * scaleShrink, baseW.last7)
      };
      // Opportunity: start at half of max opp weight at 4.10 PA, ramp to full at 4.69 PA
      const projPA = projectedPAFor(proj.projectedOrder, opponentIsHome);
      const oppMin = 4.10, oppMax = 4.69;
      const oppNorm = projPA == null ? 0.5 : clamp((projPA - oppMin) / (oppMax - oppMin), 0, 1);
      const oppShare = w.opp * (0.5 + 0.5 * oppNorm);
      const comp = {
        // Season PA-weighted WTB contribution
        wtb: (normWTB(wtb) * w.wtb) * wtbPAConfidence(season_pa),
        h9_side: normH9(pitcherH9VsBatterSide) * w.h9_side,
        h9_28: normH9(pitcher.hitsPer9Inn_last_28_days) * w.h9_28,
        ops_hand: normOPS(opsVsPitcherHand) * w.ops_hand,
        ops_site: normOPS(opsHomeAwayForGame) * w.ops_site,
        last7: normOPS(opsLast7) * w.last7,
        opp: oppShare,
        h2h: w.h2h
      };
      const scoreRaw = Object.values(comp).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      const scaledScore = Math.max(1, Math.round(clamp(scoreRaw, 0, 1) * 100));
      // Build a breakdown that pins H2H to its absolute grid value (round(w.h2h*100))
      // and scales remaining components proportionally to fill the rest, so totals match 'score'.
      const entries = Object.entries(comp);
      const absH2H = Number.isFinite(comp.h2h) ? Math.round(comp.h2h * 100) : 0;
      const others = entries.filter(([k]) => k !== 'h2h');
      const denomOthers = others.reduce((a, [, v]) => a + (Number.isFinite(v) ? v : 0), 0);
      const remainingPts = Math.max(0, scaledScore - absH2H);

      let tmp = [];
      if (denomOthers > 0) {
        // Scale other components to fill the remainder
        const scaledOthers = others.map(([k, v]) => {
          const base = Number.isFinite(v) ? v : 0;
          const scaled = remainingPts * (base / denomOthers);
          return [k, Math.max(0, Math.round(scaled))];
        });
        // Fix rounding delta among others (do not touch h2h)
        const sumOthers = scaledOthers.reduce((a, [, n]) => a + n, 0);
        let delta = remainingPts - sumOthers;
        if (delta !== 0 && scaledOthers.length > 0) {
          const maxIdx = others
            .map(([, v], i) => ({ i, v: Number.isFinite(v) ? v : -1 }))
            .sort((a, b) => b.v - a.v)[0].i;
          scaledOthers[maxIdx][1] = Math.max(0, scaledOthers[maxIdx][1] + delta);
        }
        tmp = [...scaledOthers, ['h2h', absH2H]];
      } else {
        // No other components; assign all points to H2H to match total
        tmp = [['h2h', scaledScore]];
      }
      const score = scaledScore;
      const score_breakdown = Object.fromEntries(tmp);

      return {
        id: r.id,
        name: r.name,
        headshot: headshotUrl(r.id),
        probable_pitcher_splits: {
          ...buildProbablePitcherSplits(pitcher),
          hitsPer9Inn_vs_batter_side: Number.isFinite(pitcherH9VsBatterSide) ? Number(pitcherH9VsBatterSide) : null,
          hand: pitcherHand || null
        },
        projectedBattingOrder: proj.projectedOrder,        // 1..9 (mode; tie → latest)
        projected_pa: projPA,
        ops_vs_pitcher: { pa: (Number.isFinite(r.pa_vs_pitcher) ? r.pa_vs_pitcher : null), ab: r.ab_vs_pitcher, ops: r.ops_vs_pitcher },
        wtb_percent: wtb !== null ? Number(wtb.toFixed(3)) : null,
        season_pa: Number.isFinite(season_pa) ? Number(season_pa) : null,
        ops_site: { pa: paHomeAwayForGame ?? null, ops: opsHomeAwayForGame },
        ops_vs_pitcher_hand: { pa: paVsPitcherHand ?? null, ops: opsVsPitcherHand },
        ops_last_7_days: { pa: paLast7 ?? null, ops: opsLast7 },
        site: opponentIsHome ? 'Home' : 'Away',
        score,
        h2h_share: w.h2h,
        score_breakdown
      };
    })
    .filter(r => ((r.ops_vs_pitcher?.ab ?? 0) >= 1) && (r.projectedBattingOrder != null && r.projectedBattingOrder <= 5))       // filter to projected slots 1–5
    .sort((a, b) => ((b.score ?? -1) - (a.score ?? -1)));

  // Log all hitters considered for this game and their scores
  try {
    const pitcherName = pitcher.name || 'Unknown Pitcher';
    const oppName = opponentTeamName || 'Opponent';
    console.log(`[Game ${game.gamePk}] ${oppName} hitters vs ${pitcherName} — ${hitters.length} hitters`);
    hitters.forEach(h => {
      const s = Number.isFinite(h.score) ? h.score.toFixed(3) : 'n/a';
      console.log(`  - ${h.name} (slot ${h.projectedBattingOrder ?? '?'}) score=${s}`);
    });
  } catch {}



  return {
    gamePk: game.gamePk,
    gameDate: game.officialDate,
    venue: game.venue?.name ?? null,
    homeTeam: { id: game.teams.home.team.id, name: game.teams.home.team.name },
    awayTeam: { id: game.teams.away.team.id, name: game.teams.away.team.name },
    probablePitcher: pitcher,
    opponentTeam: { id: opponentTeamId, name: opponentTeamName },
    window: { startDate: start7, endDate },
    qualifiedBattersCount: batterIds.length,
    hitters
  };
}

// ---------- main ----------
async function main() {
  // Determine target date based on Pacific Time
  // - Before 7:00 PM PT → use today's games
  // - At/after 7:00 PM PT → use tomorrow's games
  const argIdx = process.argv.indexOf("--date");
  const custom = argIdx > -1 ? process.argv[argIdx + 1] : null;

  const pad = (n) => String(n).padStart(2, "0");
  const fmtYMD = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const addDaysUTC = (y, m, d, delta) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  };

  let dateStr;
  let start7;
  let season;

  if (custom) {
    const c = new Date(custom);
    dateStr = fmtDate(c);
    const s = new Date(c);
    s.setDate(c.getDate() - 7);
    start7 = fmtDate(s);
    season = c.getFullYear();
  } else {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
    }).formatToParts(now);
    const get = (t) => Number(parts.find(p => p.type === t)?.value);
    const y = get('year');
    const m = get('month');
    const d = get('day');
    const h = get('hour');

    const target = h < 19 ? { y, m, d } : addDaysUTC(y, m, d, 1);
    const winStart = addDaysUTC(target.y, target.m, target.d, -7);
    dateStr = fmtYMD(target.y, target.m, target.d);
    start7 = fmtYMD(winStart.y, winStart.m, winStart.d);
    season = target.y;
  }

  const sched = await getScheduleByDate(dateStr);
  const games = (sched?.dates ?? []).flatMap(d => d.games ?? []);
  const perProbable = [];

  for (const game of games) {
    if (game?.teams?.home?.probablePitcher?.id) {
      const res = await analyzeProbable({ game, probableSide: "home", season, start7, endDate: dateStr });
      if (res) perProbable.push(res);
    }
    if (game?.teams?.away?.probablePitcher?.id) {
      const res = await analyzeProbable({ game, probableSide: "away", season, start7, endDate: dateStr });
      if (res) perProbable.push(res);
    }
  }

  // Combine hitters across all games, filter by season PA, and sort by highest wTB%
  const allHitters = perProbable.flatMap(entry => (entry.hitters ?? []).map(h => ({
    ...h,
    gamePk: entry.gamePk,
    gameDate: entry.gameDate,
    opponentTeamName: entry.opponentTeam?.name ?? null,
    probablePitcherName: entry.probablePitcher?.name ?? null
  })));
  const sortedHitters = allHitters
    .filter(h => (h.season_pa ?? 0) >= 85)
    .sort((a, b) => {
      const av = Number.isFinite(a.wtb_percent) ? a.wtb_percent : -1;
      const bv = Number.isFinite(b.wtb_percent) ? b.wtb_percent : -1;
      return bv - av;
    });

  fs.mkdirSync("api", { recursive: true });
  const out = { date: dateStr, gamesAnalyzed: games.length, hitterCount: sortedHitters.length, hitters: sortedHitters };
  fs.writeFileSync(path.join("api", "today.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join("api", `${dateStr}.json`), JSON.stringify(out, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
