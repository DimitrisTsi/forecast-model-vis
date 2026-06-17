/* ══════════════════════════════════════════════════════════════════
   EUROPEAN FORECAST MODEL VISUALIZER
   – Auto-loads Europe-wide grid, date-based, transparent wind particles
   ══════════════════════════════════════════════════════════════════ */

// ── CONFIGURATION ──────────────────────────────────────────────────
const CFG = {
  // Europe grid
  LAT_MIN: 35, LAT_MAX: 71, LON_MIN: -12, LON_MAX: 42, STEP: 4,
  // Particles (subtle, transparent trails)
  PARTICLES:   1200,
  TRAIL_LEN:   14,
  MAX_AGE:     70,
  SPEED_SCALE: 0.0005,
  PARTICLE_ALPHA: 0.18,
  // Field rendering
  FIELD_RES:   256,
  FIELD_OPACITY: 0.72,
  // Wind barbs
  BARB_STEP:   2,
  // Animation
  PLAY_SPEED:  400,
};

// ── COLOR SCALES (meteorological) ─────────────────────────────────
const SCALES = {
  temperature_2m: {
    label: 'Temperature (°C)', min: -30, max: 45,
    stops: [
      [-30,'#2166AC'],[-20,'#4393C3'],[-10,'#92C5DE'],
      [0,'#D1E5F0'],[5,'#F7F7F7'],[10,'#FDDBC7'],
      [20,'#EF8A62'],[30,'#D6604D'],[40,'#B2182B'],[45,'#67001F'],
    ],
  },
  precipitation: {
    label: 'Precipitation (mm)', min: 0, max: 40,
    stops: [
      [0,'rgba(0,0,0,0)'],[0.5,'#C6ECFF'],[2,'#6BAED6'],
      [5,'#3182BD'],[10,'#006DAA'],[20,'#3F007D'],[40,'#49006A'],
    ],
  },
  wind_speed_10m: {
    label: 'Wind Speed (km/h)', min: 0, max: 100,
    stops: [
      [0,'#F7FCF5'],[5,'#C7E9C0'],[15,'#74C476'],
      [30,'#238B45'],[50,'#FE9929'],[70,'#EC7014'],
      [85,'#CC4C02'],[100,'#7F2704'],
    ],
  },
  relative_humidity_2m: {
    label: 'Relative Humidity (%)', min: 0, max: 100,
    stops: [
      [0,'#FFF7BC'],[20,'#FEE391'],[40,'#FEC44F'],
      [60,'#FB9A29'],[80,'#D95F0E'],[100,'#993404'],
    ],
  },
  surface_pressure: {
    label: 'Surface Pressure (hPa)', min: 960, max: 1050,
    stops: [
      [960,'#2B83BA'],[980,'#ABDDA4'],[1000,'#FFFFBF'],
      [1015,'#FDAE61'],[1030,'#D7191C'],[1050,'#7B0027'],
    ],
  },
  cloud_cover: {
    label: 'Cloud Cover (%)', min: 0, max: 100,
    stops: [
      [0,'rgba(0,0,0,0)'],[20,'rgba(180,180,200,.15)'],
      [40,'rgba(150,150,170,.3)'],[60,'rgba(120,120,140,.45)'],
      [80,'rgba(90,90,110,.6)'],[100,'rgba(60,60,80,.75)'],
    ],
  },
};

// ── STATE ──────────────────────────────────────────────────────────
const S = {
  hour: 0,
  playing: false,
  playTimer: null,
  gridCache: {},        // { gfs: { gridByHour, bounds, times }, ecmwf: {...} }
  windField: null,      // { speed[][], dir[][], bounds }
  fieldValues: null,    // { values[][], bounds, variable }
  pointData: {},        // for meteogram
  meteoLat: null, meteoLon: null,
  particles: [],
  animFrame: null,
  layers: { particles: true, field: true, barbs: true },
  loaded: false,
};

// ── DOM REFS ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fieldCanvas   = $('fieldCanvas');
const particleCanvas= $('particleCanvas');
const fCtx = fieldCanvas.getContext('2d');
const pCtx = particleCanvas.getContext('2d');
const meteoCanvas   = $('meteogram');
const mCtx = meteoCanvas.getContext('2d');
const legendBar     = $('legendBar');
const lCtx = legendBar.getContext('2d');

// ── MAP SETUP ──────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [12, 52],
  zoom: 3.5,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

let marker = null;

// ── CANVAS SIZING ──────────────────────────────────────────────────
function resizeCanvases() {
  const el = $('map');
  const w = el.clientWidth, h = el.clientHeight;
  fieldCanvas.width = particleCanvas.width = w;
  fieldCanvas.height = particleCanvas.height = h;
}
window.addEventListener('resize', () => { resizeCanvases(); renderField(); });
map.on('resize', () => { resizeCanvases(); renderField(); });
resizeCanvases();

// ── UTILITIES ──────────────────────────────────────────────────────
function parseColor(c) {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] * 255 : 255];
  return [0, 0, 0, 255];
}

function scaleColor(varName, value) {
  const sc = SCALES[varName];
  if (!sc) return [0, 0, 0, 0];
  const stops = sc.stops;
  if (value <= stops[0][0]) return parseColor(stops[0][1]);
  if (value >= stops[stops.length - 1][0]) return parseColor(stops[stops.length - 1][1]);
  for (let i = 0; i < stops.length - 1; i++) {
    if (value >= stops[i][0] && value <= stops[i + 1][0]) {
      const t = (value - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      const a = parseColor(stops[i][1]), b = parseColor(stops[i + 1][1]);
      return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ];
    }
  }
  return [0, 0, 0, 0];
}

function bilinear(grid, lat, lon, bounds, n) {
  const gx = (lon - bounds.west) / (bounds.east - bounds.west) * (n - 1);
  const gy = (bounds.north - lat) / (bounds.north - bounds.south) * (n - 1);
  const x0 = Math.max(0, Math.min(n - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(n - 2, Math.floor(gy)));
  const fx = gx - x0, fy = gy - y0;
  const v00 = grid[y0][x0], v10 = grid[y0][x0+1], v01 = grid[y0+1][x0], v11 = grid[y0+1][x0+1];
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return v00*(1-fx)*(1-fy) + v10*fx*(1-fy) + v01*(1-fx)*fy + v11*fx*fy;
}

// ── EUROPE GRID POINTS ─────────────────────────────────────────────
function buildGridPoints() {
  const pts = [];
  for (let lat = CFG.LAT_MIN; lat <= CFG.LAT_MAX; lat += CFG.STEP) {
    for (let lon = CFG.LON_MIN; lon <= CFG.LON_MAX; lon += CFG.STEP) {
      pts.push({ lat, lon });
    }
  }
  return pts;
}

function getGridDims() {
  const lats = [], lons = [];
  for (let lat = CFG.LAT_MIN; lat <= CFG.LAT_MAX; lat += CFG.STEP) lats.push(lat);
  for (let lon = CFG.LON_MIN; lon <= CFG.LON_MAX; lon += CFG.STEP) lons.push(lon);
  return { rows: lats.length, cols: lons.length };
}

// ── FETCH EUROPE GRID ──────────────────────────────────────────────
const ALL_HOURLY = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,surface_pressure';

async function fetchEuropeGrid(model, onProgress) {
  const pts = buildGridPoints();
  const total = pts.length;
  const { rows, cols } = getGridDims();
  const bounds = {
    north: CFG.LAT_MAX, south: CFG.LAT_MIN,
    east: CFG.LON_MAX, west: CFG.LON_MIN,
  };

  // Concurrent fetch with semaphore
  const CONCURRENCY = 15;
  const results = new Array(total).fill(null);
  let done = 0, idx = 0;

  async function worker() {
    while (idx < total) {
      const i = idx++;
      const pt = pts[i];
      const url = model === 'ecmwf'
        ? `https://api.open-meteo.com/v1/ecmwf?latitude=${pt.lat}&longitude=${pt.lon}&hourly=${ALL_HOURLY}&timezone=UTC`
        : `https://api.open-meteo.com/v1/forecast?latitude=${pt.lat}&longitude=${pt.lon}&hourly=${ALL_HOURLY}&model=gfs&timezone=UTC`;
      try {
        const r = await fetch(url);
        if (r.ok) results[i] = { pt, data: await r.json() };
      } catch (e) { /* skip */ }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }

  const workers = Array(Math.min(CONCURRENCY, total)).fill(0).map(() => worker());
  await Promise.all(workers);

  // Organize into gridByHour
  const validResults = results.filter(r => r !== null);
  if (validResults.length === 0) return null;

  const times = validResults[0].data.hourly.time;
  const nHours = times.length;

  const gridByHour = {};
  for (let h = 0; h < nHours; h++) {
    const grid = {};
    for (const key of Object.keys(SCALES)) {
      grid[key] = Array.from({ length: rows }, () => Array(cols).fill(null));
    }
    grid._wind_speed = Array.from({ length: rows }, () => Array(cols).fill(null));
    grid._wind_dir   = Array.from({ length: rows }, () => Array(cols).fill(null));

    for (const r of validResults) {
      const { pt, data } = r;
      // Find grid position
      const ri = Math.round((pt.lat - CFG.LAT_MIN) / CFG.STEP);
      const ci = Math.round((pt.lon - CFG.LON_MIN) / CFG.STEP);
      if (ri >= rows || ci >= cols) continue;
      const d = data.hourly;
      for (const key of Object.keys(SCALES)) {
        if (d[key]) grid[key][ri][ci] = d[key][h];
      }
      if (d.wind_speed_10m) grid._wind_speed[ri][ci] = d.wind_speed_10m[h];
      if (d.wind_direction_10m) grid._wind_dir[ri][ci] = d.wind_direction_10m[h];
    }
    gridByHour[h] = grid;
  }

  return { gridByHour, bounds, times, rows, cols };
}

// ── APPLY FIELD TO STATE ───────────────────────────────────────────
function applyField(hour) {
  const model = $('mapModelSelect').value;
  const variable = $('variableSelect').value;
  const cached = S.gridCache[model];
  if (!cached) return;

  const grid = cached.gridByHour[hour];
  if (!grid) return;

  S.fieldValues = { values: grid[variable], bounds: cached.bounds, variable, n: cached.rows };
  S.windField  = { speed: grid._wind_speed, dir: grid._wind_dir, bounds: cached.bounds, n: cached.rows };

  renderField();
  updateLegend(variable);
  updateDateBadge(cached.times, hour);
}

// ── SPATIAL FIELD RENDERING ────────────────────────────────────────
function renderField() {
  fCtx.clearRect(0, 0, fieldCanvas.width, fieldCanvas.height);

  if (!S.fieldValues || !S.layers.field) {
    // Still draw barbs if field is off but barbs are on
    if (S.windField && S.layers.barbs) drawWindBarbs(fCtx, S.windField);
    return;
  }

  const { values, bounds, variable, n } = S.fieldValues;
  const sc = SCALES[variable];
  if (!sc) return;

  // Render at reduced resolution, then scale
  const res = CFG.FIELD_RES;
  const offscreen = document.createElement('canvas');
  offscreen.width = res; offscreen.height = res;
  const oCtx = offscreen.getContext('2d');
  const imgData = oCtx.createImageData(res, res);
  const d = imgData.data;

  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const lon = bounds.west + (px / (res - 1)) * (bounds.east - bounds.west);
      const lat = bounds.north - (py / (res - 1)) * (bounds.north - bounds.south);
      const val = bilinear(values, lat, lon, bounds, n);
      const idx = (py * res + px) * 4;
      if (val == null) { d[idx + 3] = 0; continue; }
      const c = scaleColor(variable, val);
      d[idx] = c[0]; d[idx + 1] = c[1]; d[idx + 2] = c[2];
      d[idx + 3] = Math.round(c[3] * CFG.FIELD_OPACITY);
    }
  }
  oCtx.putImageData(imgData, 0, 0);

  // Project bounds to screen
  const tl = map.project({ lng: bounds.west, lat: bounds.north });
  const br = map.project({ lng: bounds.east, lat: bounds.south });
  fCtx.drawImage(offscreen, tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Wind barbs on top
  if (S.layers.barbs && S.windField) drawWindBarbs(fCtx, S.windField);
}

// ── WIND BARBS ─────────────────────────────────────────────────────
function drawWindBarbs(ctx, wf) {
  const n = wf.n || wf.speed.length;
  const bounds = wf.bounds;
  const step = CFG.BARB_STEP;
  for (let ri = 0; ri < n; ri += step) {
    for (let ci = 0; ci < n; ci += step) {
      const lat = bounds.north - ri * ((bounds.north - bounds.south) / (n - 1));
      const lon = bounds.west + ci * ((bounds.east - bounds.west) / (n - 1));
      const spd = wf.speed[ri][ci];
      const dir = wf.dir[ri][ci];
      if (spd == null || dir == null || spd < 3) continue;
      const pt = map.project({ lng: lon, lat });
      drawSingleBarb(ctx, pt.x, pt.y, spd, dir);
    }
  }
}

function drawSingleBarb(ctx, x, y, speed, direction) {
  const rad = (direction + 180) * Math.PI / 180;
  const len = 16;
  const sx = x - Math.sin(rad) * len / 2;
  const sy = y + Math.cos(rad) * len / 2;
  const tx = x + Math.sin(rad) * len / 2;
  const ty = y - Math.cos(rad) * len / 2;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.fillStyle   = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';

  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();

  const knots = speed / 1.852;
  let remaining = Math.round(knots / 5) * 5;
  const barbLen = 6;
  let pos = 0.35;
  const perpRad = rad - Math.PI / 2;

  while (remaining >= 50) {
    const px = sx + (tx - sx) * pos;
    const py = sy + (ty - sy) * pos;
    const ex = px + Math.cos(perpRad) * barbLen;
    const ey = py + Math.sin(perpRad) * barbLen;
    const px2 = sx + (tx - sx) * (pos + 0.12);
    const py2 = sy + (ty - sy) * (pos + 0.12);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.lineTo(px2 + (ex-px)*.1, ey + (py2-py)*.1); ctx.closePath(); ctx.fill();
    remaining -= 50; pos += 0.18;
  }
  while (remaining >= 10) {
    const px = sx + (tx - sx) * pos;
    const py = sy + (ty - sy) * pos;
    const ex = px + Math.cos(perpRad) * barbLen;
    const ey = py + Math.sin(perpRad) * barbLen;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    remaining -= 10; pos += 0.14;
  }
  while (remaining >= 5) {
    const px = sx + (tx - sx) * pos;
    const py = sy + (ty - sy) * pos;
    const ex = px + Math.cos(perpRad) * barbLen * 0.5;
    const ey = py + Math.sin(perpRad) * barbLen * 0.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    remaining -= 5; pos += 0.12;
  }
  ctx.restore();
}

// ── WIND PARTICLE SYSTEM (transparent trails) ─────────────────────
function initParticles() {
  S.particles = [];
  const w = particleCanvas.width, h = particleCanvas.height;
  for (let i = 0; i < CFG.PARTICLES; i++) {
    S.particles.push({
      trail: [{ x: Math.random() * w, y: Math.random() * h }],
      age: Math.floor(Math.random() * CFG.MAX_AGE),
    });
  }
}

function animateParticles() {
  S.animFrame = requestAnimationFrame(animateParticles);

  if (!S.windField || !S.layers.particles) return;

  const ctx = pCtx;
  const w = particleCanvas.width, h = particleCanvas.height;

  // Clear completely each frame — canvas stays transparent
  ctx.clearRect(0, 0, w, h);

  const wf = S.windField;
  const bounds = wf.bounds;
  const n = wf.n || wf.speed.length;

  for (const p of S.particles) {
    const head = p.trail[p.trail.length - 1];

    // Screen → geo
    const ll = map.unproject({ x: head.x, y: head.y });

    // Look up wind
    const spd = bilinear(wf.speed, ll.lat, ll.lng, bounds, n);
    const dir = bilinear(wf.dir, ll.lat, ll.lng, bounds, n);
    if (spd == null || dir == null) { resetParticle(p, w, h); continue; }

    // Move in geo space
    const dirRad = dir * Math.PI / 180;
    const dLng = -spd * Math.sin(dirRad) * CFG.SPEED_SCALE / Math.cos(ll.lat * Math.PI / 180);
    const dLat = -spd * Math.cos(dirRad) * CFG.SPEED_SCALE;
    const newScreen = map.project({ lng: ll.lng + dLng, lat: ll.lat + dLat });

    p.trail.push({ x: newScreen.x, y: newScreen.y });
    if (p.trail.length > CFG.TRAIL_LEN) p.trail.shift();
    p.age++;

    // Reset if out of bounds or too old
    if (p.age > CFG.MAX_AGE || newScreen.x < -20 || newScreen.x > w + 20 || newScreen.y < -20 || newScreen.y > h + 20) {
      resetParticle(p, w, h);
      continue;
    }
  }

  // Batch draw by trail position for performance
  for (let t = 1; t < CFG.TRAIL_LEN; t++) {
    const frac = t / CFG.TRAIL_LEN;
    const alpha = frac * CFG.PARTICLE_ALPHA;
    ctx.strokeStyle = `rgba(170,215,255,${alpha})`;
    ctx.lineWidth = 0.6 + frac * 0.5;
    ctx.beginPath();
    for (const p of S.particles) {
      if (p.trail.length > t) {
        ctx.moveTo(p.trail[t - 1].x, p.trail[t - 1].y);
        ctx.lineTo(p.trail[t].x, p.trail[t].y);
      }
    }
    ctx.stroke();
  }
}

function resetParticle(p, w, h) {
  p.trail = [{ x: Math.random() * w, y: Math.random() * h }];
  p.age = 0;
}

// ── DATE BADGE ─────────────────────────────────────────────────────
function updateDateBadge(times, hour) {
  if (!times || !times[hour]) return;
  const d = new Date(times[hour]);
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false };
  $('dateText').textContent = d.toLocaleString('en-GB', opts) + ' UTC';
  $('dateBadge').classList.remove('hidden');
}

// ── LEGEND ─────────────────────────────────────────────────────────
function updateLegend(varName) {
  const sc = SCALES[varName];
  if (!sc) return;
  $('legendTitle').textContent = sc.label;
  $('legend').classList.remove('hidden');

  const w = legendBar.width, h = legendBar.height;
  const imgData = lCtx.createImageData(w, h);
  const d = imgData.data;
  for (let x = 0; x < w; x++) {
    const val = sc.min + (x / (w - 1)) * (sc.max - sc.min);
    const c = scaleColor(varName, val);
    for (let y = 0; y < h; y++) {
      const idx = (y * w + x) * 4;
      d[idx] = c[0]; d[idx+1] = c[1]; d[idx+2] = c[2]; d[idx+3] = c[3];
    }
  }
  lCtx.putImageData(imgData, 0, 0);

  const labelsEl = $('legendLabels');
  labelsEl.innerHTML = '';
  for (let i = 0; i <= 5; i++) {
    const val = sc.min + (i / 5) * (sc.max - sc.min);
    const span = document.createElement('span');
    span.textContent = Math.round(val);
    labelsEl.appendChild(span);
  }
}

// ── METEOGRAM ──────────────────────────────────────────────────────
async function showMeteogram(lat, lon) {
  S.meteoLat = lat; S.meteoLon = lon;
  $('meteogramSection').classList.remove('hidden');
  $('meteogramLoc').textContent = `(${lat.toFixed(1)}°N, ${lon.toFixed(1)}°E)`;

  // Fetch point data for both models
  const models = ['gfs', 'ecmwf'];
  const pd = {};
  await Promise.all(models.map(async m => {
    try {
      const url = m === 'ecmwf'
        ? `https://api.open-meteo.com/v1/ecmwf?latitude=${lat}&longitude=${lon}&hourly=${ALL_HOURLY}&timezone=UTC`
        : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${ALL_HOURLY}&model=gfs&timezone=UTC`;
      const r = await fetch(url);
      if (r.ok) pd[m] = await r.json();
    } catch (e) {}
  }));
  S.pointData = pd;
  renderMeteogram();
}

function renderMeteogram() {
  const canvas = meteoCanvas;
  const ctx = mCtx;
  const dpr = window.devicePixelRatio || 1;
  const logW = 460, logH = 260;
  canvas.width = logW * dpr; canvas.height = logH * dpr;
  canvas.style.width = logW + 'px'; canvas.style.height = logH + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, logW, logH);

  const ml = 44, mr = 10, mt = 10, mb = 36;
  const pw = logW - ml - mr, ph = logH - mt - mb;

  const model = $('mapModelSelect').value;
  const pd = S.pointData[model];
  if (!pd || !pd.hourly) {
    ctx.fillStyle = '#556'; ctx.font = '13px DM Sans'; ctx.textAlign = 'center';
    ctx.fillText('Loading…', logW / 2, logH / 2);
    return;
  }

  const h = pd.hourly;
  const times = h.time || [];
  const temps = h.temperature_2m || [];
  const precip = h.precipitation || [];
  const windSpd = h.wind_speed_10m || [];
  const windDir = h.wind_direction_10m || [];
  const cloud = h.cloud_cover || [];
  const n = Math.min(times.length, 96);
  if (n === 0) return;

  const tempTop = mt, tempBot = mt + ph * 0.55;
  const precipTop = tempBot + 1, precipBot = tempBot + ph * 0.22;
  const windTop = precipBot + 1, windBot = mt + ph;

  function xPos(i) { return ml + (i / (n - 1)) * pw; }

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = ml + (i / 4) * pw;
    ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, windBot); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(ml, tempBot); ctx.lineTo(ml + pw, tempBot); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, precipBot); ctx.lineTo(ml + pw, precipBot); ctx.stroke();

  // Cloud cover
  if (cloud.length) {
    for (let i = 0; i < n; i++) {
      const x1 = xPos(i), x2 = i < n - 1 ? xPos(i + 1) : x1 + pw / n;
      ctx.fillStyle = `rgba(180,180,200,${(cloud[i] || 0) / 100 * 0.15})`;
      ctx.fillRect(x1, tempTop, x2 - x1, tempBot - tempTop);
    }
  }

  // Temperature
  if (temps.length) {
    const valid = temps.slice(0, n).filter(v => v != null);
    const tMin = Math.floor(Math.min(...valid) - 2);
    const tMax = Math.ceil(Math.max(...valid) + 2);
    const tRange = Math.max(tMax - tMin, 1);

    ctx.fillStyle = '#667'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = tMin + (i / 4) * tRange;
      const y = tempBot - (i / 4) * (tempBot - tempTop);
      ctx.fillText(val.toFixed(0) + '°', ml - 4, y + 3);
    }

    // Gradient fill
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (temps[i] == null) continue;
      const x = xPos(i), y = tempBot - ((temps[i] - tMin) / tRange) * (tempBot - tempTop);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(xPos(n - 1), tempBot); ctx.lineTo(ml, tempBot); ctx.closePath();
    const grad = ctx.createLinearGradient(0, tempTop, 0, tempBot);
    grad.addColorStop(0, 'rgba(255,107,107,.2)'); grad.addColorStop(1, 'rgba(255,107,107,0)');
    ctx.fillStyle = grad; ctx.fill();

    // Main line
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (temps[i] == null) continue;
      const x = xPos(i), y = tempBot - ((temps[i] - tMin) / tRange) * (tempBot - tempTop);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 1.8; ctx.stroke();

    // Other model dashed
    const other = model === 'gfs' ? 'ecmwf' : 'gfs';
    const pd2 = S.pointData[other];
    if (pd2 && pd2.hourly && pd2.hourly.temperature_2m) {
      const t2 = pd2.hourly.temperature_2m;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (t2[i] == null) continue;
        const x = xPos(i), y = tempBot - ((t2[i] - tMin) / tRange) * (tempBot - tempTop);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = other === 'ecmwf' ? 'rgba(77,171,247,.5)' : 'rgba(255,107,107,.4)';
      ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Current hour dot
    if (S.hour < n && temps[S.hour] != null) {
      const cx = xPos(S.hour);
      const cy = tempBot - ((temps[S.hour] - tMin) / tRange) * (tempBot - tempTop);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Precipitation
  if (precip.length) {
    const pMax = Math.max(1, ...precip.slice(0, n).filter(v => v != null));
    ctx.fillStyle = '#4dabf7';
    for (let i = 0; i < n; i++) {
      if (precip[i] == null || precip[i] <= 0) continue;
      const x1 = xPos(i), barW = Math.max(2, pw / n - 1);
      const barH = (precip[i] / pMax) * (precipBot - precipTop - 2);
      ctx.fillRect(x1 - barW / 2, precipBot - barH, barW, barH);
    }
    ctx.fillStyle = '#667'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'right';
    ctx.fillText(pMax.toFixed(0) + 'mm', ml - 4, precipTop + 10);
  }

  // Wind arrows
  if (windSpd.length && windDir.length) {
    const wMid = (windTop + windBot) / 2;
    const step = Math.max(1, Math.floor(n / 24));
    for (let i = 0; i < n; i += step) {
      if (windSpd[i] == null || windDir[i] == null) continue;
      const x = xPos(i);
      const dirRad = (windDir[i] + 180) * Math.PI / 180;
      const len = 9;
      const tx = x + Math.sin(dirRad) * len;
      const ty = wMid - Math.cos(dirRad) * len;
      const sx = x - Math.sin(dirRad) * len;
      const sy = wMid + Math.cos(dirRad) * len;
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      // Arrow head
      const hl = 3;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.sin(dirRad + Math.PI + .5) * hl, ty - Math.cos(dirRad + Math.PI + .5) * hl);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.sin(dirRad + Math.PI - .5) * hl, ty - Math.cos(dirRad + Math.PI - .5) * hl);
      ctx.stroke();
      // Speed label
      ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.font = '8px JetBrains Mono'; ctx.textAlign = 'center';
      ctx.fillText(Math.round(windSpd[i]), x, windBot - 2);
    }
  }

  // Time axis
  ctx.fillStyle = '#556'; ctx.font = '9px JetBrains Mono'; ctx.textAlign = 'center';
  for (let i = 0; i < n; i += 24) {
    const x = xPos(i);
    const d = new Date(times[i]);
    ctx.fillText(d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' }), x, windBot + 14);
    ctx.fillText(d.getHours() + ':00', x, windBot + 24);
  }
}

// ── EVENT LISTENERS ────────────────────────────────────────────────

// Welcome / Load
$('startBtn').addEventListener('click', async () => {
  $('welcomeContent').classList.add('hidden');
  $('loadingContent').classList.remove('hidden');

  const model = $('mapModelSelect').value;

  const result = await fetchEuropeGrid(model, (done, total) => {
    $('loadingProgress').textContent = `Fetching ${model.toUpperCase()} grid… ${done}/${total}`;
    $('progressFill').style.width = (done / total * 100) + '%';
  });

  if (result) {
    S.gridCache[model] = result;
    S.loaded = true;
    applyField(S.hour);
    initParticles();
    animateParticles();
  }

  $('welcomeOverlay').classList.add('hidden');
});

// About
$('aboutBtn').addEventListener('click', () => $('aboutOverlay').classList.remove('hidden'));
$('closeAboutBtn').addEventListener('click', () => $('aboutOverlay').classList.add('hidden'));

// Panel toggle
$('togglePanel').addEventListener('click', () => {
  const panel = $('panel');
  panel.classList.toggle('collapsed');
  $('togglePanel').textContent = panel.classList.contains('collapsed') ? '◀' : '▶';
});

// Variable change
$('variableSelect').addEventListener('change', () => {
  if (S.loaded) applyField(S.hour);
});

// Model change
$('mapModelSelect').addEventListener('change', async () => {
  if (!S.loaded) return;
  const model = $('mapModelSelect').value;
  if (!S.gridCache[model]) {
    $('loadingInline').classList.remove('hidden');
    $('loadingInlineText').textContent = `Loading ${model.toUpperCase()}…`;
    const result = await fetchEuropeGrid(model, (done, total) => {
      $('loadingInlineText').textContent = `Loading ${model.toUpperCase()}… ${done}/${total}`;
    });
    if (result) S.gridCache[model] = result;
    $('loadingInline').classList.add('hidden');
  }
  applyField(S.hour);
  if (S.meteoLat != null) showMeteogram(S.meteoLat, S.meteoLon);
});

// Hour slider
$('hourSlider').addEventListener('input', () => {
  S.hour = parseInt($('hourSlider').value);
  $('hourValue').textContent = `+${S.hour} h`;
  if (S.loaded) applyField(S.hour);
  if (S.meteoLat != null) renderMeteogram();
});

// Play / Stop
$('playBtn').addEventListener('click', () => {
  S.playing = true;
  $('playBtn').disabled = true;
  $('stopBtn').disabled = false;
  const tick = () => {
    S.hour = (S.hour + 1) % 91;
    $('hourSlider').value = S.hour;
    $('hourValue').textContent = `+${S.hour} h`;
    if (S.loaded) applyField(S.hour);
    if (S.meteoLat != null) renderMeteogram();
  };
  tick();
  S.playTimer = setInterval(tick, parseInt($('speedSelect').value));
});

$('stopBtn').addEventListener('click', () => {
  S.playing = false;
  $('playBtn').disabled = false;
  $('stopBtn').disabled = true;
  clearInterval(S.playTimer);
});

$('speedSelect').addEventListener('change', () => {
  if (!S.playing) return;
  clearInterval(S.playTimer);
  S.playTimer = setInterval(() => {
    S.hour = (S.hour + 1) % 91;
    $('hourSlider').value = S.hour;
    $('hourValue').textContent = `+${S.hour} h`;
    if (S.loaded) applyField(S.hour);
    if (S.meteoLat != null) renderMeteogram();
  }, parseInt($('speedSelect').value));
});

// Layer toggles
$('showParticles').addEventListener('change', e => {
  S.layers.particles = e.target.checked;
  if (!e.target.checked) pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
});
$('showField').addEventListener('change', e => {
  S.layers.field = e.target.checked;
  if (S.loaded) renderField();
});
$('showBarbs').addEventListener('change', e => {
  S.layers.barbs = e.target.checked;
  if (S.loaded) renderField();
});

// Click for meteogram
map.on('click', async (e) => {
  if (!S.loaded) return;
  const lat = e.lngLat.lat, lon = e.lngLat.lng;
  if (marker) marker.remove();
  marker = new maplibregl.Marker({ color: '#5BA3E0' }).setLngLat([lon, lat]).addTo(map);
  await showMeteogram(lat, lon);
});

// Redraw on map move/zoom
let moveTimer;
function onMapMove() {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (S.loaded) renderField();
  }, 100);
}
map.on('move', onMapMove);
map.on('zoom', onMapMove);
