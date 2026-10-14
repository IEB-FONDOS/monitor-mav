/* Monitor MAV · IEB — dashboard de cheques, pagarés y FCE negociados en MAV
 * Datos: Google Sheet publicado (pestañas "historico" y "hoy"), alimentado por Apps Script (API MAV).
 */
'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const PUB_ID = '2PACX-1vTD0j3RWyrONWTbyyvL9JhuPpcLR6Lq0zFzegO-g7PS4CVQ4ARrNa1MCEa3gk95z_-gKMl4VbKI4_S_';
const GID    = '1748110732';   // pestaña "historico"
const RT_GID = '1238398910';   // pestaña "hoy"
const pubURL = gid => `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pub?gid=${gid}&single=true&output=csv&t=${Date.now()}`;
const RT_REFRESH_MS = 5 * 60 * 1000;

// ── Dominio ───────────────────────────────────────────────────────────────────
const SEGS = [
  { k: 'Avalado',        c: '#6ea514' },
  { k: 'No Garantizado', c: '#3987e5' },
  { k: 'Garantizado',    c: '#d55181' },
];
const SEG_C = Object.fromEntries(SEGS.map(s => [s.k, s.c]));
const CATS = [
  { k: 'Avalado SGR',     s: 'Aval SGR',     c: '#6ea514' },
  { k: 'Avalado Banco',   s: 'Aval Banco',   c: '#9085e9' },
  { k: 'Garantizado MAV', s: 'Garant. MAV',  c: '#d55181' },
  { k: 'No avalado PyME', s: 'No aval PyME', c: '#3987e5' },
  { k: 'No avalado',      s: 'No avalado',   c: '#c98500' },
];
const CAT_C = Object.fromEntries(CATS.map(c => [c.k, c.c]));
const CAT_S = Object.fromEntries(CATS.map(c => [c.k, c.s]));
const TRAMOS = ['0-30', '31-60', '61-90', '91-120', '121-150', '151-180', '181+'];
const MONEDAS = [
  { k: '$',   l: '$ ARS' },
  { k: 'DOL', l: 'Hard Dollar' },
  { k: 'U$D', l: 'Dólar A3500' },
  { k: 'U$S', l: 'Dólar BNA' },
];
const TIPOS = ['ECHEQ', 'Pagaré', 'FCE', 'CPD'];
const PERIODOS = ['1D', '1S', '1M', '3M', 'YTD', 'Todo'];
const ENT_C = ['#6ea514', '#3987e5', '#d55181'];          // emisor principal + 2 comparados
const RAMP = ['#1f2a12', '#2c3e13', '#3c5615', '#4f7117', '#668f19', '#82b11d', '#a6e635'];

// ── Estado ────────────────────────────────────────────────────────────────────
let HIST = [], HOY = [], HOY_AT = null;
let DATES = [];
const charts = {};
const F = { mon: '$', seg: 'ALL', cat: 'ALL', tipo: 'ALL', calif: 'ALL', per: '1M', desde: '', hasta: '', tramo: null };
let view = 'mercado', hmMode = 'cat', vEst = 'ALL', vSearch = '';
let EMP = { main: null, cmp: [] };
let rtTimer = null;

// ── Utilidades ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtN = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const curSym = () => F.mon === '$' ? '$' : 'US$';
function fmtMonto(v, sym = curSym()) {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return `${sym}${fmtN(v / 1e9, 1)} MM`;
  if (Math.abs(v) >= 1e6) return `${sym}${fmtN(v / 1e6, 1)} M`;
  return `${sym}${fmtN(v / 1e3, 0)} mil`;
}
const fmtD = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '—';
const fmtDs = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const sum = a => a.reduce((s, o) => s + o.monto, 0);
const wavg = (a, k = 'tna') => { let m = 0, x = 0; for (const o of a) { m += o.monto; x += o[k] * o.monto; } return m ? x / m : NaN; };
const wq = (a, q) => { const s = [...a].sort((x, y) => x.tna - y.tna), M = sum(s); let acc = 0; for (const o of s) { acc += o.monto; if (acc >= q * M) return o.tna; } return NaN; };
const tea = (tna, d) => (isFinite(tna) && d > 0) ? (Math.pow(1 + tna / 100 * d / 365, 365 / d) - 1) * 100 : NaN;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tipoGrp = t => /^PAGARE/i.test(t) ? 'Pagaré' : (t === 'ECHEQ' || t === 'FCE' || t === 'CPD') ? t : (t || '—');
const isoAdd = (iso, days) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const isoAddM = (iso, m) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
const groupBy = (a, f) => { const m = new Map(); for (const o of a) { const k = f(o); if (!m.has(k)) m.set(k, []); m.get(k).push(o); } return m; };
const rated = a => a.filter(o => isFinite(o.tna));

function parseNum(s) {
  s = String(s ?? '').replace(/"/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  return parseFloat(s);
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function toOps(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const h = {}; rows[0].forEach((c, i) => h[c.trim()] = i);
  const need = ['SUBASTA', 'FEC.SUB.', 'SEGMENTO', 'MONTO', 'MONEDA'];
  const miss = need.filter(c => !(c in h));
  if (miss.length) throw new Error('Faltan columnas en el CSV: ' + miss.join(', '));
  const g = (r, c) => (c in h && h[c] < r.length) ? r[h[c]].trim() : '';
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const f = g(r, 'FEC.SUB.').split('/');
    if (f.length !== 3) continue;
    const monto = parseNum(g(r, 'MONTO'));
    if (!(monto > 0)) continue;
    out.push({
      id: g(r, 'SUBASTA'), date: `${f[2]}-${f[1].padStart(2, '0')}-${f[0].padStart(2, '0')}`,
      seg: g(r, 'SEGMENTO'), tipoRaw: g(r, 'TIPO INSTRUMENTO'), tipo: tipoGrp(g(r, 'TIPO INSTRUMENTO')),
      plz: g(r, 'PLZ.'), ppv: parseInt(g(r, 'PPV'), 10), tna: parseNum(g(r, 'TASA C.')), mon: g(r, 'MONEDA'), monto,
      cant: parseInt(g(r, 'CANT. INSTRUMENTOS'), 10) || 1, cuit: g(r, 'CUIT RESPONSABLE'), emp: g(r, 'NOMBRE RESPONSABLE') || '(sin nombre)',
      cat: g(r, 'CATEGORIA'), tramo: g(r, 'TRAMO'), comp: g(r, 'COMPRADOR'), vend: g(r, 'VENDEDOR'),
      calif: g(r, 'CALIFICADO') === 'SI' ? 'SI' : 'NO', pyme: g(r, 'PYME'),
      tmin: g(r, 'T.MIN.'), estado: g(r, 'ESTADO') || 'Negociada', hconc: g(r, 'HORA CONC.'),
    });
  }
  return out;
}

// ── Filtros ───────────────────────────────────────────────────────────────────
function passBase(o, skip = {}) {
  if (!skip.mon && o.mon !== F.mon) return false;
  if (!skip.seg && F.seg !== 'ALL' && o.seg !== F.seg) return false;
  if (!skip.cat && F.cat !== 'ALL' && o.cat !== F.cat) return false;
  if (!skip.tipo && F.tipo !== 'ALL' && o.tipo !== F.tipo) return false;
  if (F.calif !== 'ALL' && o.calif !== F.calif) return false;
  if (!skip.tramo && F.tramo && o.tramo !== F.tramo) return false;
  return true;
}
const inPer = o => o.date >= F.desde && o.date <= F.hasta;

function setPeriodo(p) {
  F.per = p;
  const last = DATES[DATES.length - 1], first = DATES[0];
  if (!last) return;
  F.hasta = last;
  F.desde = p === '1D' ? last : p === '1S' ? isoAdd(last, -6) : p === '1M' ? isoAddM(last, -1) : p === '3M' ? isoAddM(last, -3)
    : p === 'YTD' ? last.slice(0, 4) + '-01-01' : first;
  if (F.desde < first) F.desde = first;
}

function buildFilters() {
  $('fMon').innerHTML = MONEDAS.map(m => `<button class="chip${F.mon === m.k ? ' on' : ''}" data-k="${m.k}">${m.l}</button>`).join('');
  $('fSeg').innerHTML = `<option value="ALL">Todos</option>` + SEGS.map(s => `<option${F.seg === s.k ? ' selected' : ''}>${s.k}</option>`).join('');
  $('fCat').innerHTML = `<option value="ALL">Todas</option>` + CATS.map(c => `<option value="${c.k}"${F.cat === c.k ? ' selected' : ''}>${c.k}</option>`).join('');
  $('fTipo').innerHTML = `<option value="ALL">Todos</option>` + TIPOS.map(t => `<option${F.tipo === t ? ' selected' : ''}>${t}</option>`).join('');
  $('fCalif').value = F.calif;
  $('fPer').innerHTML = PERIODOS.map(p => `<button class="chip${F.per === p ? ' on' : ''}" data-p="${p}">${p}</button>`).join('');
  $('fDesde').value = F.desde; $('fHasta').value = F.hasta;
  $('fDesde').min = $('fHasta').min = DATES[0] || ''; $('fDesde').max = $('fHasta').max = DATES[DATES.length - 1] || '';
  const act = [];
  if (F.tramo) act.push(`<button class="chip" data-clear="tramo">Tramo ${F.tramo} d ✕</button>`);
  if (F.seg !== 'ALL') act.push(`<button class="chip" data-clear="seg">${F.seg} ✕</button>`);
  if (F.cat !== 'ALL') act.push(`<button class="chip" data-clear="cat">${F.cat} ✕</button>`);
  if (F.tipo !== 'ALL') act.push(`<button class="chip" data-clear="tipo">${F.tipo} ✕</button>`);
  $('activeF').innerHTML = act.join('');
  $('fPer').parentElement && ($('fPer').style.display = view === 'vivo' ? 'none' : '');
  for (const id of ['fDesde', 'fHasta']) $(id).style.display = view === 'vivo' ? 'none' : '';
  document.querySelectorAll('#filters .sep')[1].style.display = view === 'vivo' ? 'none' : '';
  [...$('filters').querySelectorAll('.fl')].find(e => e.textContent === 'Período').style.display = view === 'vivo' ? 'none' : '';
}

function wireFilters() {
  $('fMon').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { F.mon = b.dataset.k; render(); } };
  $('fSeg').onchange = e => { F.seg = e.target.value; render(); };
  $('fCat').onchange = e => { F.cat = e.target.value; render(); };
  $('fTipo').onchange = e => { F.tipo = e.target.value; render(); };
  $('fCalif').onchange = e => { F.calif = e.target.value; render(); };
  $('fPer').onclick = e => { const b = e.target.closest('[data-p]'); if (b) { setPeriodo(b.dataset.p); render(); } };
  const onDate = () => { const d = $('fDesde').value, h = $('fHasta').value; if (d && h && d <= h) { F.desde = d; F.hasta = h; F.per = 'CUST'; render(); } };
  $('fDesde').onchange = onDate; $('fHasta').onchange = onDate;
  $('activeF').onclick = e => { const b = e.target.closest('[data-clear]'); if (!b) return; const k = b.dataset.clear; F[k] = k === 'tramo' ? null : 'ALL'; render(); };
}

// ── Tooltip / export ──────────────────────────────────────────────────────────
const tip = () => $('tip');
function showTip(e, html) { const t = tip(); t.innerHTML = html; t.style.opacity = 1; const x = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8); const y = Math.min(e.clientY + 14, innerHeight - t.offsetHeight - 8); t.style.left = x + 'px'; t.style.top = y + 'px'; }
function hideTip() { tip().style.opacity = 0; }
function bindTips(root, sel, fn) { root.querySelectorAll(sel).forEach(el => { el.addEventListener('mousemove', e => { const h = fn(el); if (h) showTip(e, h); }); el.addEventListener('mouseleave', hideTip); }); }

function downloadBlob(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function exportTable(id) {
  const t = $(id); if (!t) return;
  const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(c => '"' + c.innerText.replace(/"/g, '""').trim() + '"').join(';'));
  downloadBlob(`monitor-mav_${id}_${F.hasta || 'hoy'}.csv`, new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}
function exportPNG(id) { const c = charts[id]; if (!c) return; const a = document.createElement('a'); a.href = c.toBase64Image('image/png', 1); a.download = `monitor-mav_${id}.png`; a.click(); }
document.addEventListener('click', e => {
  const p = e.target.closest('[data-png]'); if (p) exportPNG(p.dataset.png);
  const c = e.target.closest('[data-csv]'); if (c) exportTable(c.dataset.csv);
});

// ── Chart.js ──────────────────────────────────────────────────────────────────
function chartDefaults() {
  Chart.defaults.color = '#717a86';
  Chart.defaults.borderColor = 'rgba(255,255,255,.06)';
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 11;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation = { duration: 250 };
  Chart.defaults.plugins.legend.display = false;
  Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: '#0b0d11', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, titleColor: '#e9ecef', bodyColor: '#aab2bd', footerColor: '#e9ecef', padding: 10, cornerRadius: 8, titleFont: { family: "'Manrope',sans-serif", weight: '700', size: 12 }, bodyFont: { family: "'JetBrains Mono',monospace", size: 11.5 }, boxPadding: 4, usePointStyle: true });
  Chart.register({ id: 'bg', beforeDraw(c) { const x = c.ctx; x.save(); x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#151920'; x.fillRect(0, 0, c.width, c.height); x.restore(); } });
}
function mkChart(id, cfg) { if (charts[id]) charts[id].destroy(); const el = $(id); if (!el) return null; charts[id] = new Chart(el, cfg); return charts[id]; }
const AX = { grid: { color: 'rgba(255,255,255,.05)' }, border: { display: false } };
const AXX = { grid: { display: false }, border: { color: 'rgba(255,255,255,.12)' } };
const legend = (id, items) => { $(id).innerHTML = items.map(i => `<span><i class="${i.cls || ''}" style="background:${i.c}"></i>${esc(i.l)}</span>`).join(''); };
function spark(id, data, bar) {
  return mkChart(id, { type: bar ? 'bar' : 'line', data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: '#A6E635', backgroundColor: bar ? 'rgba(166,230,53,.55)' : 'rgba(166,230,53,.10)', fill: !bar, borderWidth: 2, pointRadius: 0, tension: .35, borderRadius: 2, barPercentage: .7, spanGaps: true }] }, options: { animation: false, scales: { x: { display: false }, y: { display: false } }, plugins: { tooltip: { enabled: false } }, events: [] } });
}

// Rango Y robusto (p1–p99) para nubes de puntos: los extremos quedan fuera de escala pero listados aparte
function yRange(a) { const v = a.map(o => o.tna).filter(isFinite).sort((x, y) => x - y); if (!v.length) return {}; const lo = v[Math.floor(v.length * .01)], hi = v[Math.min(v.length - 1, Math.floor(v.length * .99))]; return { min: Math.floor(lo - 2), max: Math.ceil(hi + 3) }; }

// Ajuste log ponderado: TNA = a + b·ln(plazo)
function fitLog(a) {
  const p = a.filter(o => o.ppv > 0 && isFinite(o.tna));
  if (p.length < 5) return null;
  let W = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (const o of p) { const w = o.monto, x = Math.log(o.ppv); W += w; Sx += w * x; Sy += w * o.tna; Sxx += w * x * x; Sxy += w * x * o.tna; }
  const den = W * Sxx - Sx * Sx; if (Math.abs(den) < 1e-9) return null;
  const b = (W * Sxy - Sx * Sy) / den, a0 = (Sy - b * Sx) / W;
  const xs = p.map(o => o.ppv).sort((x, y) => x - y);
  return { a: a0, b, f: d => a0 + b * Math.log(d), n: p.length, lo: xs[0], hi: xs[Math.floor(xs.length * .98)] };
}

// ── Carga ─────────────────────────────────────────────────────────────────────
function overlay(msg, err) { $('overlay').classList.toggle('off', !msg); if (msg) $('ovMsg').innerHTML = err ? `<span class="err">${msg}</span><br><br><button class="btn" onclick="location.reload()">Reintentar</button>` : msg; }
async function fetchCSV(gid) {
  const r = await fetch(pubURL(gid), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' al leer el Sheet publicado (gid ' + gid + ')');
  return r.text();
}
async function loadHist() {
  overlay('Cargando histórico…');
  try {
    HIST = toOps(await fetchCSV(GID));
    if (!HIST.length) throw new Error('El histórico no tiene filas.');
    DATES = [...new Set(HIST.map(o => o.date))].sort();
    if (!F.hasta || F.per !== 'CUST') setPeriodo(F.per);
    $('eList').innerHTML = [...new Set(HIST.map(o => o.emp))].sort().map(n => `<option value="${esc(n)}">`).join('');
    overlay(null);
    render();
  } catch (e) { overlay('Error al cargar datos: ' + esc(e.message), true); }
}
async function loadHoy(silent) {
  if (!silent) overlay('Cargando la rueda de hoy…');
  try { HOY = toOps(await fetchCSV(RT_GID)); HOY_AT = new Date(); overlay(null); if (view === 'vivo') renderVivo(); updStamp(); }
  catch (e) { if (!silent) overlay('Error tiempo real: ' + esc(e.message), true); }
}
function updStamp() {
  $('stamp').textContent = view === 'vivo'
    ? (HOY_AT ? 'En vivo · actualizado ' + HOY_AT.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—')
    : (DATES.length ? 'Datos al ' + fmtD(DATES[DATES.length - 1]) : '—');
}

// ── Router ────────────────────────────────────────────────────────────────────
function setView(v) {
  view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  clearInterval(rtTimer); rtTimer = null;
  if (v === 'vivo') { if (!HOY.length) loadHoy(); rtTimer = setInterval(() => loadHoy(true), RT_REFRESH_MS); }
  render();
}
function render() {
  if (!HIST.length) return;
  buildFilters(); updStamp();
  if (view === 'mercado') renderMercado();
  else if (view === 'vivo') renderVivo();
  else if (view === 'emisores') renderEmisores();
  else if (view === 'curvas') renderCurvas();
}

// ══════════════════════════════════════════════════════════════════════════════
// MERCADO
// ══════════════════════════════════════════════════════════════════════════════
function dailySeries(base) {
  const by = groupBy(base, o => o.date), out = new Map();
  for (const d of DATES) {
    const a = by.get(d) || [];
    const ng = a.filter(o => o.seg === 'No Garantizado'), av = a.filter(o => o.seg === 'Avalado');
    out.set(d, { tna: wavg(a), monto: sum(a), ops: a.length, ppv: wavg(a, 'ppv'), sp: (wavg(ng) - wavg(av)) * 100 });
  }
  return out;
}
function renderMercado() {
  const base = rated(HIST.filter(o => passBase(o)));
  const P = base.filter(inPer);
  // KPIs
  const D = dailySeries(base), idx = DATES.indexOf(F.hasta), from = Math.max(0, Math.min(DATES.indexOf(F.desde), idx - 19));
  const days = DATES.slice(from, idx + 1), prev = DATES[idx - 1];
  const last = D.get(F.hasta) || {}, pv = prev ? D.get(prev) : null;
  const dlt = (k, f) => (pv && isFinite(last[k]) && isFinite(pv[k])) ? f(last[k] - pv[k], pv[k]) : '';
  const arrow = (v, unit, d = 0, col = true) => { const r = +v.toFixed(d); return `<span class="${col ? (r > 0 ? 'up' : r < 0 ? 'dn' : '') : ''}">${r > 0 ? '▲' : r < 0 ? '▼' : '='} ${fmtN(Math.abs(r), d)}${unit}</span> d/d`; };
  const ng = P.filter(o => o.seg === 'No Garantizado'), av = P.filter(o => o.seg === 'Avalado');
  const K = [
    { id: 'tna', l: 'TNA ponderada', v: fmtN(wavg(P), 2) + '<small>%</small>', d: dlt('tna', x => arrow(x * 100, ' pb')), hero: 1 },
    { id: 'monto', l: 'Monto negociado', v: fmtMonto(sum(P)).replace(/ (MM|M|mil)$/, '<small>$1</small>'), d: dlt('monto', (x, b) => arrow(x / b * 100, '%', 1, false)) },
    { id: 'ops', l: 'Operaciones', v: fmtN(P.length), d: dlt('ops', x => arrow(x, '', 0, false)), bar: 1 },
    { id: 'ppv', l: 'Plazo prom. pond.', v: fmtN(wavg(P, 'ppv'), 0) + '<small>días</small>', d: dlt('ppv', x => arrow(x, ' d', 0, false)) },
    { id: 'sp', l: 'Spread NG − Avalado', v: (ng.length && av.length) ? ((wavg(ng) - wavg(av)) >= 0 ? '+' : '') + fmtN((wavg(ng) - wavg(av)) * 100, 0) + '<small>pb</small>' : '—', d: dlt('sp', x => arrow(x, ' pb')) },
  ];
  $('mKpis').innerHTML = K.map(k => `<div class="kpi${k.hero ? ' hero' : ''}"><div class="kl">${k.l}</div><div class="kv">${k.v}</div><div class="kd">${k.d || (F.desde === F.hasta ? fmtD(F.hasta) : fmtDs(F.desde) + ' → ' + fmtDs(F.hasta))}</div><div class="spark"><canvas id="mk_${k.id}"></canvas></div></div>`).join('');
  K.forEach(k => spark('mk_' + k.id, days.map(d => D.get(d)[k.id]), k.bar));

  // Curva por tramo
  const band = TRAMOS.map(t => { const a = P.filter(o => o.tramo === t); return a.length >= 3 ? [wq(a, .25), wq(a, .75)] : [null, null]; });
  legend('mCurveLeg', [...SEGS.map(s => ({ l: s.k, c: s.c, cls: 'ln' })), { l: 'Rango p25–p75 del mercado', c: 'rgba(255,255,255,.12)', cls: 'band' }]);
  mkChart('mCurve', {
    type: 'line',
    data: { labels: TRAMOS.map(t => t + ' d'), datasets: [
      { label: 'p25', data: band.map(b => b[0]), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: true },
      { label: 'p75', data: band.map(b => b[1]), borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(255,255,255,.07)', fill: '-1', spanGaps: true },
      ...SEGS.map(s => ({ label: s.k, data: TRAMOS.map(t => { const a = P.filter(o => o.seg === s.k && o.tramo === t); return a.length ? wavg(a) : null; }), borderColor: s.c, backgroundColor: s.c, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: '#151920', pointBorderWidth: 2, tension: .3, spanGaps: true })),
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els, c) => { const i = c.scales.x.getValueForPixel(e.x); if (i >= 0 && i < TRAMOS.length) { F.tramo = F.tramo === TRAMOS[i] ? null : TRAMOS[i]; render(); } },
      scales: { y: { ...AX, ticks: { callback: v => v + '%' } }, x: AXX },
      plugins: { tooltip: { filter: i => i.datasetIndex > 1 && i.parsed.y != null, callbacks: {
        title: i => 'Tramo ' + i[0].label, label: i => ` ${i.dataset.label}: ${fmtN(i.parsed.y, 2)}%`,
        afterBody: i => { const b = band[i[0].dataIndex]; return b[0] == null ? '' : `\nMercado p25–p75: ${fmtN(b[0], 1)}–${fmtN(b[1], 1)}%`; } } } },
    },
  });

  // Composición
  const compBlock = (title, total, parts, unit, key) => {
    const T = parts.reduce((s, p) => s + p.v, 0) || 1;
    return `<div><div class="cl"><span>${title}</span><b>${total}</b></div>
      <div class="bar100">${parts.map(p => { const pc = p.v / T * 100; return `<div style="flex:${p.v};background:${p.c}" data-f="${key}" data-k="${esc(p.k)}" data-t="${esc(p.n)}" data-v="${esc(unit(p.v))}" data-p="${fmtN(pc, 1)}">${pc >= p.n.length * 1.15 ? esc(p.n) : ''}</div>`; }).join('')}</div>
      <div class="clg">${parts.map(p => `<span><i style="background:${p.c}"></i>${esc(p.n)} ${fmtN(p.v / T * 100, 1)}%</span>`).join('')}</div></div>`;
  };
  const M = sum(P);
  const segP = SEGS.map(s => ({ k: s.k, n: s.k, v: sum(P.filter(o => o.seg === s.k)), c: s.c })).filter(p => p.v > 0);
  const catP = CATS.map(c => ({ k: c.k, n: c.s, v: sum(P.filter(o => o.cat === c.k)), c: c.c })).filter(p => p.v > 0);
  const tipC = ['#6ea514', '#3987e5', '#d55181', '#c98500'];
  const tipP = TIPOS.map((t, i) => ({ k: t, n: t, v: sum(P.filter(o => o.tipo === t)), c: tipC[i] })).filter(p => p.v > 0);
  const monAll = HIST.filter(o => passBase(o, { mon: 1 }) && inPer(o));
  const monC = ['#6ea514', '#3987e5', '#d55181', '#c98500'];
  const monP = MONEDAS.map((m, i) => ({ k: m.k, n: m.l, v: monAll.filter(o => o.mon === m.k).length, c: monC[i] })).filter(p => p.v > 0);
  $('mComp').innerHTML = P.length ? (
    compBlock('Segmento · monto', fmtMonto(M), segP, fmtMonto, 'seg') +
    compBlock('Categoría de riesgo · monto', fmtMonto(M), catP, fmtMonto, 'cat') +
    compBlock('Instrumento · monto', fmtMonto(M), tipP, fmtMonto, 'tipo') +
    compBlock('Moneda · operaciones', fmtN(monAll.length) + ' ops', monP, v => fmtN(v) + ' ops', 'mon')) : '<div class="empty">Sin operaciones con estos filtros.</div>';
  bindTips($('mComp'), '.bar100 div', el => `${el.dataset.t}<br><b>${el.dataset.v}</b> · ${el.dataset.p}%<br><span style="color:var(--muted)">clic para filtrar</span>`);
  $('mComp').onclick = e => { const d = e.target.closest('[data-f]'); if (!d) return; const k = d.dataset.f; F[k] = (k !== 'mon' && F[k] === d.dataset.k) ? 'ALL' : d.dataset.k; hideTip(); render(); };

  renderHeatmap(P);

  // Volumen por tramo
  legend('mVolLeg', SEGS.map(s => ({ l: s.k, c: s.c })));
  mkChart('mVol', {
    type: 'bar',
    data: { labels: TRAMOS.map(t => t + ' d'), datasets: SEGS.map(s => ({ label: s.k, data: TRAMOS.map(t => sum(P.filter(o => o.seg === s.k && o.tramo === t)) / 1e6), backgroundColor: s.c, borderColor: '#151920', borderWidth: { top: 2 }, borderSkipped: false, borderRadius: 3, barPercentage: .72, categoryPercentage: .8 })) },
    options: {
      interaction: { mode: 'index', intersect: false },
      onClick: (e, els) => { if (els.length) { const t = TRAMOS[els[0].index]; F.tramo = F.tramo === t ? null : t; render(); } },
      scales: { x: { ...AXX, stacked: true }, y: { ...AX, stacked: true, ticks: { callback: v => fmtN(v) } } },
      plugins: { tooltip: { itemSort: (a, b) => b.datasetIndex - a.datasetIndex, callbacks: {
        title: i => { const t = TRAMOS[i[0].dataIndex], a = P.filter(o => o.tramo === t); return `Tramo ${t} d · ${a.length} ops · TNA ${fmtN(wavg(a), 2)}%`; },
        label: i => ` ${i.dataset.label}: ${curSym()}${fmtN(i.parsed.y)} M`,
        footer: i => { const tot = i.reduce((s, x) => s + x.parsed.y, 0); return `Total ${curSym()}${fmtN(tot)} M · ${fmtN(M ? tot * 1e6 / M * 100 : 0, 1)}% del volumen`; } } } },
    },
  });

  // Ranking
  const mkt = wavg(P);
  const catMain = a => [...groupBy(a, o => o.cat).entries()].map(([k, b]) => [k, sum(b)]).sort((x, y) => y[1] - x[1])[0]?.[0];
  const top = [...groupBy(P, o => o.emp).entries()].map(([n, a]) => ({ n, cat: catMain(a), m: sum(a), t: wavg(a), ops: a.length })).sort((x, y) => y.m - x.m).slice(0, 15);
  if (!top.length) $('mRank').innerHTML = '<div class="empty" style="grid-column:1/-1">Sin operaciones.</div>';
  else {
    const maxM = top[0].m, ts = top.map(x => x.t).concat(mkt), tLo = Math.floor(Math.min(...ts) - 1), tHi = Math.ceil(Math.max(...ts) + 1);
    const pos = v => Math.max(0, Math.min(100, (v - tLo) / (tHi - tLo) * 100));
    let h = `<div class="h">#</div><div class="h">Responsable</div><div class="h c-cat">Categoría</div><div class="h">Monto</div><div class="h" style="display:flex;justify-content:space-between"><span>TNA</span><span style="font-family:var(--mono);font-weight:500">${tLo}%–${tHi}%</span></div>`;
    top.forEach((x, i) => {
      const w = x.m / maxM * 62, cls = x.t > mkt + 2 ? 'hi' : (x.t < mkt - 2 ? 'lo' : '');
      h += `<div class="cell n">${i + 1}</div><div class="cell"><span class="nm" data-emp="${esc(x.n)}" title="${esc(x.n)}">${esc(x.n)}</span></div><div class="cell c-cat"><span class="cat"><i style="background:${CAT_C[x.cat] || '#717a86'}"></i>${esc(CAT_S[x.cat] || x.cat || '—')}</span></div>
        <div class="cell"><div class="bw"><div style="width:${w}%"></div><span style="left:calc(${w}% + 6px)">${fmtMonto(x.m)}</span></div></div>
        <div class="cell"><div class="tw" data-i="${i}"><div class="ax"></div><div class="mk" style="left:${pos(mkt)}%"></div><div class="dt ${cls}" style="left:${pos(x.t)}%"></div></div></div>`;
    });
    $('mRank').innerHTML = h;
    bindTips($('mRank'), '.tw', el => { const x = top[el.dataset.i]; return `${esc(x.n)}<br>TNA <b>${fmtN(x.t, 2)}%</b> · mercado ${fmtN(mkt, 2)}%<br>spread <b>${(x.t - mkt >= 0 ? '+' : '') + fmtN((x.t - mkt) * 100, 0)} pb</b> · ${x.ops} ops`; });
    $('mRank').onclick = e => { const n = e.target.closest('[data-emp]'); if (n) { EMP.main = n.dataset.emp; EMP.cmp = []; setView('emisores'); } };
  }

  // Tabla por categoría
  const rows = CATS.map(c => { const a = P.filter(o => o.cat === c.k); const t = wavg(a), p = wavg(a, 'ppv'); return { c, n: a.length, m: sum(a), p, t, e: tea(t, p) }; }).filter(r => r.n);
  const T = { n: P.length, m: M, p: wavg(P, 'ppv'), t: wavg(P) }; T.e = tea(T.t, T.p);
  $('mTbl').innerHTML = `<thead><tr><th class="l">Categoría</th><th>Ops</th><th>Monto</th><th>Plazo</th><th>TNA</th><th>TEA</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td class="l nm"><span class="sw" style="background:${r.c.c}"></span>${r.c.k}</td><td>${fmtN(r.n)}</td><td>${fmtMonto(r.m)}</td><td>${fmtN(r.p, 0)} d</td><td>${fmtN(r.t, 2)}%</td><td>${fmtN(r.e, 2)}%</td></tr>`).join('') +
    `<tr class="tot"><td class="l nm">Total</td><td>${fmtN(T.n)}</td><td>${fmtMonto(T.m)}</td><td>${fmtN(T.p, 0)} d</td><td>${fmtN(T.t, 2)}%</td><td>${fmtN(T.e, 2)}%</td></tr></tbody>`;
}

function renderHeatmap(P) {
  document.querySelectorAll('#mHmMode button').forEach(b => b.classList.toggle('on', b.dataset.m === hmMode));
  const el = $('mHm');
  let cols, colKey, colLbl;
  if (hmMode === 'cat') { cols = CATS.map(c => c.k); colKey = o => o.cat; colLbl = k => CAT_S[k]; $('mHmTitle').textContent = 'Mapa de tasas · tramo × categoría de riesgo'; }
  else { cols = [...new Set(P.map(o => o.date))].sort().slice(-30); colKey = o => o.date; colLbl = fmtDs; $('mHmTitle').textContent = 'Mapa de tasas · tramo × día'; }
  const g = groupBy(P, o => o.tramo + '|' + colKey(o));
  const cells = TRAMOS.map(t => cols.map(c => { const a = g.get(t + '|' + c); return a && a.length ? { v: wavg(a), n: a.length, m: sum(a) } : null; }));
  const vals = cells.flat().filter(Boolean).map(c => c.v);
  if (!vals.length) { el.innerHTML = '<div class="empty">Sin operaciones.</div>'; el.style.gridTemplateColumns = '1fr'; return; }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = v => Math.min(RAMP.length - 1, Math.floor((v - lo) / (hi - lo + 1e-9) * RAMP.length));
  el.className = 'hm' + (hmMode === 'dia' ? ' days' : '');
  el.style.gridTemplateColumns = `76px repeat(${cols.length}, minmax(${hmMode === 'dia' ? 38 : 60}px, 1fr))`;
  let h = '<div></div>' + cols.map(c => `<div class="hd">${esc(colLbl(c))}</div>`).join('');
  TRAMOS.forEach((t, i) => {
    h += `<div class="rl">${t} d</div>`;
    cells[i].forEach((c, j) => {
      if (!c) { h += '<div class="c na"></div>'; return; }
      const s = step(c.v);
      h += `<div class="c${c.n < 3 ? ' thin' : ''}" data-i="${i}" data-j="${j}" style="background:${RAMP[s]};color:${s >= 4 ? '#0d0f13' : '#e9ecef'}">${fmtN(c.v, 1)}${hmMode === 'cat' ? `<span>n=${c.n}</span>` : ''}</div>`;
    });
  });
  el.innerHTML = h;
  bindTips(el, '.c[data-i]', d => { const c = cells[d.dataset.i][d.dataset.j]; return `${esc(colLbl(cols[d.dataset.j]))} · tramo <b>${TRAMOS[d.dataset.i]} d</b><br>TNA <b>${fmtN(c.v, 2)}%</b><br>${c.n} ops · ${fmtMonto(c.m)}`; });
  el.onclick = e => {
    const d = e.target.closest('.c[data-i]'); if (!d) return; hideTip();
    if (hmMode === 'cat') { F.tramo = TRAMOS[d.dataset.i]; F.cat = cols[d.dataset.j]; }
    else { F.desde = F.hasta = cols[d.dataset.j]; F.per = 'CUST'; }
    render();
  };
  $('mHmLo').textContent = fmtN(lo, 1) + '%'; $('mHmHi').textContent = fmtN(hi, 1) + '%';
  $('mHmGrad').style.background = `linear-gradient(90deg,${RAMP.join(',')})`;
}

// ══════════════════════════════════════════════════════════════════════════════
// EN VIVO
// ══════════════════════════════════════════════════════════════════════════════
function renderVivo() {
  if (!HOY.length) { $('vKpis').innerHTML = ''; $('vTicker').innerHTML = '<span class="cs">Sin datos de hoy todavía. La rueda se actualiza cada 5 minutos entre las 10:30 y las 17:30.</span>'; return; }
  const all = HOY.filter(o => passBase(o));
  const neg = rated(all.filter(o => o.estado === 'Negociada'));
  const act = all.filter(o => o.estado === 'Activa');
  const today = HOY[0].date;
  const ayerD = [...DATES].reverse().find(d => d < today);
  const ayer = ayerD ? rated(HIST.filter(o => o.date === ayerD && passBase(o))) : [];
  const hr = o => parseInt((o.hconc || o.tmin || '0').slice(0, 2), 10);
  const HRS = [10, 11, 12, 13, 14, 15, 16, 17];

  // Ticker
  const lastOps = [...neg].sort((a, b) => (b.hconc || '').localeCompare(a.hconc || '')).slice(0, 24);
  $('vTicker').innerHTML = lastOps.length ? lastOps.map(o => `<div class="tk"><span class="h">${esc((o.hconc || '').slice(0, 5))}</span><i style="background:${SEG_C[o.seg] || '#717a86'}"></i>${esc(o.emp.length > 26 ? o.emp.slice(0, 25) + '…' : o.emp)} <b>${fmtN(o.tna, 2)}%</b><span class="h">${o.ppv}d · ${fmtMonto(o.monto)}</span></div>`).join('') : '<span class="cs">Todavía no hay operaciones negociadas hoy.</span>';

  // KPIs
  const cum = HRS.map(h => neg.filter(o => hr(o) <= h));
  const d = (v, b, f) => (isFinite(v) && isFinite(b)) ? f(v - b, b) : 'sin dato de ayer';
  const ar = (v, unit, dd = 0, col = true) => { const r = +v.toFixed(dd); return `<span class="${col ? (r > 0 ? 'up' : r < 0 ? 'dn' : '') : ''}">${r > 0 ? '▲' : r < 0 ? '▼' : '='} ${fmtN(Math.abs(r), dd)}${unit}</span> vs ayer`; };
  const lastOp = lastOps[0];
  const K = [
    { id: 'tna', l: 'TNA ponderada hoy', v: fmtN(wavg(neg), 2) + '<small>%</small>', d: d(wavg(neg), wavg(ayer), x => ar(x * 100, ' pb')), s: cum.map(a => wavg(a)), hero: 1 },
    { id: 'monto', l: 'Monto negociado', v: fmtMonto(sum(neg)).replace(/ (MM|M|mil)$/, '<small>$1</small>'), d: ayer.length ? `ayer ${fmtMonto(sum(ayer))}` : '', s: cum.map(a => sum(a)) },
    { id: 'ops', l: 'Negociadas', v: fmtN(neg.length), d: `${fmtN(act.length)} activas ahora`, s: HRS.map(h => neg.filter(o => hr(o) === h).length), bar: 1 },
    { id: 'ppv', l: 'Plazo prom. pond.', v: fmtN(wavg(neg, 'ppv'), 0) + '<small>días</small>', d: d(wavg(neg, 'ppv'), wavg(ayer, 'ppv'), x => ar(x, ' d', 0, false)), s: cum.map(a => wavg(a, 'ppv')) },
    { id: 'last', l: 'Última operación', v: lastOp ? esc(lastOp.hconc.slice(0, 5)) : '—', d: lastOp ? `${esc(lastOp.emp.slice(0, 22))} · ${fmtN(lastOp.tna, 2)}%` : '', s: HRS.map(h => sum(neg.filter(o => hr(o) === h))), bar: 1 },
  ];
  $('vKpis').innerHTML = K.map(k => `<div class="kpi${k.hero ? ' hero' : ''}"><div class="kl">${k.l}</div><div class="kv">${k.v}</div><div class="kd">${k.d}</div><div class="spark"><canvas id="vk_${k.id}"></canvas></div></div>`).join('');
  K.forEach(k => spark('vk_' + k.id, k.s, k.bar));

  // Curva en vivo vs ayer
  const fits = Object.fromEntries(SEGS.map(s => [s.k, fitLog(ayer.filter(o => o.seg === s.k))]));
  const fitAll = fitLog(ayer);
  const ref = o => (fits[o.seg] || fitAll)?.f(o.ppv);
  neg.forEach(o => { const r = ref(o); o._dev = isFinite(r) ? o.tna - r : NaN; });
  const xs = neg.map(o => o.ppv).sort((a, b) => a - b), xMax = Math.max(60, xs.length ? xs[Math.floor(xs.length * .98)] * 1.1 : 200);
  const maxM = Math.max(1, ...neg.map(o => o.monto));
  const rad = m => 3 + 9 * Math.sqrt(m / maxM);
  const dsPts = SEGS.map(s => { const a = neg.filter(o => o.seg === s.k && o.ppv <= xMax); return { label: s.k, data: a.map(o => ({ x: o.ppv, y: o.tna, o })), backgroundColor: s.c + 'cc', borderColor: a.map(o => Math.abs(o._dev) > 3 ? '#e9ecef' : '#151920'), borderWidth: a.map(o => Math.abs(o._dev) > 3 ? 2 : 1), pointRadius: a.map(o => rad(o.monto)), pointHoverRadius: a.map(o => rad(o.monto) + 2) }; });
  const dsFit = SEGS.filter(s => fits[s.k]).map(s => { const f = fits[s.k]; const pts = []; for (let x = Math.max(1, f.lo); x <= Math.min(xMax, f.hi * 1.2); x += Math.max(1, xMax / 60)) pts.push({ x, y: f.f(x) }); return { type: 'line', label: s.k + ' (ayer)', data: pts, borderColor: s.c, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: 0 }; });
  legend('vCurveLeg', [...SEGS.map(s => ({ l: s.k, c: s.c, cls: 'cir' })), { l: ayerD ? `curva ajustada ${fmtD(ayerD)}` : 'sin curva de ayer', c: 'transparent', cls: 'dash' }]);
  mkChart('vCurve', {
    type: 'scatter', data: { datasets: [...dsFit, ...dsPts] },
    options: {
      scales: { x: { ...AXX, min: 0, max: Math.ceil(xMax / 30) * 30, title: { display: true, text: 'plazo (días)' } }, y: { ...AX, ...yRange(neg), ticks: { callback: v => v + '%' } } },
      plugins: { tooltip: { filter: i => i.raw && i.raw.o, callbacks: { title: i => i[0].raw.o.emp, label: i => { const o = i.raw.o; return [` ${o.seg} · ${o.tipo} · ${o.ppv} d`, ` TNA ${fmtN(o.tna, 2)}% · ${fmtMonto(o.monto)}`, isFinite(o._dev) ? ` vs curva de ayer: ${o._dev >= 0 ? '+' : ''}${fmtN(o._dev * 100, 0)} pb` : '']; } } } },
    },
  });
  const outs = neg.filter(o => Math.abs(o._dev) > 3).sort((a, b) => Math.abs(b._dev) - Math.abs(a._dev));
  $('vOut').innerHTML = outs.length ? `<thead><tr><th class="l">Responsable</th><th>Plazo</th><th>TNA</th><th>Desvío</th></tr></thead><tbody>` + outs.map(o => `<tr><td class="l nm" title="${esc(o.emp)}"><span class="sw" style="background:${SEG_C[o.seg]}"></span>${esc(o.emp)}</td><td>${o.ppv} d</td><td>${fmtN(o.tna, 2)}%</td><td style="color:${o._dev > 0 ? 'var(--up)' : 'var(--down)'}">${o._dev > 0 ? '+' : ''}${fmtN(o._dev * 100, 0)} pb</td></tr>`).join('') + '</tbody>'
    : `<tbody><tr><td class="l" style="color:var(--muted);font-family:var(--sans)">${ayerD ? 'Ninguna operación se aleja más de 3 pp de la curva de ayer.' : 'No hay curva del día anterior para comparar.'}</td></tr></tbody>`;

  // Intradía
  mkChart('vAcum', { type: 'line', data: { labels: HRS.map(h => h + 'h'), datasets: [{ label: 'Monto acumulado', data: cum.map(a => sum(a) / 1e6), borderColor: '#A6E635', backgroundColor: 'rgba(166,230,53,.12)', fill: true, borderWidth: 2, pointRadius: 3, tension: .3 }] },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: AXX, y: { ...AX, ticks: { callback: v => fmtN(v) } } }, plugins: { tooltip: { callbacks: { label: i => ` ${curSym()}${fmtN(i.parsed.y)} M · ${cum[i.dataIndex].length} ops` } } } } });
  legend('vTnaLeg', SEGS.map(s => ({ l: s.k, c: s.c, cls: 'ln' })));
  mkChart('vTna', { type: 'line', data: { labels: HRS.map(h => h + 'h'), datasets: SEGS.map(s => ({ label: s.k, data: cum.map(a => { const b = a.filter(o => o.seg === s.k); return b.length ? wavg(b) : null; }), borderColor: s.c, backgroundColor: s.c, borderWidth: 2, pointRadius: 3, tension: .3, spanGaps: true })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: AXX, y: { ...AX, ticks: { callback: v => v + '%' } } }, plugins: { tooltip: { callbacks: { label: i => ` ${i.dataset.label}: ${fmtN(i.parsed.y, 2)}%` } } } } });

  renderVivoTable(all);
}
function renderVivoTable(all) {
  document.querySelectorAll('#vEst button').forEach(b => b.classList.toggle('on', b.dataset.e === vEst));
  const q = vSearch.toLowerCase();
  const a = all.filter(o => (vEst === 'ALL' || o.estado === vEst) && (!q || o.emp.toLowerCase().includes(q) || o.cuit.includes(q)))
    .sort((x, y) => (y.tmin || '').localeCompare(x.tmin || ''));
  $('vOps').innerHTML = `<thead><tr><th class="l">Inicio</th><th class="l">Estado</th><th class="l">Responsable</th><th class="l">Categoría</th><th class="l">Instr.</th><th>Plazo</th><th>TNA</th><th>Monto</th><th>Concertación</th></tr></thead><tbody>` +
    (a.length ? a.slice(0, 400).map(o => `<tr><td class="l">${esc(o.tmin.slice(0, 5))}</td><td class="l"><span class="st ${o.estado === 'Negociada' ? 'neg' : 'act'}">${esc(o.estado)}</span></td><td class="l nm" title="${esc(o.emp)}">${esc(o.emp)}</td><td class="l"><span class="cat"><i style="background:${CAT_C[o.cat] || '#717a86'}"></i>${esc(CAT_S[o.cat] || o.cat)}</span></td><td class="l">${esc(o.tipo)}</td><td>${o.ppv} d</td><td>${isFinite(o.tna) ? fmtN(o.tna, 2) + '%' : '—'}</td><td>${fmtMonto(o.monto)}</td><td>${esc((o.hconc || '').slice(0, 5)) || '—'}</td></tr>`).join('')
      : `<tr><td class="l" colspan="9" style="color:var(--muted)">Sin subastas con estos filtros.</td></tr>`) + '</tbody>';
}

// ══════════════════════════════════════════════════════════════════════════════
// EMISORES
// ══════════════════════════════════════════════════════════════════════════════
function renderEmisores() {
  $('eMain').value = EMP.main || '';
  $('eCmp').innerHTML = EMP.cmp.map((n, i) => `<button class="chip" data-rm="${i}"><i style="background:${ENT_C[i + 1]}"></i>${esc(n.length > 30 ? n.slice(0, 29) + '…' : n)} <b>✕</b></button>`).join('');
  if (!EMP.main) { $('eBody').innerHTML = '<div class="card empty">Elegí un responsable para ver su perfil, o hacé clic en uno del ranking de Mercado.</div>'; return; }
  const per = HIST.filter(o => o.mon === F.mon && inPer(o) && (F.calif === 'ALL' || o.calif === F.calif));
  const mktR = rated(per);
  const refMap = new Map([...groupBy(mktR, o => o.tramo + '|' + o.seg).entries()].map(([k, a]) => [k, wavg(a)]));
  const ents = [EMP.main, ...EMP.cmp].map((n, i) => {
    const a = per.filter(o => o.emp === n), r = rated(a);
    const spr = r.length ? r.reduce((s, o) => s + (o.tna - (refMap.get(o.tramo + '|' + o.seg) ?? o.tna)) * o.monto, 0) / sum(r) * 100 : NaN;
    const cat = [...groupBy(a, o => o.cat).entries()].map(([k, b]) => [k, sum(b)]).sort((x, y) => y[1] - x[1])[0]?.[0];
    return { n, c: ENT_C[i], a, r, m: sum(a), t: wavg(r), p: wavg(r, 'ppv'), spr, cat, cuit: a[0]?.cuit };
  });
  const E = ents[0];
  if (!E.a.length) { $('eBody').innerHTML = `<div class="card empty">${esc(EMP.main)} no tiene operaciones en ${MONEDAS.find(m => m.k === F.mon).l} entre ${fmtD(F.desde)} y ${fmtD(F.hasta)}. Probá ampliar el período o cambiar la moneda.</div>`; return; }

  $('eBody').innerHTML = `
    <div class="kpis" id="eKpis"></div>
    <div class="row r-66">
      <div class="card"><div class="ch"><div class="ct">TNA por tramo vs. mercado</div><div class="tools"><span class="cs">mismo período y moneda</span><button class="ico" data-png="eCurve">PNG</button></div></div><div class="leg" id="eCurveLeg"></div><div class="chart"><canvas id="eCurve"></canvas></div></div>
      <div class="card"><div class="ch"><div class="ct">Spread vs. mercado por tramo</div><div class="tools"><span class="cs">pb · mismo tramo y segmento</span><button class="ico" data-png="eSpread">PNG</button></div></div><div class="leg" id="eSpreadLeg"></div><div class="chart"><canvas id="eSpread"></canvas></div></div>
    </div>
    <div class="row r-333">
      <div class="card"><div class="ch"><div class="ct">Vencimientos por mes</div><span class="cs">estimado: fecha + plazo</span></div><div class="chart" style="height:220px"><canvas id="eVenc"></canvas></div></div>
      <div class="card"><div class="ch"><div class="ct">Composición</div><span class="cs">${esc(E.n.slice(0, 28))}</span></div><div class="comp" id="eComp"></div></div>
      <div class="card"><div class="ch"><div class="ct">Agentes compradores</div><span class="cs">por monto</span></div><div id="eAg"></div></div>
    </div>
    ${ents.length > 1 ? `<div class="row r-1"><div class="card"><div class="ch"><div class="ct">Comparación</div><button class="ico" data-csv="eCmpTbl">CSV</button></div><div class="tbl-wrap"><table id="eCmpTbl"></table></div></div></div>` : ''}
    <div class="row r-1"><div class="card"><div class="ch"><div class="ct">Detalle de operaciones · ${esc(E.n)}</div><button class="ico" data-csv="eOps">CSV</button></div><div class="tbl-wrap"><table id="eOps"></table></div></div></div>`;

  const K = [
    { l: 'Monto', v: fmtMonto(E.m), d: `${fmtN(E.a.length)} ops · ${esc(CAT_S[E.cat] || E.cat || '')}`, hero: 1 },
    { l: 'TNA ponderada', v: fmtN(E.t, 2) + '<small>%</small>', d: `mercado ${fmtN(wavg(mktR), 2)}%` },
    { l: 'Spread vs. mercado', v: isFinite(E.spr) ? (E.spr >= 0 ? '+' : '') + fmtN(E.spr, 0) + '<small>pb</small>' : '—', d: 'mismo tramo y segmento' },
    { l: 'Plazo prom. pond.', v: fmtN(E.p, 0) + '<small>días</small>', d: `mercado ${fmtN(wavg(mktR, 'ppv'), 0)} d` },
    { l: 'CUIT', v: `<span style="font-size:18px">${esc(E.cuit || '—')}</span>`, d: `${fmtD(F.desde)} → ${fmtD(F.hasta)}` },
  ];
  $('eKpis').innerHTML = K.map(k => `<div class="kpi${k.hero ? ' hero' : ''}"><div class="kl">${k.l}</div><div class="kv">${k.v}</div><div class="kd">${k.d}</div></div>`).join('');

  legend('eCurveLeg', [{ l: 'Mercado', c: 'transparent', cls: 'dash' }, ...ents.map(e => ({ l: e.n, c: e.c, cls: 'ln' }))]);
  mkChart('eCurve', { type: 'line', data: { labels: TRAMOS.map(t => t + ' d'), datasets: [
    { label: 'Mercado', data: TRAMOS.map(t => { const a = mktR.filter(o => o.tramo === t); return a.length ? wavg(a) : null; }), borderColor: '#aab2bd', borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true },
    ...ents.map(e => ({ label: e.n, data: TRAMOS.map(t => { const a = e.r.filter(o => o.tramo === t); return a.length ? wavg(a) : null; }), borderColor: e.c, backgroundColor: e.c, borderWidth: 2, pointRadius: 4, pointBorderColor: '#151920', pointBorderWidth: 2, tension: .3, spanGaps: true })),
  ] }, options: { interaction: { mode: 'index', intersect: false }, scales: { x: AXX, y: { ...AX, ticks: { callback: v => v + '%' } } }, plugins: { tooltip: { filter: i => i.parsed.y != null, callbacks: { label: i => ` ${i.dataset.label.slice(0, 30)}: ${fmtN(i.parsed.y, 2)}%` } } } } });

  legend('eSpreadLeg', ents.map(e => ({ l: e.n, c: e.c })));
  mkChart('eSpread', { type: 'bar', data: { labels: TRAMOS.map(t => t + ' d'), datasets: ents.map(e => ({ label: e.n, data: TRAMOS.map(t => { const a = e.r.filter(o => o.tramo === t); if (!a.length) return null; return a.reduce((s, o) => s + (o.tna - (refMap.get(o.tramo + '|' + o.seg) ?? o.tna)) * o.monto, 0) / sum(a) * 100; }), backgroundColor: e.c, borderRadius: 3, barPercentage: .8, categoryPercentage: .7 })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: AXX, y: { ...AX, ticks: { callback: v => (v > 0 ? '+' : '') + v }, grid: { color: c => c.tick.value === 0 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.05)' } } }, plugins: { tooltip: { filter: i => i.parsed.y != null, callbacks: { label: i => ` ${i.dataset.label.slice(0, 30)}: ${i.parsed.y >= 0 ? '+' : ''}${fmtN(i.parsed.y, 0)} pb` } } } } });

  // Vencimientos (principal)
  const venc = new Map();
  E.a.forEach(o => { if (!(o.ppv > 0)) return; const k = isoAdd(o.date, o.ppv).slice(0, 7); venc.set(k, (venc.get(k) || 0) + o.monto); });
  const vk = [...venc.keys()].sort();
  const mNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  mkChart('eVenc', { type: 'bar', data: { labels: vk.map(k => mNames[+k.slice(5) - 1] + ' ' + k.slice(2, 4)), datasets: [{ data: vk.map(k => venc.get(k) / 1e6), backgroundColor: '#A6E635', borderRadius: 3, barPercentage: .7 }] },
    options: { scales: { x: AXX, y: { ...AX, ticks: { callback: v => fmtN(v) } } }, plugins: { tooltip: { callbacks: { label: i => ` ${curSym()}${fmtN(i.parsed.y, 1)} M` } } } } });

  // Composición principal
  const blk = (title, parts) => { const T = parts.reduce((s, p) => s + p.v, 0) || 1; return `<div><div class="cl"><span>${title}</span></div><div class="bar100">${parts.map(p => `<div style="flex:${p.v};background:${p.c}">${p.v / T * 100 >= p.n.length * 1.15 ? esc(p.n) : ''}</div>`).join('')}</div><div class="clg">${parts.map(p => `<span><i style="background:${p.c}"></i>${esc(p.n)} ${fmtN(p.v / T * 100, 1)}%</span>`).join('')}</div></div>`; };
  $('eComp').innerHTML = blk('Segmento · monto', SEGS.map(s => ({ n: s.k, v: sum(E.a.filter(o => o.seg === s.k)), c: s.c })).filter(p => p.v)) +
    blk('Instrumento · monto', TIPOS.map((t, i) => ({ n: t, v: sum(E.a.filter(o => o.tipo === t)), c: ['#6ea514', '#3987e5', '#d55181', '#c98500'][i] })).filter(p => p.v)) +
    blk('Tramo · monto', [{ n: '≤ 90 d', v: sum(E.a.filter(o => o.ppv <= 90)), c: '#6ea514' }, { n: '91–180 d', v: sum(E.a.filter(o => o.ppv > 90 && o.ppv <= 180)), c: '#3987e5' }, { n: '> 180 d', v: sum(E.a.filter(o => o.ppv > 180)), c: '#d55181' }].filter(p => p.v));

  // Agentes compradores
  const ag = [...groupBy(E.a.filter(o => o.comp), o => o.comp).entries()].map(([k, a]) => ({ k, m: sum(a), n: a.length })).sort((x, y) => y.m - x.m).slice(0, 8);
  const agMax = ag[0]?.m || 1;
  $('eAg').innerHTML = ag.length ? ag.map(x => `<div style="display:grid;grid-template-columns:90px 1fr 92px;gap:10px;align-items:center;margin-bottom:9px;font-size:12px"><span style="font-family:var(--mono);color:var(--text-2)">Agente ${esc(x.k)}</span><div style="height:12px;border-radius:0 4px 4px 0;background:var(--accent);opacity:.8;width:${x.m / agMax * 100}%"></div><span style="font-family:var(--mono);text-align:right">${fmtMonto(x.m)}</span></div>`).join('') : '<div class="empty">Sin datos de comprador.</div>';

  if (ents.length > 1) {
    $('eCmpTbl').innerHTML = `<thead><tr><th class="l">Responsable</th><th class="l">Categoría</th><th>Ops</th><th>Monto</th><th>Plazo</th><th>TNA</th><th>Spread</th></tr></thead><tbody>` +
      ents.map(e => `<tr><td class="l nm" title="${esc(e.n)}"><span class="sw" style="background:${e.c}"></span>${esc(e.n)}</td><td class="l">${esc(CAT_S[e.cat] || e.cat || '—')}</td><td>${fmtN(e.a.length)}</td><td>${fmtMonto(e.m)}</td><td>${fmtN(e.p, 0)} d</td><td>${fmtN(e.t, 2)}%</td><td>${isFinite(e.spr) ? (e.spr >= 0 ? '+' : '') + fmtN(e.spr, 0) + ' pb' : '—'}</td></tr>`).join('') + '</tbody>';
  }
  const ops = [...E.a].sort((x, y) => y.date.localeCompare(x.date) || y.monto - x.monto);
  $('eOps').innerHTML = `<thead><tr><th class="l">Fecha</th><th class="l">Segmento</th><th class="l">Instr.</th><th>Plazo</th><th class="l">Tramo</th><th>TNA</th><th>vs. mercado</th><th>Monto</th><th>Vto. est.</th><th>Comprador</th></tr></thead><tbody>` +
    ops.slice(0, 500).map(o => { const ref = refMap.get(o.tramo + '|' + o.seg); const dv = isFinite(o.tna) && isFinite(ref) ? (o.tna - ref) * 100 : NaN; return `<tr><td class="l">${fmtD(o.date)}</td><td class="l"><span class="sw" style="background:${SEG_C[o.seg] || '#717a86'}"></span>${esc(o.seg)}</td><td class="l">${esc(o.tipo)}</td><td>${o.ppv} d</td><td class="l">${esc(o.tramo)}</td><td>${isFinite(o.tna) ? fmtN(o.tna, 2) + '%' : '—'}</td><td style="color:${dv > 0 ? 'var(--up)' : dv < 0 ? 'var(--down)' : 'inherit'}">${isFinite(dv) ? (dv >= 0 ? '+' : '') + fmtN(dv, 0) + ' pb' : '—'}</td><td>${fmtMonto(o.monto)}</td><td>${o.ppv > 0 ? fmtD(isoAdd(o.date, o.ppv)) : '—'}</td><td>${esc(o.comp || '—')}</td></tr>`; }).join('') + '</tbody>';
}
function wireEmisores() {
  const pick = (v, add) => {
    const names = new Set(HIST.map(o => o.emp));
    let n = v.trim(); if (!n) return;
    if (!names.has(n)) { const byCuit = HIST.find(o => o.cuit === n); const m = byCuit ? byCuit.emp : [...names].find(x => x.toLowerCase().includes(n.toLowerCase())); if (!m) return; n = m; }
    if (add) { if (n !== EMP.main && !EMP.cmp.includes(n) && EMP.cmp.length < 2) EMP.cmp.push(n); $('eAdd').value = ''; }
    else { EMP.main = n; EMP.cmp = EMP.cmp.filter(x => x !== n); }
    render();
  };
  $('eMain').addEventListener('change', e => pick(e.target.value, false));
  $('eAdd').addEventListener('change', e => pick(e.target.value, true));
  $('eCmp').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { EMP.cmp.splice(+b.dataset.rm, 1); render(); } };
}

// ══════════════════════════════════════════════════════════════════════════════
// CURVAS
// ══════════════════════════════════════════════════════════════════════════════
function renderCurvas() {
  const P = rated(HIST.filter(o => passBase(o) && inPer(o)));
  const xs = P.map(o => o.ppv).filter(x => x > 0).sort((a, b) => a - b);
  const xMax = xs.length ? Math.max(60, Math.ceil(xs[Math.floor(xs.length * .98)] * 1.08 / 30) * 30) : 365;
  const MAXP = 6000, stride = Math.max(1, Math.ceil(P.length / MAXP));
  const maxM = Math.max(1, ...P.map(o => o.monto)), rad = m => 2 + 7 * Math.sqrt(m / maxM);
  const fits = Object.fromEntries(SEGS.map(s => [s.k, fitLog(P.filter(o => o.seg === s.k))]));
  $('cScatterNote').textContent = `${fmtN(P.length)} ops${stride > 1 ? ` · se muestra 1 de cada ${stride}` : ''}`;
  legend('cScatterLeg', SEGS.map(s => ({ l: s.k, c: s.c, cls: 'cir' })));
  const ds = [
    ...SEGS.filter(s => fits[s.k]).map(s => { const f = fits[s.k], pts = []; for (let x = Math.max(1, f.lo); x <= Math.min(xMax, f.hi * 1.15); x += Math.max(1, xMax / 80)) pts.push({ x, y: f.f(x) }); return { type: 'line', label: s.k + ' (ajuste)', data: pts, borderColor: s.c, borderWidth: 2.5, pointRadius: 0, tension: 0 }; }),
    ...SEGS.map(s => { const a = P.filter((o, i) => o.seg === s.k && o.ppv <= xMax && i % stride === 0); return { label: s.k, data: a.map(o => ({ x: o.ppv, y: o.tna, o })), backgroundColor: s.c + '66', borderColor: s.c + 'aa', borderWidth: 1, pointRadius: a.map(o => rad(o.monto)) }; }),
  ];
  mkChart('cScatter', { type: 'scatter', data: { datasets: ds }, options: {
    scales: { x: { ...AXX, min: 0, max: xMax, title: { display: true, text: 'plazo (días)' } }, y: { ...AX, ...yRange(P), ticks: { callback: v => v + '%' } } },
    plugins: { tooltip: { callbacks: { title: i => i[0].raw.o ? i[0].raw.o.emp : i[0].dataset.label, label: i => i.raw.o ? [` ${fmtD(i.raw.o.date)} · ${i.raw.o.seg} · ${i.raw.o.ppv} d`, ` TNA ${fmtN(i.raw.o.tna, 2)}% · ${fmtMonto(i.raw.o.monto)}`] : ` ${Math.round(i.parsed.x)} d → ${fmtN(i.parsed.y, 2)}%` } } },
  } });

  const PL = [30, 60, 90, 180, 365];
  $('cImpl').innerHTML = `<thead><tr><th class="l">Segmento</th>${PL.map(p => `<th>${p} d</th>`).join('')}<th>n</th></tr></thead><tbody>` +
    SEGS.map(s => { const f = fits[s.k]; return `<tr><td class="l nm"><span class="sw" style="background:${s.c}"></span>${s.k}</td>${PL.map(p => `<td>${f && p >= f.lo * .8 && p <= f.hi * 1.2 ? fmtN(f.f(p), 2) + '%' : '<span style="color:var(--muted)">—</span>'}</td>`).join('')}<td>${f ? fmtN(f.n) : 0}</td></tr>`; }).join('') + '</tbody>';

  // Evolución diaria
  const days = [...new Set(P.map(o => o.date))].sort();
  const bd = groupBy(P, o => o.date + '|' + o.seg);
  legend('cEvoLeg', SEGS.map(s => ({ l: s.k, c: s.c, cls: 'ln' })));
  mkChart('cEvo', { type: 'line', data: { labels: days.map(fmtDs), datasets: SEGS.map(s => ({ label: s.k, data: days.map(d => { const a = bd.get(d + '|' + s.k); return a ? wavg(a) : null; }), borderColor: s.c, backgroundColor: s.c, borderWidth: 2, pointRadius: days.length > 40 ? 0 : 3, tension: .25, spanGaps: true })) },
    options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ...AXX, ticks: { maxTicksLimit: 12 } }, y: { ...AX, ticks: { callback: v => v + '%' } } }, plugins: { tooltip: { callbacks: { label: i => ` ${i.dataset.label}: ${fmtN(i.parsed.y, 2)}%` } } } } });
  const sp = days.map(d => { const ng = bd.get(d + '|No Garantizado'), av = bd.get(d + '|Avalado'); return ng && av ? (wavg(ng) - wavg(av)) * 100 : null; });
  mkChart('cSpread', { type: 'bar', data: { labels: days.map(fmtDs), datasets: [{ label: 'Spread', data: sp, backgroundColor: sp.map(v => v >= 0 ? 'rgba(166,230,53,.75)' : 'rgba(57,135,229,.75)'), borderRadius: 3, barPercentage: .8 }] },
    options: { scales: { x: { ...AXX, ticks: { maxTicksLimit: 12 } }, y: { ...AX, ticks: { callback: v => (v > 0 ? '+' : '') + v } } }, plugins: { tooltip: { callbacks: { label: i => ` NG − Avalado: ${i.parsed.y >= 0 ? '+' : ''}${fmtN(i.parsed.y, 0)} pb` } } } } });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  if (typeof Chart === 'undefined') { overlay('No se pudo cargar la librería de gráficos (Chart.js). Revisá la conexión.', true); return; }
  chartDefaults();
  wireFilters(); wireEmisores();
  $('tabs').onclick = e => { const t = e.target.closest('[data-v]'); if (t) setView(t.dataset.v); };
  $('mHmMode').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { hmMode = b.dataset.m; render(); } };
  $('vEst').onclick = e => { const b = e.target.closest('[data-e]'); if (b) { vEst = b.dataset.e; renderVivo(); } };
  $('vSearch').oninput = e => { vSearch = e.target.value; renderVivo(); };
  $('btnReload').onclick = () => { if (view === 'vivo') loadHoy(); else loadHist(); };
  const h = location.hash.slice(1);
  if (['mercado', 'vivo', 'emisores', 'curvas'].includes(h)) { view = h; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === h)); document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + h)); }
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v !== view && ['mercado', 'vivo', 'emisores', 'curvas'].includes(v)) setView(v); });
  loadHist().then(() => { if (view === 'vivo') setView('vivo'); });
}
init();
