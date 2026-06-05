// Front-end: load a model, read its embedded material-passport parameters, color
// elements by a metric, gray out no-data, inspect an element on click, summarize the
// passport by category with charts, and filter by Building layer / Building design.
// Metrics live on the Revit elements as the "General" group; gaps are backfilled from the
// spreadsheet passport (static/passport.json, joined by Building Design).

const statusEl   = document.getElementById('status');
const modelSelect = document.getElementById('model-select');
const colorSelect = document.getElementById('color-select');
const legendEl   = document.getElementById('legend');
const summaryBtn = document.getElementById('summary-btn');
const summaryEl  = document.getElementById('summary');
const sumGroupSel   = document.getElementById('sum-group');
const sumMeasureSel = document.getElementById('sum-measure');
const sumBodyEl  = document.getElementById('sum-body');
const filterBtn  = document.getElementById('filter-btn');
const filterEl   = document.getElementById('filter');
const filterBodyEl = document.getElementById('filter-body');
function setStatus(msg) { statusEl.textContent = msg; }

let viewer = null;
let models = [];

// Per-loaded-model state (rebuilt on every model switch).
let leafIds = [];
let valuesByParam = {};   // paramName -> Map(dbId -> rawValue)   (for theming)
let presentParams = [];
let records = [];         // [{dbId, co2, lifespan, reusePot, buildingLayer, buildingDesign, material, category}]
let categoryOf = new Map();
let filterValues = { layer: [], design: [] };
let geomHandler = null;   // one-shot GEOMETRY_LOADED listener for the in-flight model load
let passportMap = {};     // spreadsheet passport, keyed by normalized Building Design
let woodColor = null;     // pergola-framework material colour, themed onto columns + slabs

// Metrics offered in "Color by". `highIs` sets the numeric gradient direction.
// `range: [min,max]` pins fixed color thresholds (matching the report figures); otherwise the
// gradient auto-scales to the data. `lo`/`hi` override the legend end labels.
const PARAMS = [
  { name: 'Embodied CO2 Emissions', label: 'Embodied CO₂',       unit: 'kg CO₂e', type: 'numeric',     highIs: 'bad',  range: [0, 105000] },
  { name: 'Reused',                 label: 'Reused',                               type: 'numeric',     highIs: 'good', range: [0, 1], lo: 'not reused', hi: 'reused' },
  { name: 'Reused Potential',       label: 'Reuse potential',     unit: '0–1',     type: 'numeric',     highIs: 'good' },
  { name: 'Recycling Potential',    label: 'Recycling potential', unit: '0–1',     type: 'numeric',     highIs: 'good' },
  { name: 'Waste',                  label: 'Waste',               unit: '0–1',     type: 'numeric',     highIs: 'bad'  },
  { name: 'Lifespan',               label: 'Lifespan',            unit: 'years',   type: 'numeric',     highIs: 'good', range: [1, 100] },
  { name: 'U-Value',                label: 'U-value',             unit: 'W/m²K',   type: 'numeric',     highIs: 'bad'  },
  { name: 'Number of Elements',     label: 'Number of elements',                   type: 'numeric',     highIs: 'bad',  range: [1, 8] },
  { name: 'Building Layer',         label: 'Building layer',                       type: 'categorical' },
  { name: 'Connector Type',         label: 'Connection type',                      type: 'categorical' },
];

// Click-to-inspect panel: ONE consolidated list. Each row's value comes from the Revit model
// attribute (`model`) if present, otherwise from the joined spreadsheet passport (`pp`).
// "Materials" is the only spreadsheet-only field.
const INSPECT_FIELDS = [
  { label: 'Materials',           model: null,                      pp: (p) => (p.materials || []).join(', ') },
  { label: 'Embodied CO₂',        model: 'Embodied CO2 Emissions',  unit: 'kg CO₂e', pp: (p) => p.co2 },
  { label: 'Lifespan',            model: 'Lifespan',                unit: 'years',   pp: (p) => p.lifespan },
  { label: 'Reused',              model: 'Reused',                  unit: '0–1',     pp: (p) => p.reused },
  { label: 'Reuse potential',     model: 'Reused Potential',        unit: '0–1',     pp: (p) => p.reusePotential },
  { label: 'Recycling potential', model: 'Recycling Potential',     unit: '0–1',     pp: (p) => p.recyclingPotential },
  { label: 'Waste',               model: 'Waste',                   unit: '0–1',     pp: (p) => p.waste },
  { label: 'U-value',             model: 'U-Value',                 unit: 'W/m²K',   pp: (p) => p.uValue },
  { label: 'Building layer',      model: 'Building Layer',          pp: (p) => p.buildingLayer },
  { label: 'Building design',     model: 'Building Design',         pp: (p) => p.buildingDesign },
  { label: 'Connection type',     model: 'Connector Type',          pp: (p) => p.connection },
  { label: 'Future scenarios',    model: 'Future Scenarios',        pp: null },
  { label: 'Number of elements',  model: 'Number of Elements',      pp: (p) => p.numElements },
  { label: 'Manufacturer',        model: "Manufacturer's Name",     pp: (p) => p.manufacturer },
  { label: 'Address',             model: "Manufacturer's Address",  pp: (p) => p.address },
];

// Summary: how to group, and what to measure.
const GROUPERS = [
  { key: 'buildingLayer',  label: 'Building layer' },
  { key: 'buildingDesign', label: 'Building design' },
  { key: 'material',       label: 'Material' },
  { key: 'category',       label: 'Revit category' },
];
const MEASURES = [
  { key: 'co2',      label: 'Embodied CO₂ (total)',   unit: 'kg CO₂e', agg: 'sum',   field: 'co2',      additive: true  },
  { key: 'count',    label: 'Element count',          unit: '',        agg: 'count',                    additive: true  },
  { key: 'lifespan', label: 'Lifespan (avg)',         unit: 'years',   agg: 'avg',   field: 'lifespan', additive: false },
  { key: 'reuse',    label: 'Reuse potential (avg)',  unit: '0–1',     agg: 'avg',   field: 'reusePot', additive: false },
];

const CAT_PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
                     '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const NO_DATA_COLOR = new THREE.Vector4(0.85, 0.86, 0.89, 1);


// ---- APS token (read-only) -----------------------------------------------------
async function getAccessToken(onSuccess) {
  try {
    const resp = await fetch('/api/token');
    const data = await resp.json();
    onSuccess(data.access_token, data.expires_in);
  } catch (err) {
    setStatus('could not get a viewer token — is server.py running?');
    console.error(err);
  }
}
function apiForRegion(region) {
  return (region || 'US').toUpperCase() === 'EMEA' ? 'streamingV2_EU' : 'streamingV2';
}

// ---- color + number helpers ----------------------------------------------------
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}
function numericColor(t, highIs) {
  const hue = highIs === 'good' ? t * 140 : (1 - t) * 140;
  return hslToRgb(hue, 0.65, 0.5);
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function cssRgb(rgb) { return `rgb(${rgb.map(x => Math.round(x * 255)).join(',')})`; }
function fmt(n) {
  if (Number.isInteger(n)) return n.toLocaleString();
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString();
  if (a >= 10)   return n.toFixed(0);
  return n.toFixed(2);
}
function tidyNum(v) {
  const s = String(v).trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return v;
  const n = parseFloat(s);
  return Number.isInteger(n) ? n.toLocaleString()
                             : parseFloat(n.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : null;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function passportKey(s) {   // matches the normalization used when building passport.json
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}
// When a Revit element's "Building Design" is blank/unmatched, map it to a spreadsheet
// component by category + type name so it still joins the passport (e.g. Aeternum columns).
const DESIGN_ALIASES = [
  // Corner columns are a distinct Revit family ("Aeternum Corner Column …"); regular ones are
  // "Aeternum Column …". Match on the element name; both heights map to the same passport row.
  { nameIncludes: 'Aeternum Corner Column', design: 'Column above ground (Corner)' },
  { nameIncludes: 'Aeternum Column',        design: 'Column above ground (Regular)' },
];
function resolveDesign(buildingDesign, name, category, typeName) {
  if (passportMap[passportKey(buildingDesign)]) return buildingDesign;   // already matches
  const a = DESIGN_ALIASES.find((x) =>
    (!x.nameIncludes || (name && String(name).indexOf(x.nameIncludes) !== -1)) &&
    (!x.category || x.category === category) &&
    (!x.type || x.type === typeName));
  return a ? a.design : buildingDesign;
}

// ---- read the model's tree + properties ----------------------------------------
function readTree(model) {
  return new Promise((resolve) => {
    model.getObjectTree((tree) => {
      const root = tree.getRootId();
      const leaves = [];
      const catOf = new Map();
      const nameOf = new Map();
      tree.enumNodeChildren(root, (dbId) => {
        let hasChild = false;
        tree.enumNodeChildren(dbId, () => { hasChild = true; });
        if (!hasChild) leaves.push(dbId);
      }, true);
      leaves.forEach((dbId) => {                       // Revit category = top-level ancestor
        nameOf.set(dbId, tree.getNodeName(dbId));       // element's own name (family + type + id)
        let cur = dbId, parent = tree.getNodeParentId(cur), guard = 0;
        while (parent != null && parent !== root && parent !== cur && guard++ < 64) {
          cur = parent; parent = tree.getNodeParentId(cur);
        }
        catOf.set(dbId, tree.getNodeName(cur));
      });
      resolve({ leafIds: leaves, categoryOf: catOf, nameOf });
    }, () => resolve({ leafIds: [], categoryOf: new Map(), nameOf: new Map() }));
  });
}
function bulkRead(model, dbIds, names) {
  return new Promise((resolve) => {
    model.getBulkProperties(dbIds, names, (results) => resolve(results), () => resolve([]));
  });
}

async function indexProperties(model) {
  const tree = await readTree(model);
  leafIds = tree.leafIds;
  categoryOf = tree.categoryOf;

  const allNames = [...new Set([...PARAMS.map((p) => p.name), 'Material', 'Building Design', 'Type Name'])];
  const results = await bulkRead(model, leafIds, allNames);

  const perEl = new Map();
  results.forEach((res) => {
    const m = {};
    (res.properties || []).forEach((pr) => {
      if (pr.displayValue !== '' && pr.displayValue != null && !(pr.displayName in m)) {
        m[pr.displayName] = pr.displayValue;
      }
    });
    perEl.set(res.dbId, m);
  });

  valuesByParam = {};
  PARAMS.forEach((p) => { valuesByParam[p.name] = new Map(); });
  records = [];
  perEl.forEach((m, dbId) => {
    PARAMS.forEach((p) => { if (m[p.name] !== undefined) valuesByParam[p.name].set(dbId, m[p.name]); });
    records.push({
      dbId,
      co2:            num(m['Embodied CO2 Emissions']),
      lifespan:       num(m['Lifespan']),
      reusePot:       num(m['Reused Potential']),
      buildingLayer:  m['Building Layer'],
      buildingDesign: m['Building Design'],
      material:       m['Material'],
      typeName:       m['Type Name'],
      name:           tree.nameOf.get(dbId),
      category:       categoryOf.get(dbId),
    });
  });

  // Fill gaps from the spreadsheet passport (joined by Building Design, with category/type
  // aliases for blank-design elements like the Aeternum columns). Model values win where
  // present; the spreadsheet fills what's missing — in records AND in Color-by/legend.
  records.forEach((rec) => {
    const design = resolveDesign(rec.buildingDesign, rec.name, rec.category, rec.typeName);
    const p = passportMap[passportKey(design)];
    if (!p) return;
    rec.passport = p;
    const miss = (x) => x == null || x === 0;   // model stores 0 for unfilled column metrics
    if (!rec.buildingDesign) rec.buildingDesign = design;
    if (!rec.buildingLayer && p.buildingLayer) rec.buildingLayer = p.buildingLayer;
    if ((rec.material == null || rec.material === '') && (p.materials || []).length) rec.material = p.materials[0];
    if (miss(rec.co2) && p.co2 != null) rec.co2 = p.co2;
    if (miss(rec.lifespan) && p.lifespan != null) rec.lifespan = p.lifespan;
    if (miss(rec.reusePot) && p.reusePotential != null) rec.reusePot = p.reusePotential;
    const fill = {
      'Embodied CO2 Emissions': p.co2, 'Reused Potential': p.reusePotential,
      'Recycling Potential': p.recyclingPotential, 'Waste': p.waste, 'Lifespan': p.lifespan,
      'Number of Elements': p.numElements, 'U-Value': p.uValue,
      'Building Layer': p.buildingLayer, 'Connector Type': p.connection, 'Building Design': design,
    };
    Object.keys(fill).forEach((name) => {
      const pv = fill[name];
      if (pv == null || pv === '') return;
      const map = valuesByParam[name];
      if (!map) return;
      const mv = map.get(rec.dbId);
      // override the model only when it's missing or a placeholder 0 (keeps real text values)
      if (mv == null || String(mv).trim() === '' || parseFloat(mv) === 0) map.set(rec.dbId, pv);
    });
  });

  presentParams = PARAMS.filter((p) => valuesByParam[p.name].size > 0);

  colorSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'None (original colors)';
  colorSelect.appendChild(none);
  presentParams.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name; opt.textContent = p.label;
    colorSelect.appendChild(opt);
  });
  colorSelect.disabled = presentParams.length === 0;
  colorSelect.value = '';
  computeWoodColor();
  applyTheming('');
  renderSummary();
  renderFilter();
}

// ---- theming (color metric + gray no-data) + legend ----------------------------
function applyTheming(paramName) {
  viewer.clearThemingColors(viewer.model);
  if (!paramName) { legendEl.style.display = 'none'; applyWoodSkin(); viewer.impl.invalidate(true); return; }

  const meta = PARAMS.find((p) => p.name === paramName);
  const map = valuesByParam[paramName];

  if (meta.type === 'numeric') {
    let min, max;
    if (meta.range) {                                   // fixed thresholds (match the report figures)
      min = meta.range[0]; max = meta.range[1];
    } else {
      const nums = [...map.values()].map(parseFloat).filter((v) => !isNaN(v));
      min = Math.min(...nums); max = Math.max(...nums);
    }
    if (min === max) max = min + 1;
    map.forEach((val, dbId) => {
      const f = parseFloat(val);
      if (isNaN(f)) return;
      const t = Math.max(0, Math.min(1, (f - min) / (max - min)));   // clamp to the fixed range
      const [r, g, b] = numericColor(t, meta.highIs);
      viewer.setThemingColor(dbId, new THREE.Vector4(r, g, b, 1), viewer.model);
    });
    renderNumericLegend(meta, min, max);
  } else {
    const uniq = [...new Set([...map.values()].map(String))].sort();
    const colorByVal = {};
    uniq.forEach((u, i) => { colorByVal[u] = CAT_PALETTE[i % CAT_PALETTE.length]; });
    map.forEach((val, dbId) => {
      const [r, g, b] = hexToRgb(colorByVal[String(val)]);
      viewer.setThemingColor(dbId, new THREE.Vector4(r, g, b, 1), viewer.model);
    });
    renderCategoricalLegend(meta, colorByVal);
  }

  let grayed = 0;
  leafIds.forEach((dbId) => {
    if (!map.has(dbId)) { viewer.setThemingColor(dbId, NO_DATA_COLOR, viewer.model); grayed++; }
  });
  if (grayed > 0) {
    legendEl.insertAdjacentHTML('beforeend',
      `<div class="lg-row" style="margin-top:6px"><span class="lg-sw" style="background:#dcdee3"></span>no data</div>`);
  }
  viewer.impl.invalidate(true);
}

function renderNumericLegend(meta, min, max) {
  const grad = `linear-gradient(90deg, ${cssRgb(numericColor(0, meta.highIs))}, ` +
               `${cssRgb(numericColor(0.5, meta.highIs))}, ${cssRgb(numericColor(1, meta.highIs))})`;
  legendEl.style.display = 'block';
  legendEl.innerHTML =
    `<div class="lg-title">${meta.label}` +
      (meta.unit ? ` <span class="lg-unit">${meta.unit}</span>` : '') + `</div>` +
    `<div class="lg-bar" style="background:${grad}"></div>` +
    `<div class="lg-scale"><span>${esc(meta.lo || fmt(min))}</span><span>${esc(meta.hi || fmt(max))}</span></div>`;
}
function renderCategoricalLegend(meta, colorByVal) {
  const rows = Object.entries(colorByVal)
    .map(([v, c]) => `<div class="lg-row"><span class="lg-sw" style="background:${c}"></span>${esc(v) || '(blank)'}</div>`)
    .join('');
  legendEl.style.display = 'block';
  legendEl.innerHTML = `<div class="lg-title">${meta.label}</div>${rows}`;
}

// ---- click-to-inspect passport panel -------------------------------------------
function showInspector(res) {
  const byName = {};
  (res.properties || []).forEach((pr) => {
    if (pr.displayValue !== '' && pr.displayValue != null && !(pr.displayName in byName)) {
      byName[pr.displayName] = pr.displayValue;
    }
  });
  document.getElementById('ins-title').textContent = res.name || 'Element';

  // Resolve the joined spreadsheet passport (with category/type aliases for blank designs).
  const design = resolveDesign(byName['Building Design'], res.name, categoryOf.get(res.dbId), byName['Type Name']);
  const p = passportMap[passportKey(design || '')] || null;

  // One consolidated list. Model value wins, EXCEPT a placeholder model 0 (these columns store
  // 0 for unfilled metrics) loses to a real passport value.
  const rows = INSPECT_FIELDS.map((f) => {
    const mv = f.model ? byName[f.model] : undefined;
    const pv = (p && f.pp) ? f.pp(p) : undefined;
    const hasM = mv != null && String(mv).trim() !== '';
    const hasP = pv != null && String(pv).trim() !== '';
    const modelIsZero = hasM && parseFloat(mv) === 0;
    const v = (hasM && !(modelIsZero && hasP)) ? mv : (hasP ? pv : (hasM ? mv : undefined));
    if (v == null || String(v).trim() === '') return '';
    const active = (f.model && colorSelect.value === f.model) ? ' ins-active' : '';
    const unit = f.unit ? ` <span class="ins-unit">${f.unit}</span>` : '';
    return `<div class="ins-row${active}"><span class="ins-k">${f.label}</span>` +
           `<span class="ins-v">${esc(tidyNum(v))}${unit}</span></div>`;
  }).join('');

  document.getElementById('ins-body').innerHTML =
    rows || '<div class="ins-empty">No data on this element.</div>';
  document.getElementById('inspector').style.display = 'block';
}
function hideInspector() { document.getElementById('inspector').style.display = 'none'; }

// ---- summary by category (charts) ----------------------------------------------
function aggregate(groupKey, measure) {
  const groups = new Map();
  records.forEach((r) => {
    const raw = r[groupKey];
    if (raw == null || String(raw).trim() === '') return;
    const g = String(raw);
    let o = groups.get(g);
    if (!o) { o = { group: g, count: 0, validSum: 0, validN: 0, dbIds: [] }; groups.set(g, o); }
    o.count++; o.dbIds.push(r.dbId);
    if (measure.field) {
      const v = r[measure.field];
      if (v != null && !isNaN(v)) { o.validSum += v; o.validN++; }
    }
  });
  const rows = [...groups.values()].map((o) => ({
    ...o,
    value: measure.agg === 'count' ? o.count
         : measure.agg === 'sum'   ? o.validSum
         : (o.validN ? o.validSum / o.validN : 0),
  }));
  rows.sort((a, b) => b.value - a.value);
  return rows;
}
function capRows(rows, measure) {
  if (rows.length <= 12) return rows;
  const top = rows.slice(0, 11);
  const rest = rows.slice(11);
  const o = { group: `Other (${rest.length})`, count: 0, validSum: 0, validN: 0, dbIds: [] };
  rest.forEach((r) => { o.count += r.count; o.validSum += r.validSum; o.validN += r.validN; o.dbIds = o.dbIds.concat(r.dbIds); });
  o.value = measure.agg === 'count' ? o.count
          : measure.agg === 'sum'   ? o.validSum
          : (o.validN ? o.validSum / o.validN : 0);
  top.push(o);
  return top;
}

function renderSummary() {
  if (summaryEl.style.display !== 'block') return;
  const grouper = GROUPERS.find((g) => g.key === sumGroupSel.value) || GROUPERS[0];
  const measure = MEASURES.find((m) => m.key === sumMeasureSel.value) || MEASURES[0];

  if (!records.length) { sumBodyEl.innerHTML = '<div class="ins-empty">No element data.</div>'; return; }
  const rows = capRows(aggregate(grouper.key, measure), measure);
  if (!rows.length) { sumBodyEl.innerHTML = '<div class="ins-empty">No elements carry this category.</div>'; return; }

  const additive = measure.additive;
  const total = additive ? rows.reduce((s, r) => s + r.value, 0) : null;
  const hasNeg = rows.some((r) => r.value < 0);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const shareOk = additive && !hasNeg && total > 0;     // donut + % only valid when single-sign
  const EMIT = '#e15759', STORE = '#4e9f50';            // emitted (+) vs stored (−) carbon

  let html = additive
    ? `<div class="sum-total">Net <b>${fmt(total)}</b>${measure.unit ? ` <span class="lg-unit">${measure.unit}</span>` : ''} · ${records.length} elements</div>`
    : `<div class="sum-total">${measure.label} · ${records.length} elements</div>`;

  if (shareOk) {
    let acc = 0;
    const stops = rows.map((r, i) => {
      const a = acc / total * 100; acc += r.value; const b = acc / total * 100;
      return `${CAT_PALETTE[i % CAT_PALETTE.length]} ${a}% ${b}%`;
    }).join(', ');
    html += `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops})"></div></div>`;
  }

  html += rows.map((r, i) => {
    const palette = CAT_PALETTE[i % CAT_PALETTE.length];
    const swatch = hasNeg ? (r.value < 0 ? STORE : EMIT) : palette;
    const val = measure.agg === 'avg' ? tidyNum(r.value.toFixed(2)) : fmt(r.value);
    const share = shareOk ? ` <span class="sum-share">${(r.value / total * 100).toFixed(0)}%</span>` : '';
    let bar;
    if (hasNeg) {                                        // diverging bar around a zero line
      const w = Math.max(0.5, Math.abs(r.value) / maxAbs * 50);
      const side = r.value < 0 ? 'right:50%' : 'left:50%';
      bar = `<div class="sum-dbar"><span class="sum-dbar-zero"></span>` +
            `<span class="sum-dbar-fill" style="${side};width:${w}%;background:${r.value < 0 ? STORE : EMIT}"></span></div>`;
    } else {                                             // simple left-anchored bar
      bar = `<div class="sum-bar"><span style="width:${Math.max(2, r.value / maxAbs * 100)}%;background:${palette}"></span></div>`;
    }
    return `<div class="sum-row" data-i="${i}" title="click to isolate in 3D">` +
             `<div class="sum-rowhead">` +
               `<span class="sum-sw" style="background:${swatch}"></span>` +
               `<span class="sum-g">${esc(r.group)}</span>` +
               `<span class="sum-v">${val}${share}</span>` +
             `</div>${bar}</div>`;
  }).join('');

  if (hasNeg) {
    html += `<div class="sum-note"><span class="sum-sw" style="background:${STORE}"></span>stored (−)` +
            `<span class="sum-sw" style="background:${EMIT};margin-left:10px"></span>emitted (+)</div>`;
  }
  html += `<div class="sum-reset" id="sum-reset">⟲ show all</div>`;
  sumBodyEl.innerHTML = html;

  sumBodyEl.querySelectorAll('.sum-row').forEach((el) => {
    el.onclick = () => isolateGroup(rows[parseInt(el.dataset.i, 10)].dbIds);
  });
  document.getElementById('sum-reset').onclick = resetIsolation;
}
function isolateGroup(dbIds) {
  if (!dbIds || !dbIds.length) return;
  viewer.isolate(dbIds, viewer.model);
  viewer.fitToView(dbIds, viewer.model);
}
function resetIsolation() {
  viewer.showAll();
  viewer.fitToView();
}

// ---- filter by Building layer / Building design --------------------------------
function uniqueCounts(key) {
  const m = new Map();
  records.forEach((r) => {
    const v = r[key];
    if (v == null || String(v).trim() === '') return;
    const s = String(v);
    m.set(s, (m.get(s) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}
function filterSection(dim, label, items) {
  if (!items.length) {
    return `<div class="flt-sec"><div class="flt-head"><span>${label}</span></div><div class="ins-empty">none</div></div>`;
  }
  const boxes = items.map((it) =>
    `<label class="flt-row"><input type="checkbox" data-dim="${dim}" value="${esc(it.value)}" checked>` +
    `<span class="flt-name" title="${esc(it.value)}">${esc(it.value)}</span>` +
    `<span class="flt-count">${it.count}</span></label>`
  ).join('');
  return `<div class="flt-sec"><div class="flt-head"><span>${label}</span>` +
         `<span class="flt-actions"><a class="flt-allnone" data-dim="${dim}" data-act="all">all</a> · ` +
         `<a class="flt-allnone" data-dim="${dim}" data-act="none">none</a></span></div>` +
         `<div class="flt-list">${boxes}</div></div>`;
}
function getChecked(dim) {
  const set = new Set();
  filterBodyEl.querySelectorAll(`input[data-dim="${dim}"]:checked`).forEach((cb) => set.add(cb.value));
  return set;
}
function applyFilter() {
  const layerSel = getChecked('layer');
  const designSel = getChecked('design');
  const layerActive = layerSel.size < filterValues.layer.length;
  const designActive = designSel.size < filterValues.design.length;
  viewer.showAll();                                    // clean baseline each apply
  if (!layerActive && !designActive) return;           // nothing constrained -> show everything
  const shown = [];
  records.forEach((r) => {
    const okL = !layerActive || (r.buildingLayer  != null && layerSel.has(String(r.buildingLayer)));
    const okD = !designActive || (r.buildingDesign != null && designSel.has(String(r.buildingDesign)));
    if (okL && okD) shown.push(r.dbId);
  });
  if (shown.length) { viewer.isolate(shown, viewer.model); viewer.fitToView(shown, viewer.model); }
  else { viewer.hide(leafIds); }                        // nothing matches -> show nothing
}
function renderFilter() {
  if (filterEl.style.display !== 'block') return;
  if (!records.length) { filterBodyEl.innerHTML = '<div class="ins-empty">No element data.</div>'; return; }
  filterValues = { layer: uniqueCounts('buildingLayer'), design: uniqueCounts('buildingDesign') };
  filterBodyEl.innerHTML =
    filterSection('layer', 'Building layer', filterValues.layer) +
    filterSection('design', 'Building design', filterValues.design) +
    `<div class="sum-reset" id="filter-reset">⟲ show all</div>`;

  filterBodyEl.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.onchange = applyFilter; });
  filterBodyEl.querySelectorAll('.flt-allnone').forEach((a) => {
    a.onclick = () => {
      const on = a.dataset.act === 'all';
      filterBodyEl.querySelectorAll(`input[data-dim="${a.dataset.dim}"]`).forEach((cb) => { cb.checked = on; });
      applyFilter();
    };
  });
  document.getElementById('filter-reset').onclick = () => {
    filterBodyEl.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = true; });
    applyFilter();
  };
}

// ---- left-dock panels (Summary / Filter are mutually exclusive) -----------------
function setLeftPanel(which) {
  summaryEl.style.display = which === 'summary' ? 'block' : 'none';
  filterEl.style.display  = which === 'filter'  ? 'block' : 'none';
  summaryBtn.classList.toggle('active', which === 'summary');
  filterBtn.classList.toggle('active', which === 'filter');
  if (which === 'summary') renderSummary();
  if (which === 'filter') renderFilter();
}
function toggleSummary() { setLeftPanel(summaryEl.style.display === 'block' ? null : 'summary'); }
function toggleFilter()  { setLeftPanel(filterEl.style.display === 'block' ? null : 'filter'); }

// ---- camera --------------------------------------------------------------------
// Force a deterministic isometric framing so every model loads the same way
// (each Revit model otherwise opens at its own saved default 3D view).
function applyIsoView() {
  const bbox = viewer.model.getBoundingBox();
  const min = bbox.min, max = bbox.max;
  const center = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
  const dx = max.x - min.x, dy = max.y - min.y, dz = max.z - min.z;
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 || 1;
  const up = new THREE.Vector3(0, 0, 1);                  // Revit models are Z-up
  const dir = new THREE.Vector3(1, -1, 1).normalize();   // front-right-top isometric corner
  const eye = center.clone().add(dir.multiplyScalar(radius * 2.4));
  viewer.navigation.setView(eye, center);
  viewer.navigation.setCameraUpVector(up);
  viewer.navigation.setPivotPoint(center);
  viewer.fitToView();                                    // keeps the iso direction, tightens framing
}

// ---- wood skin: theme the Aeternum columns + slabs with the pergola-framework wood colour --
// Uses setThemingColor (not setMaterial) so it renders on the viewer's consolidated
// Generic-Models slab geometry too. Applied only in "None" Color-by mode.
function computeWoodColor() {
  woodColor = new THREE.Vector4(0.74, 0.60, 0.42, 1);   // tan fallback
  const it = viewer.model.getInstanceTree();
  const fragList = viewer.model.getFragmentList();
  if (!it || !fragList) return;
  const src = records.find((r) => r.buildingDesign === 'Pergola Framework');
  if (!src) return;
  let mat = null;
  it.enumNodeFragments(src.dbId, (fragId) => { if (!mat) mat = fragList.getMaterial(fragId); }, true);
  if (mat && mat.color) woodColor = new THREE.Vector4(mat.color.r, mat.color.g, mat.color.b, 1);
}
function isWoodTarget(r) {
  const nm = r.name || '';
  return nm.indexOf('Aeternum') !== -1 && (nm.indexOf('Column') !== -1 || nm.indexOf('Slab') !== -1);
}
function applyWoodSkin() {
  if (!woodColor) return;
  records.forEach((r) => { if (isWoodTarget(r)) viewer.setThemingColor(r.dbId, woodColor, viewer.model); });
}

// ---- model loading -------------------------------------------------------------
function loadModel(model) {
  setStatus('streaming ' + model.name + ' …');
  colorSelect.disabled = true;
  colorSelect.innerHTML = '';
  legendEl.style.display = 'none';
  hideInspector();

  Autodesk.Viewing.Document.load(
    'urn:' + model.urn,
    (doc) => {
      const geometry = doc.getRoot().getDefaultGeometry();

      // Fit ONLY after geometry (and its bounding box) is loaded. Fitting in the
      // loadDocumentNode promise fires too early on a warm viewer → zooms into nothing.
      if (geomHandler) viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, geomHandler);
      const handler = async () => {
        viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, handler);
        if (geomHandler === handler) geomHandler = null;
        viewer.showAll();          // clear any leftover isolation/hidden state from the prior model
        applyIsoView();            // identical isometric framing for every model
        setStatus(model.name + ' — indexing properties…');
        await indexProperties(viewer.model);
        setStatus(model.name + (presentParams.length
          ? ' · ' + presentParams.length + ' passport metrics'
          : ' · no passport data'));
      };
      geomHandler = handler;
      viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, handler);

      viewer.loadDocumentNode(doc, geometry, { keepCurrentModels: false })
        .catch((err) => console.error('loadDocumentNode error', err));
    },
    (code, message) => {
      setStatus('failed to load (' + code + ')');
      console.error('Document.load error', code, message);
    }
  );
}

async function main() {
  setStatus('loading model list…');
  const resp = await fetch('/api/models');
  if (!resp.ok) { setStatus('no translated models yet — run: python3 aps_pipeline.py'); return; }
  models = await resp.json();
  if (!models.length) { setStatus('no models found'); return; }

  try { passportMap = await (await fetch('/static/passport.json')).json(); }
  catch (e) { console.warn('passport.json not loaded', e); }

  modelSelect.innerHTML = '';
  models.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = String(i); opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });
  // Default to the most-detailed model (LOD 300) regardless of dropdown order.
  let defaultIdx = models.findIndex((m) => m.id === 'lod300');
  if (defaultIdx < 0) defaultIdx = models.length - 1;
  modelSelect.value = String(defaultIdx);

  GROUPERS.forEach((g) => { const o = document.createElement('option'); o.value = g.key; o.textContent = g.label; sumGroupSel.appendChild(o); });
  MEASURES.forEach((m) => { const o = document.createElement('option'); o.value = m.key; o.textContent = m.label; sumMeasureSel.appendChild(o); });

  modelSelect.onchange = () => loadModel(models[parseInt(modelSelect.value, 10)]);
  colorSelect.onchange = () => applyTheming(colorSelect.value);
  summaryBtn.onclick = toggleSummary;
  filterBtn.onclick = toggleFilter;
  document.getElementById('summary-close').onclick = () => setLeftPanel(null);
  document.getElementById('filter-close').onclick = () => setLeftPanel(null);
  sumGroupSel.onchange = renderSummary;
  sumMeasureSel.onchange = renderSummary;
  document.getElementById('ins-close').onclick = () => { viewer.clearSelection(); hideInspector(); };

  Autodesk.Viewing.Initializer(
    { env: 'AutodeskProduction', api: apiForRegion(models[defaultIdx].region), getAccessToken },
    () => {
      viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'));
      viewer.start();
      viewer.setTheme('light-theme');
      viewer.setGhosting(false);   // isolating/filtering hides the rest instead of faint wireframe
      viewer.setQualityLevel(true, true);   // ambient occlusion + antialiasing → richer, more Revit-like render
      viewer.setGroundShadow(true);         // soft contact shadow grounds the model
      viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, () => {
        const sel = viewer.getSelection();
        if (!sel.length) { hideInspector(); return; }
        viewer.getProperties(sel[0], showInspector, hideInspector);
      });
      loadModel(models[defaultIdx]);
    }
  );
}

main();
