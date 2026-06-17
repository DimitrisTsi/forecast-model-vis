/* ══════════════════════════════════════════════════════════════════
   FORECAST MODEL VISUALIZER — Enhanced Meteorological Visualization
   ══════════════════════════════════════════════════════════════════ */

// ── CONFIGURATION ──────────────────────────────────────────────────
const CFG = {
  GRID_SIZE:     5,       // 5×5 grid for spatial field
  GRID_SPACING:  1.2,     // degrees between grid points
  PARTICLES:     2500,
  MAX_AGE:       85,
  SPEED_SCALE:   0.00065,
  FADE:          0.93,
  FIELD_RES:     180,     // px resolution for field image
  PLAY_SPEED:    400,     // ms per hour step
  FIELD_OPACITY: 0.72,
  BARB_SPACING:  2,       // draw wind barb every N grid steps
};

// ── COLOR SCALES (meteorological) ─────────────────────────────────
const SCALES = {
  temperature_2m: {
    label: 'Temperature (°C)',
    min: -30, max: 45,
    stops: [
      [-30, '#2166AC'], [-20, '#4393C3'], [-10, '#92C5DE'],
      [0,   '#D1E5F0'], [5,   '#F7F7F7'], [10,  '#FDDBC7'],
      [20,  '#EF8A62'], [30,  '#D6604D'], [40,  '#B2182B'], [45, '#67001F'],
    ],
  },
  precipitation: {
    label: 'Precipitation (mm)',
    min: 0, max: 40,
    stops: [
      [0, 'rgba(0,0,0,0)'], [0.5, '#C6ECFF'], [2, '#6BAED6'],
      [5, '#3182BD'], [10, '#006DAA'], [20, '#3F007D'], [40, '#49006A'],
    ],
  },
  wind_speed_10m: {
    label: 'Wind Speed (km/h)',
    min: 0, max: 100,
    stops: [
      [0, '#F7FCF5'], [5, '#C7E9C0'], [15, '#74C476'],
      [30, '#238B45'], [50, '#FE9929'], [70, '#EC7014'],
      [85, '#CC4C02'], [100, '#7F2704'],
    ],
  },
  relative_humidity_2m: {
    label: 'Relative Humidity (%)',
    min: 0, max: 100,
    stops: [
      [0, '#FFF7BC'], [20, '#FEE391'], [40, '#FEC44F'],
      [60, '#FB9A29'], [80, '#D95F0E'], [100, '#993404'],
    ],
  },
  surface_pressure: {
    label: 'Surface Pressure (hPa)',
    min: 960, max: 1050,
    stops: [
      [960, '#2B83BA'], [980, '#ABDDA4'], [1000, '#FFFFBF'],
      [1015, '#FDAE61'], [1030, '#D7191C'], [1050, '#7B0027'],
    ],
  },
  cloud_cover: {
    label: 'Cloud Cover (%)',
    min: 0, max: 100,
    stops: [
      [0, 'rgba(0,0,0,0)'], [20, 'rgba(180,180,200,.15)'],
      [40, 'rgba(150,150,170,.3)'], [60, 'rgba(120,120,140,.45)'],
      [80, 'rgba(90,90,110,.6)'], [100, 'rgba(60,60,80,.75)'],
    ],
  },
};

// ── STATE ──────────────────────────────────────────────────────────
const S = {
  lat: null, lon: null,
  hour: 0,
  playing: false,
  playTimer: null,
  pointData: {},       // { gfs: {...}, ecmwf: {...} }
  gridCache: {},       // { gfs: { hour: gridData }, ecmwf: { hour: gridData } }
  windField: null,     // { u[][], v[][], bounds }
  fieldValues: null,   // { values[][], bounds, variable }
  particles: [],
  animFrame: null,
  layers: { particles: true, field: true, barbs: true },
};

// ── DOM REFS ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const mapEl         = $('map');
const fieldCanvas   = $('fieldCanvas');
const particleCanvas= $('particleCanvas');
const fCtx          = fieldCanvas.getContext('2d');
const pCtx          = particleCanvas.getContext('2d');
const meteoCanvas   = $('meteogram');
const mCtx          = meteoCanvas.getContext('2d');
const legendBar     = $('legendBar');
const lCtx          = legendBar.getContext('2d');

// ── MAP SETUP ──────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [10, 48],
  zoom: 4,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

let marker = null;

// ── CANVAS SIZING ──────────────────────────────────────────────────
function resizeCanvases() {
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  fieldCanvas.width = particleCanvas.width = w;
  fieldCanvas.height = particleCanvas.height = h;
}
window.addEventListener('resize', () => { resizeCanvases(); renderField(); });
map.on('resize', () => { resizeCanvases(); renderField(); });
resizeCanvases();

// ── COLOR INTERPOLATION ────────────────────────────────────────────
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
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return [0, 0, 0, 0];
}

function parseColor(c) {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] * 255 : 255];
  return [0, 0, 0, 255];
}

// ── BILINEAR INTERPOLATION ─────────────────────────────────────────
function bilinear(grid, lat, lon, bounds) {
  const n = grid.length; // grid is n×n
  const gx = (lon - bounds.west) / (bounds.east - bounds.west) * (n - 1);
  const gy = (bounds.north - lat) / (bounds.north - bounds.south) * (n - 1);
  const x0 = Math.max(0, Math.min(n - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(n - 2, Math.floor(gy)));
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = gx - x0, fy = gy - y0;
  const v00 = grid[y0][x0], v10 = grid[y0][x1], v01 = grid[y1][x0], v11 = grid[y1][x1];
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

// ── SPATIAL FIELD RENDERING ────────────────────────────────────────
function renderField() {
  fCtx.clearRect(0, 0, fieldCanvas.width, fieldCanvas.height);
  if (!S.fieldValues || !S.layers.field) return;

  const { values, bounds, variable } = S.fieldValues;
  const n = values.length;
  const sc = SCALES[variable];
  if (!sc) return;

  // Render at reduced resolution, then scale onto canvas
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
      const val = bilinear(values, lat, lon, bounds);
      const idx = (py * res + px) * 4;
      if (val == null) { d[idx + 3] = 0; continue; }
      const c = scaleColor(variable, val);
      d[idx] = c[0]; d[idx + 1] = c[1]; d[idx + 2] = c[2];
      d[idx + 3] = Math.round(c[3] * CFG.FIELD_OPACITY);
    }
  }
  oCtx.putImageData(imgData, 0, 0);

  // Project bounds corners to screen
  const tl = map.project({ lng: bounds.west, lat: bounds.north });
  const br = map.project({ lng: bounds.east, lat: bounds.south });
  const sw = map.project({ lng: bounds.west, lat: bounds.south });

  fCtx.drawImage(offscreen, tl.x, tl.y, br.x - tl.x, sw.y - tl.y);

  // Wind barbs
  if (S.layers.barbs && S.windField) {
    drawWindBarbs(fCtx, S.windField, bounds);
  }
}

// ── WIND BARBS ─────────────────────────────────────────────────────
function drawWindBarbs(ctx, wf, bounds) {
  const n = wf.u.length;
  const step = CFG.BARB_SPACING;
  for (let gy = 0; gy < n; gy += step) {
    for (let gx = 0; gx < n; gx += step) {
      const lat = bounds.north - gy * ((bounds.north - bounds.south) / (n - 1));
      const lon = bounds.west + gx * ((bounds.east - bounds.west) / (n - 1));
      const spd = wf.u[gy][gx];   // we'll repurpose: speed stored separately
      const dir = wf.v[gy][gx];   // direction stored separately
      if (spd == null || dir == null) continue;
      const pt = map.project({ lng: lon, lat: lat });
      drawBarb(ctx, pt.x, pt.y, spd, dir);
    }
  }
}

function drawBarb(ctx, x, y, speed, direction) {
  // direction: meteorological (from-degrees), speed in km/h
  // Convert to radians for the arrow direction (where wind GOES)
  const rad = (direction + 180) * Math.PI / 180;
  const len = 18;
  const shaftX = x - Math.sin(rad) * len / 2;
  const shaftY = y + Math.cos(rad) * len / 2;
  const tipX = x + Math.sin(rad) * len / 2;
  const tipY = y - Math.cos(rad) * len / 2;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.65)';
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';

  // Shaft
  ctx.beginPath();
  ctx.moveTo(shaftX, shaftY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Barbs (flags along the shaft)
  const knots = speed / 1.852; // km/h to knots
  let remaining = Math.round(knots / 5) * 5; // round to nearest 5 kt
  const barbLen = 7;
  let pos = 0.3; // start position along shaft (0=shaft, 1=tip)

  // Pennant (50 kt triangle)
  while (remaining >= 50) {
    drawBarbFlag(ctx, shaftX, shaftY, tipX, tipY, pos, barbLen, rad, true);
    remaining -= 50;
    pos += 0.18;
  }
  // Long barbs (10 kt)
  while (remaining >= 10) {
    drawBarbFlag(ctx, shaftX, shaftY, tipX, tipY, pos, barbLen, rad, false);
    remaining -= 10;
    pos += 0.14;
  }
  // Short barbs (5 kt)
  while (remaining >= 5) {
    drawBarbFlag(ctx, shaftX, shaftY, tipX, tipY, pos, barbLen * 0.55, rad, false);
    remaining -= 5;
    pos += 0.12;
  }

  ctx.restore();
}

function drawBarbFlag(ctx, sx, sy, tx, ty, t, len, rad, pennant) {
  const px = sx + (tx - sx) * t;
  const py = sy + (ty - sy) * t;
  // Perpendicular direction (to the left of shaft in meteorological convention)
  const perpRad = rad - Math.PI / 2;
  const ex = px + Math.cos(perpRad) * len;
  const ey = py + Math.sin(perpRad) * len;

  ctx.beginPath();
  if (pennant) {
    const t2 = t + 0.1;
    const px2 = sx + (tx - sx) * t2;
    const py2 = sy + (ty - sy) * t2;
    ctx.moveTo(px, py);
    ctx.lineTo(ex, ey);
    ctx.lineTo(px2 + (ex - px) * 0.1, ey + (py2 - py) * 0.1);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.moveTo(px, py);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

// ── WIND PARTICLE SYSTEM ──────────────────────────────────────────
function initParticles() {
  S.particles = [];
  const w = particleCanvas.width, h = particleCanvas.height;
  for (let i = 0; i < CFG.PARTICLES; i++) {
    S.particles.push({
      x: Math.random() * w, y: Math.random() * h,
      age: Math.floor(Math.random() * CFG.MAX_AGE),
    });
  }
}

function animateParticles() {
  if (!S.windField || !S.layers.particles) {
    S.animFrame = requestAnimationFrame(animateParticles);
    return;
  }

  const ctx = pCtx;
  const w = particleCanvas.width, h = particleCanvas.height;

  // Fade trail
  ctx.fillStyle = `rgba(13,13,18,${1 - CFG.FADE})`;
  ctx.fillRect(0, 0, w, h);

  const wf = S.windField;
  const bounds = wf.bounds;
  const speedScale = CFG.SPEED_SCALE;

  for (const p of S.particles) {
    const prevX = p.x, prevY = p.y;

    // Screen → geo
    const ll = map.unproject({ x: p.x, y: p.y });

    // Look up wind
    const uVal = bilinear(wf.u, ll.lat, ll.lng, bounds);
    const dVal = bilinear(wf.v, ll.lat, ll.lng, bounds);
    if (uVal == null || dVal == null) { resetParticle(p, w, h); continue; }

    // Wind components (uVal=speed, dVal=direction from)
    const dirRad = dVal * Math.PI / 180;
    const uWind = -uVal * Math.sin(dirRad);
    const vWind = -uVal * Math.cos(dirRad);

    // Move in geo space
    const dLng = uWind * speedScale / Math.cos(ll.lat * Math.PI / 180);
    const dLat = vWind * speedScale;
    const newLng = ll.lng + dLng;
    const newLat = ll.lat + dLat;

    // Geo → screen
    const newScreen = map.project({ lng: newLng, lat: newLat });
    p.x = newScreen.x;
    p.y = newScreen.y;
    p.age++;

    // Reset if out of bounds or too old
    if (p.age > CFG.MAX_AGE || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
      resetParticle(p, w, h);
      continue;
    }

    // Draw trail segment
    const alpha = Math.max(0, 1 - p.age / CFG.MAX_AGE);
    const speedAlpha = Math.min(1, uVal / 40);
    ctx.strokeStyle = `rgba(160,210,255,${alpha * speedAlpha * 0.6 + 0.08})`;
    ctx.lineWidth = 1 + speedAlpha * 0.5;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  S.animFrame = requestAnimationFrame(animateParticles);
}

function resetParticle(p, w, h) {
  p.x = Math.random() * w;
  p.y = Math.random() * h;
  p.age = 0;
}

// ── API: POINT DATA (for meteogram) ────────────────────────────────
const ALL_HOURLY = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,surface_pressure';

async function fetchPointData(lat, lon) {
  const models = ['gfs', 'ecmwf'];
  const results = {};
  await Promise.all(models.map(async m => {
    try {
      const url = m === 'ecmwf'
        ? `https://api.open-meteo.com/v1/ecmwf?latitude=${lat}&longitude=${lon}&hourly=${ALL_HOURLY}&timezone=UTC`
        : `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${ALL_HOURLY}&model=gfs&timezone=UTC`;
      const r = await fetch(url);
      if (!r.ok) return;
      results[m] = await r.json();
    } catch (e) { console.warn(`Failed to fetch ${m}`, e); }
  }));
  return results;
}

// ── API: GRID DATA (for spatial field + wind) ──────────────────────
async function fetchGridData(lat, lon, model) {
  const gs = CFG.GRID_SIZE;
  const sp = CFG.GRID_SPACING;
  const half = (gs - 1) / 2 * sp;
  const bounds = {
    north: lat + half, south: lat - half,
    east: lon + half, west: lon - half,
  };

  const variables = `${ALL_HOURLY}`;
  const points = [];
  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      points.push({
        lat: bounds.north - r * sp,
        lon: bounds.west + c * sp,
        r, c,
      });
    }
  }

  // Show loading
  $('loading').classList.remove('hidden');
  let loaded = 0;
  const total = points.length;

  const promises = points.map(async pt => {
    const url = model === 'ecmwf'
      ? `https://api.open-meteo.com/v1/ecmwf?latitude=${pt.lat}&longitude=${pt.lon}&hourly=${variables}&timezone=UTC`
      : `https://api.open-meteo.com/v1/forecast?latitude=${pt.lat}&longitude=${pt.lon}&hourly=${variables}&model=gfs&timezone=UTC`;
    try {
      const r = await fetch(url);
      loaded++;
      $('loadingText').textContent = `Loading field data… ${loaded}/${total}`;
      if (!r.ok) return null;
      return { ...pt, data: await r.json() };
    } catch (e) { loaded++; return null; }
  });

  const results = (await Promise.all(promises)).filter(Boolean);
  $('loading').classList.add('hidden');

  // Organize by hour → grid
  if (results.length === 0) return null;
  const times = results[0].data.hourly.time;
  const hours = times.map((_, i) => i);

  const gridByHour = {};
  for (const h of hours) {
    const grid = {};
    for (const key of Object.keys(SCALES)) {
      const values = Array.from({ length: gs }, () => Array(gs).fill(null));
      grid[key] = values;
    }
    grid._wind_speed = Array.from({ length: gs }, () => Array(gs).fill(null));
    grid._wind_dir = Array.from({ length: gs }, () => Array(gs).fill(null));

    for (const pt of results) {
      const d = pt.data.hourly;
      for (const key of Object.keys(SCALES)) {
        if (d[key]) grid[key][pt.r][pt.c] = d[key][h];
      }
      if (d.wind_speed_10m) grid._wind_speed[pt.r][pt.c] = d.wind_speed_10m[h];
      if (d.wind_direction_10m) grid._wind_dir[pt.r][pt.c] = d.wind_direction_10m[h];
    }
    gridByHour[h] = grid;
  }

  return { gridByHour, bounds, hours };
}

// ── APPLY FIELD TO STATE ───────────────────────────────────────────
function applyField(hour) {
  const model = $('mapModelSelect').value;
  const variable = $('variableSelect').value;
  const cached = S.gridCache[model];
  if (!cached) return;

  const grid = cached.gridByHour[hour];
  if (!grid) return;

  S.fieldValues = { values: grid[variable], bounds: cached.bounds, variable };
  S.windField = {
    u: grid._wind_speed,
    v: grid._wind_dir,
    bounds: cached.bounds,
  };

  renderField();
  updateLegend(variable);
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
      d[idx] = c[0]; d[idx + 1] = c[1]; d[idx + 2] = c[2]; d[idx + 3] = c[3];
    }
  }
  lCtx.putImageData(imgData, 0, 0);

  // Labels
  const labelsEl = $('legendLabels');
  labelsEl.innerHTML = '';
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = sc.min + (i / steps) * (sc.max - sc.min);
    const span = document.createElement('span');
    span.textContent = Math.round(val);
    labelsEl.appendChild(span);
  }
}

// ── METEOGRAM ──────────────────────────────────────────────────────
function renderMeteogram() {
  const canvas = meteoCanvas;
  const ctx = mCtx;
  const dpr = window.devicePixelRatio || 1;
  const logW = 460, logH = 260;
  canvas.width = logW * dpr;
  canvas.height = logH * dpr;
  canvas.style.width = logW + 'px';
  canvas.style.height = logH + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, logW, logH);

  // Margins
  const ml = 44, mr = 10, mt = 10, mb = 36;
  const pw = logW - ml - mr, ph = logH - mt - mb;

  // Get point data
  const model = $('mapModelSelect').value;
  const pd = S.pointData[model];
  if (!pd || !pd.hourly) {
    ctx.fillStyle = '#556';
    ctx.font = '13px DM Sans';
    ctx.textAlign = 'center';
    ctx.fillText('Click the map to load data', logW / 2, logH / 2);
    return;
  }

  const h = pd.hourly;
  const times = h.time || [];
  const temps = h.temperature_2m || [];
  const precip = h.precipitation || [];
  const windSpd = h.wind_speed_10m || [];
  const windDir = h.wind_direction_10m || [];
  const cloud = h.cloud_cover || [];
  const n = times.length;
  if (n === 0) return;

  // Sections: temp 55%, precip 22%, wind 23%
  const tempTop = mt, tempBot = mt + ph * 0.55;
  const precipTop = tempBot + 1, precipBot = tempBot + ph * 0.22;
  const windTop = precipBot + 1, windBot = mt + ph;

  // X scale: show first 96 hours (4 days)
  const maxH = Math.min(n, 96);

  function xPos(i) { return ml + (i / (maxH - 1)) * pw; }

  // ─ Grid lines ─
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = ml + (i / 4) * pw;
    ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, windBot); ctx.stroke();
  }
  // Horizontal divider
  ctx.beginPath(); ctx.moveTo(ml, tempBot); ctx.lineTo(ml + pw, tempBot); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ml, precipBot); ctx.lineTo(ml + pw, precipBot); ctx.stroke();

  // ─ Cloud cover (background shading) ─
  if (cloud.length) {
    for (let i = 0; i < maxH; i++) {
      const x1 = xPos(i), x2 = i < maxH - 1 ? xPos(i + 1) : x1 + pw / maxH;
      const cv = cloud[i] || 0;
      ctx.fillStyle = `rgba(180,180,200,${cv / 100 * 0.15})`;
      ctx.fillRect(x1, tempTop, x2 - x1, tempBot - tempTop);
    }
  }

  // ─ Temperature line ─
  if (temps.length) {
    const validTemps = temps.slice(0, maxH).filter(v => v != null);
    const tMin = Math.floor(Math.min(...validTemps) - 2);
    const tMax = Math.ceil(Math.max(...validTemps) + 2);
    const tRange = Math.max(tMax - tMin, 1);

    // Y labels
    ctx.fillStyle = '#667';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = tMin + (i / 4) * tRange;
      const y = tempBot - (i / 4) * (tempBot - tempTop);
      ctx.fillText(val.toFixed(0) + '°', ml - 4, y + 3);
    }

    // Gradient fill under line
    ctx.beginPath();
    for (let i = 0; i < maxH; i++) {
      if (temps[i] == null) continue;
      const x = xPos(i);
      const y = tempBot - ((temps[i] - tMin) / tRange) * (tempBot - tempTop);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(xPos(maxH - 1), tempBot);
    ctx.lineTo(ml, tempBot);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, tempTop, 0, tempBot);
    grad.addColorStop(0, 'rgba(255,107,107,.2)');
    grad.addColorStop(1, 'rgba(255,107,107,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < maxH; i++) {
      if (temps[i] == null) continue;
      const x = xPos(i);
      const y = tempBot - ((temps[i] - tMin) / tRange) * (tempBot - tempTop);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Second model line if available
    const otherModel = model === 'gfs' ? 'ecmwf' : 'gfs';
    const pd2 = S.pointData[otherModel];
    if (pd2 && pd2.hourly && pd2.hourly.temperature_2m) {
      const temps2 = pd2.hourly.temperature_2m;
      ctx.beginPath();
      for (let i = 0; i < maxH; i++) {
        if (temps2[i] == null) continue;
        const x = xPos(i);
        const y = tempBot - ((temps2[i] - tMin) / tRange) * (tempBot - tempTop);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = otherModel === 'ecmwf' ? 'rgba(77,171,247,.5)' : 'rgba(255,107,107,.4)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Current hour indicator
    if (S.hour < maxH) {
      const cx = xPos(S.hour);
      const cy = tempBot - ((temps[S.hour] - tMin) / tRange) * (tempBot - tempTop);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ─ Precipitation bars ─
  if (precip.length) {
    const pMax = Math.max(1, ...precip.slice(0, maxH).filter(v => v != null));
    ctx.fillStyle = '#4dabf7';
    for (let i = 0; i < maxH; i++) {
      if (precip[i] == null || precip[i] <= 0) continue;
      const x1 = xPos(i);
      const barW = Math.max(2, pw / maxH - 1);
      const barH = (precip[i] / pMax) * (precipBot - precipTop - 2);
      ctx.fillRect(x1 - barW / 2, precipBot - barH, barW, barH);
    }
    // Label
    ctx.fillStyle = '#667';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillText(pMax.toFixed(0) + 'mm', ml - 4, precipTop + 10);
  }

  // ─ Wind barbs ─
  if (windSpd.length && windDir.length) {
    const wMid = (windTop + windBot) / 2;
    const step = Math.max(1, Math.floor(maxH / 24));
    for (let i = 0; i < maxH; i += step) {
      if (windSpd[i] == null || windDir[i] == null) continue;
      const x = xPos(i);
      const dirRad = (windDir[i] + 180) * Math.PI / 180;
      const len = 10;
      const tx = x + Math.sin(dirRad) * len;
      const ty = wMid - Math.cos(dirRad) * len;
      const sx = x - Math.sin(dirRad) * len;
      const sy = wMid + Math.cos(dirRad) * len;

      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();

      // Arrow head
      const headLen = 4;
      const a1 = dirRad + Math.PI + 0.5;
      const a2 = dirRad + Math.PI - 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.sin(a1) * headLen, ty - Math.cos(a1) * headLen);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.sin(a2) * headLen, ty - Math.cos(a2) * headLen);
      ctx.stroke();

      // Speed label
      ctx.fillStyle = 'rgba(255,255,255,.3)';
      ctx.font = '8px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText(Math.round(windSpd[i]), x, windBot - 2);
    }
  }

  // ─ Time axis ─
  ctx.fillStyle = '#556';
  ctx.font = '9px JetBrains Mono';
  ctx.textAlign = 'center';
  const dayStep = 24;
  for (let i = 0; i < maxH; i += dayStep) {
    const x = xPos(i);
    const d = new Date(times[i]);
    const label = d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' });
    ctx.fillText(label, x, windBot + 14);
    // Hour
    ctx.fillText(d.getHours() + ':00', x, windBot + 24);
  }
}

// ── MAIN CLICK HANDLER ─────────────────────────────────────────────
async function onMapClick(e) {
  S.lat = e.lngLat.lat;
  S.lon = e.lngLat.lng;
  $('locText').textContent = `${S.lat.toFixed(2)}°N, ${S.lon.toFixed(2)}°E`;

  if (marker) marker.remove();
  marker = new maplibregl.Marker({ color: '#5BA3E0' }).setLngLat([S.lon, S.lat]).addTo(map);

  // Fetch point data for meteogram
  S.pointData = await fetchPointData(S.lat, S.lon);
  renderMeteogram();

  // Fetch grid data for spatial field
  const model = $('mapModelSelect').value;
  const result = await fetchGridData(S.lat, S.lon, model);
  if (result) {
    S.gridCache[model] = result;
    applyField(S.hour);
  }

  // Start particle animation if not running
  if (!S.animFrame) {
    initParticles();
    animateParticles();
  }
}

// ── EVENT LISTENERS ────────────────────────────────────────────────
map.on('click', onMapClick);

// Overlays
$('startBtn').addEventListener('click', () => $('welcomeOverlay').classList.add('hidden'));
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
  const model = $('mapModelSelect').value;
  if (S.gridCache[model]) {
    applyField(S.hour);
  }
  renderMeteogram();
});

// Model change (field)
$('mapModelSelect').addEventListener('change', async () => {
  const model = $('mapModelSelect').value;
  if (!S.lat) return;
  if (!S.gridCache[model]) {
    const result = await fetchGridData(S.lat, S.lon, model);
    if (result) S.gridCache[model] = result;
  }
  applyField(S.hour);
  renderMeteogram();
});

// Hour slider
$('hourSlider').addEventListener('input', () => {
  S.hour = parseInt($('hourSlider').value);
  $('hourValue').textContent = `+${S.hour} h`;
  const model = $('mapModelSelect').value;
  if (S.gridCache[model]) applyField(S.hour);
  renderMeteogram();
});

// Play / Stop animation
$('playBtn').addEventListener('click', () => {
  S.playing = true;
  $('playBtn').disabled = true;
  $('stopBtn').disabled = false;
  const speed = parseInt($('speedSelect').value);
  S.playTimer = setInterval(() => {
    S.hour = (S.hour + 1) % 91;
    $('hourSlider').value = S.hour;
    $('hourValue').textContent = `+${S.hour} h`;
    const model = $('mapModelSelect').value;
    if (S.gridCache[model]) applyField(S.hour);
    renderMeteogram();
  }, speed);
});

$('stopBtn').addEventListener('click', () => {
  S.playing = false;
  $('playBtn').disabled = false;
  $('stopBtn').disabled = true;
  clearInterval(S.playTimer);
});

$('speedSelect').addEventListener('change', () => {
  if (S.playing) {
    clearInterval(S.playTimer);
    const speed = parseInt($('speedSelect').value);
    S.playTimer = setInterval(() => {
      S.hour = (S.hour + 1) % 91;
      $('hourSlider').value = S.hour;
      $('hourValue').textContent = `+${S.hour} h`;
      const model = $('mapModelSelect').value;
      if (S.gridCache[model]) applyField(S.hour);
      renderMeteogram();
    }, speed);
  }
});

// Layer toggles
$('showParticles').addEventListener('change', e => {
  S.layers.particles = e.target.checked;
  if (!e.target.checked) pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
});
$('showField').addEventListener('change', e => {
  S.layers.field = e.target.checked;
  renderField();
});
$('showBarbs').addEventListener('change', e => {
  S.layers.barbs = e.target.checked;
  renderField();
});

// Redraw field on map move
let moveTimeout;
map.on('move', () => {
  clearTimeout(moveTimeout);
  moveTimeout = setTimeout(renderField, 80);
  // Clear particle trails on move
  pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
});
map.on('zoom', () => {
  clearTimeout(moveTimeout);
  moveTimeout = setTimeout(renderField, 80);
  pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
});

// Initial legend render
updateLegend('temperature_2m');
