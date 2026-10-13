// ── Chart.js defaults (estilo one618) ────────────────────────────────────────
Chart.defaults.color         = '#6b7280';
Chart.defaults.borderColor   = '#e5e7eb';
Chart.defaults.font.family   = "'DM Mono', ui-monospace, monospace";
Chart.defaults.plugins.tooltip.backgroundColor = '#111318';
Chart.defaults.plugins.tooltip.borderColor     = '#1e2330';
Chart.defaults.plugins.tooltip.borderWidth     = 1;
Chart.defaults.plugins.tooltip.titleColor      = '#f0f4f8';
Chart.defaults.plugins.tooltip.bodyColor       = '#9ca3af';
Chart.defaults.plugins.tooltip.padding         = 10;

// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_ID = '1xrJOqC7UoFQoyqFErfXFjbLfp2h13K5Tzs7YE1S9uv8';
const GID      = '1748110732';   // pestaña "historico"
const RT_GID   = 'COMPLETAR';    // pestaña "hoy" (el GID lo muestra MAV → Configurar)
// URL de "Publicar en la web" — sin auth, CORS ok desde GitHub Pages
const PUB_ID   = '2PACX-1vTD0j3RWyrONWTbyyvL9JhuPpcLR6Lq0zFzegO-g7PS4CVQ4ARrNa1MCEa3gk95z_-gKMl4VbKI4_S_';
const CSV_URLS = [
  `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pub?gid=${GID}&single=true&output=csv`,
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`,
];

// Paleta one618 — base: #E32D91 (rosa), #1A49C8 (azul), #B2B2B2 (gris)
const TRAMO_COLORS = {
  '0-30':    '#E32D91',  // rosa primario
  '31-60':   '#1A49C8',  // azul primario
  '61-90':   '#B2B2B2',  // gris
  '91-120':  '#7B1FAE',  // violeta (entre rosa y azul)
  '121-150': '#E8709A',  // rosa claro
  '125-150': '#4B6FD8',  // azul claro
  '151-180': '#212121',  // negro
  '181+':    '#6B7280'   // gris oscuro
};
const CAT_COLORS = {
  'SGR':            '#E32D91',
  'PyME':           '#1A49C8',
  'Banco':          '#7B1FAE',
  'Gran empresa':   '#212121',
  'Sector público/ Asociación civil': '#B2B2B2',
  'Sin clasificar': '#6B7280'
};
const MON_LABELS = {'$':'$ ARS','DOL':'Hard Dollar','U$D':'Dólar A3500','U$S':'Dólar BNA','USD':'Hard Dollar'};
// Renombra segmentos "sin calificación" para distinguirlos del calificado
const SEG_LABELS = {
  'No Garantizado':  'No Garantizado No Calificado',
  'Garantizado':     'Garantizado No Calificado',
};
const segLbl = s => SEG_LABELS[s] || s || '—';

// ── State ─────────────────────────────────────────────────────────────────────
let rawData = [];
let charts  = {};
const F = { monedas:[], segmento:'ALL', tipo:'ALL', desde:'', hasta:'' }; // monedas: [] = todas
let F_inst  = 'ALL'; // instrumento toggle independiente
let tblCat    = 'ALL'; // tabla empresas: filtro por categoría
let tblTramo  = 'ALL'; // tabla empresas: filtro por tramo
let tblSearch = '';    // tabla empresas: búsqueda por nombre
let filteredData = []; // última vista filtrada (para actualizar tabla sin recargar todo)

// ── Data loader ───────────────────────────────────────────────────────────────
async function loadAndRender() {
  showLoading('Cargando datos…');
  let lastErr = '';
  for (const url of CSV_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showLoading('Procesando datos…');
      rawData = parseCSV(await res.text());
      if (!rawData.length) throw new Error('Sin filas válidas en el CSV.');
      initFilters(); applyFilters(); initEmpTab(); hideLoading();
      return; // éxito
    } catch(e) {
      lastErr = e.message + (e.stack ? '<br><code style="font-size:10px;opacity:.7">' + e.stack.split('\n').slice(0,3).join('<br>') + '</code>' : '');
    }
  }
  // Ambas URLs fallaron — mostrar error real
  showError(`Error: ${lastErr}<br><small style="opacity:.6">URLs probadas: export?format=csv y gviz/tq?tqx=out:csv</small>`);
}

// ── Número en formato argentino (1.234.567,89) o estándar (1234567.89) ────────
function parseArg(raw) {
  let s = (raw || '').replace(/"/g, '').trim();
  if (!s) return NaN;
  // Si tiene coma: formato AR → puntos = miles, coma = decimal
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Sin coma: si hay más de un punto son miles (1.234.567), eliminarlos
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) s = s.replace(/\./g, '');
    // si hay un solo punto podría ser decimal estándar → dejarlo
  }
  return parseFloat(s);
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSVRow(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Header — strip BOM, build index map
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = parseCSVRow(headerLine).map(h => h.trim().replace(/\\$/, '').replace(/"/g,''));
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  // Column indices (verified from sheet structure)
  const C = {
    fecha:    idx['FEC.SUB.']         ?? 1,
    segmento: idx['SEGMENTO']         ?? 2,
    tipo:     idx['TIPO INSTRUMENTO'] ?? 6,
    tasaC:    idx['TASA C.']          ?? 14,
    moneda:   idx['MONEDA']           ?? 17,
    monto:    idx['MONTO']            ?? 18,
    empresa:  idx['NOMBRE RESPONSABLE'] ?? 24,
    categoria:idx['CATEGORIA']        ?? 26,
    tramo:     idx['TRAMO']            ?? 27,
    comprador: idx['COMPRADOR']       ?? 28,
    vendedor:  idx['VENDEDOR']        ?? 29,
    ppv:       idx['PPV']             ?? -1,
    calif:     idx['CALIFICADO']      ?? -1,
  };

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const r = parseCSVRow(line);

    const fechaRaw = (r[C.fecha] || '').replace(/"/g,'').trim();
    if (!fechaRaw) continue;

    // Parse date: dd/mm/yyyy or d/m/yyyy → yyyy-mm-dd
    const parts = fechaRaw.split('/');
    if (parts.length !== 3) continue;
    const date = parts[2].padStart(4,'0') + '-' + parts[1].padStart(2,'0') + '-' + parts[0].padStart(2,'0');

    const tasa  = parseArg(r[C.tasaC]);
    const monto = parseArg(r[C.monto]);
    if (isNaN(tasa) || isNaN(monto) || monto <= 0) continue;

    result.push({
      date,
      segmento:  (r[C.segmento]  || '').replace(/"/g,'').trim() + (C.calif >= 0 && (r[C.calif]||'').trim() === 'SI' ? ' Calificado' : ''),
      tipo:      (r[C.tipo]       || '').replace(/"/g,'').trim(),
      tasa,
      moneda:    (r[C.moneda]     || '').replace(/"/g,'').trim(),
      monto,
      empresa:   (r[C.empresa]    || '').replace(/"/g,'').trim(),
      categoria: (r[C.categoria]  || '').replace(/"/g,'').trim(),
      tramo:     (r[C.tramo]      || '').replace(/"/g,'').trim(),
      comprador: (r[C.comprador]  || '').replace(/"/g,'').trim() || 'sin datos',
      vendedor:  (r[C.vendedor]   || '').replace(/"/g,'').trim() || 'sin datos',
      ppv:       C.ppv >= 0 ? parseArg(r[C.ppv]) : NaN,
    });
  }
  return result;
}

// ── Filters ───────────────────────────────────────────────────────────────────
function initFilters() {
  const uniq = arr => [...new Set(arr)].filter(Boolean).sort();
  const dates     = uniq(rawData.map(r => r.date));
  const monedas   = uniq(rawData.map(r => r.moneda));
  const segmentos = uniq(rawData.map(r => r.segmento));
  const tipos     = uniq(rawData.map(r => r.tipo));

  // Moneda buttons — multi-select: click para activar/desactivar, ninguno = todas
  const wrap = document.getElementById('monWrap');
  wrap.innerHTML = '';
  if (!F.monedas.length) F.monedas = [monedas.includes('$') ? '$' : monedas[0]];
  monedas.forEach(m => {
    const b = document.createElement('button');
    b.className = 'mon-btn' + (F.monedas.includes(m) ? ' on' : '');
    b.dataset.v = m;
    b.textContent = MON_LABELS[m] || m;
    b.onclick = function(){ setMon(this); };
    wrap.appendChild(b);
  });

  // Segmento
  const fSeg = document.getElementById('fSeg');
  fSeg.innerHTML = '<option value="ALL">Todos</option>';
  // Opciones virtuales (totales)
  if (segmentos.some(s => s.toLowerCase().includes('garantizado') && !s.toLowerCase().includes('no')))
    fSeg.add(new Option('── Garantizado Total', '_G_TOTAL'));
  if (segmentos.some(s => s.toLowerCase().includes('no garantizado')))
    fSeg.add(new Option('── No Garantizado Total', '_NG_TOTAL'));
  // Opciones individuales
  segmentos.forEach(s => fSeg.add(new Option(segLbl(s), s)));
  fSeg.onchange = () => { F.segmento = fSeg.value; applyFilters(); };

  // Tipo
  const fTipo = document.getElementById('fTipo');
  fTipo.innerHTML = '<option value="ALL">Todos</option>';
  tipos.forEach(t => fTipo.add(new Option(t, t)));
  fTipo.onchange = () => { F.tipo = fTipo.value; applyFilters(); };

  // Fechas
  F.desde = dates[0]; F.hasta = dates[dates.length-1];
  document.getElementById('fDesde').value = F.desde;
  document.getElementById('fHasta').value = F.hasta;
  document.getElementById('fDesde').onchange = function(){ F.desde=this.value; applyFilters(); };
  document.getElementById('fHasta').onchange = function(){ F.hasta=this.value; applyFilters(); };

  document.getElementById('periodLabel').textContent =
    `Período: ${fmtDate(F.desde)} – ${fmtDate(F.hasta)}  ·  ${dates.length} días hábiles`;
  document.getElementById('updBadge').textContent =
    'Actualizado ' + new Date().toLocaleString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

  // Category legend
  document.getElementById('catLegend').innerHTML =
    Object.entries(CAT_COLORS).map(([k,c]) =>
      `<div class="leg-item"><div class="leg-dot" style="background:${c}"></div><span>${k}</span></div>`
    ).join('');
}

function setMon(btn) {
  const v = btn.dataset.v;
  const idx = F.monedas.indexOf(v);
  if (idx >= 0) {
    // Si ya estaba activa: deseleccionar, pero nunca dejar vacío
    if (F.monedas.length > 1) F.monedas.splice(idx, 1);
  } else {
    F.monedas.push(v);
  }
  document.querySelectorAll('.mon-btn').forEach(b =>
    b.classList.toggle('on', F.monedas.includes(b.dataset.v))
  );
  applyFilters();
}
function resetFilters() {
  const monedas = [...new Set(rawData.map(r=>r.moneda))].filter(Boolean).sort();
  const defaultMon = monedas.includes('$') ? '$' : monedas[0];
  F.monedas = [defaultMon]; F.segmento = 'ALL'; F.tipo = 'ALL';
  const dates = [...new Set(rawData.map(r=>r.date))].filter(Boolean).sort();
  F.desde = dates[0]; F.hasta = dates[dates.length-1];
  document.querySelectorAll('.mon-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.v === defaultMon)
  );
  document.getElementById('fSeg').value   = 'ALL';
  document.getElementById('fTipo').value  = 'ALL';
  document.getElementById('fDesde').value = F.desde;
  document.getElementById('fHasta').value = F.hasta;
  applyFilters();
}
function segMatch(seg, filterVal) {
  if (filterVal === 'ALL') return true;
  if (filterVal === '_G_TOTAL')  return (seg||'').toLowerCase().includes('garantizado') && !(seg||'').toLowerCase().includes('no garantizado');
  if (filterVal === '_NG_TOTAL') return (seg||'').toLowerCase().includes('no garantizado');
  return seg === filterVal;
}
function filtered() {
  return rawData.filter(r => {
    if (F.monedas.length && !F.monedas.includes(r.moneda)) return false;
    if (!segMatch(r.segmento, F.segmento)) return false;
    if (F.tipo !== 'ALL' && r.tipo !== F.tipo) return false;
    if (F.desde && r.date < F.desde) return false;
    if (F.hasta && r.date > F.hasta) return false;
    return true;
  });
}

// ── Paleta para segmentos (asignada dinámicamente) ────────────────────────────
const SEG_PALETTE = ['#E32D91','#1A49C8','#7B1FAE','#B2B2B2','#E8709A','#4B6FD8','#212121','#6B7280'];
const TIPO_PALETTE = ['#1A49C8','#E32D91','#7B1FAE','#B2B2B2','#4B6FD8','#E8709A','#212121','#6B7280','#94a3b8'];
const MON_PALETTE  = { '$':'#E32D91', 'DOL':'#1A49C8', 'U$D':'#1A49C8', 'U$S':'#4B6FD8', 'USD':'#1A49C8' };

// ── Apply all ─────────────────────────────────────────────────────────────────
function applyFilters() {
  filteredData = filtered();
  updKPIs(filteredData); updTramo(filteredData); updTemporal(filteredData); updMontos(filteredData);
  updTable(filteredData); updTreemap(filteredData);
  updPies(filteredData); updTasaTramo(filteredData); updInstrPyme(filteredData);
}

function setInstr(btn) {
  document.querySelectorAll('.instr-btn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  F_inst = btn.dataset.inst;
  updInstrPyme(filtered());
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
function updKPIs(d) {
  const sumM  = d.reduce((s,r) => s+r.monto, 0);
  const sumTM = d.reduce((s,r) => s+r.tasa*r.monto, 0);
  const tasa  = sumM > 0 ? sumTM/sumM : NaN;
  const dias  = new Set(d.map(r=>r.date)).size;
  const ops   = d.length;

  document.getElementById('kTasa').textContent   = isNaN(tasa) ? '—' : tasa.toFixed(2)+'%';
  document.getElementById('kDias').textContent   = dias;
  document.getElementById('kDiaSub').textContent = fmtDate(F.desde)+' – '+fmtDate(F.hasta);
  document.getElementById('kOps').textContent    = ops.toLocaleString('es-AR');
  document.getElementById('kOpsSub').textContent = ops>0 ? fmtM(sumM/ops)+' prom / op.' : '—';

  // Tags de contexto bajo la tasa
  const allMon    = [...new Set(rawData.map(r=>r.moneda))].filter(Boolean);
  const allSel    = F.monedas.length >= allMon.length;
  const monLabel  = allSel ? 'Todas las monedas'
                   : F.monedas.map(m => MON_LABELS[m] || m).join(' + ');
  const segLabel  = F.segmento === 'ALL' ? 'Todos los segmentos'
    : F.segmento === '_G_TOTAL'  ? 'Garantizado Total'
    : F.segmento === '_NG_TOTAL' ? 'No Garantizado Total'
    : segLbl(F.segmento);
  const tipoLabel = F.tipo     === 'ALL' ? 'Todos los instrumentos' : F.tipo;
  const tags = [
    { text: monLabel,  color: allSel             ? '#B2B2B2' : '#E32D91' },
    { text: segLabel,  color: F.segmento === 'ALL' ? '#B2B2B2' : '#1A49C8' },
    { text: tipoLabel, color: F.tipo     === 'ALL' ? '#B2B2B2' : '#7B1FAE' },
  ];
  document.getElementById('kTasaTags').innerHTML = tags.map(t =>
    `<span class="kpi-tag" style="background:${t.color}18;color:${t.color};border:1px solid ${t.color}44">${t.text}</span>`
  ).join('');

  // Highlight active filters
  updFilterHighlight();
}

function updFilterHighlight() {
  // Segmento select
  const fSeg  = document.getElementById('fSeg');
  const fTipo = document.getElementById('fTipo');
  fSeg?.classList.toggle('active',  F.segmento !== 'ALL');
  fTipo?.classList.toggle('active', F.tipo     !== 'ALL');
  // fg wrappers
  fSeg?.closest('.fg')?.classList.toggle('active',  F.segmento !== 'ALL');
  fTipo?.closest('.fg')?.classList.toggle('active', F.tipo     !== 'ALL');
  const allMonedas = [...new Set(rawData.map(r=>r.moneda))].filter(Boolean);
  document.getElementById('monWrap')?.closest('.fg')?.classList.toggle('active', F.monedas.length < allMonedas.length);
}

// ── Tramo bar ─────────────────────────────────────────────────────────────────
function updTramo(d) {
  const m = {};
  d.forEach(r => {
    if (!r.tramo) return;
    if (!m[r.tramo]) m[r.tramo] = {sM:0,sTM:0};
    m[r.tramo].sM += r.monto; m[r.tramo].sTM += r.tasa*r.monto;
  });
  const tramos = Object.keys(m).sort((a,b)=>parseInt(a)-parseInt(b));
  if (!tramos.length) return;
  if (charts.tramo) charts.tramo.destroy();
  charts.tramo = new Chart(document.getElementById('cTramo'), {
    type: 'bar',
    data: {
      labels: tramos.map(t => t+' días'),
      datasets: [{ data: tramos.map(t => m[t].sM>0 ? +(m[t].sTM/m[t].sM).toFixed(3):0),
                   backgroundColor: tramos.map(t => TRAMO_COLORS[t]||'#94a3b8'),
                   borderRadius:5, borderSkipped:false }]
    },
    options: {
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins: {
        legend:{display:false},
        tooltip:{callbacks:{
          label: ctx => ' Tasa pond.: '+ctx.raw.toFixed(2)+'%',
          afterLabel: ctx => ' Monto: '+fmtM(m[tramos[ctx.dataIndex]].sM)
        }}
      },
      scales: {
        x: { grid:{color:'#f3f4f6'}, ticks:{callback:v=>v+'%',font:{size:11}},
             title:{display:true,text:'Tasa de Compra TNA (%)',font:{size:11}} },
        y: { grid:{display:false}, ticks:{font:{size:12}} }
      }
    }
  });
}

// ── Temporal line ─────────────────────────────────────────────────────────────
function updTemporal(d) {
  const m = {};
  d.forEach(r => {
    if (!r.tramo||!r.date) return;
    const k = r.date+'|'+r.tramo;
    if (!m[k]) m[k]={sM:0,sTM:0};
    m[k].sM+=r.monto; m[k].sTM+=r.tasa*r.monto;
  });
  const tramos = [...new Set(d.map(r=>r.tramo).filter(Boolean))].sort((a,b)=>parseInt(a)-parseInt(b));
  const datasets = tramos.map(tramo => ({
    label: tramo+' d.',
    data: Object.entries(m)
      .filter(([k])=>k.endsWith('|'+tramo))
      .map(([k,v])=>({x:k.split('|')[0], y:v.sM>0?+(v.sTM/v.sM).toFixed(3):null}))
      .filter(p=>p.y!==null).sort((a,b)=>a.x.localeCompare(b.x)),
    borderColor: TRAMO_COLORS[tramo]||'#94a3b8',
    backgroundColor:'transparent', borderWidth:2,
    pointRadius:2, pointHoverRadius:5, tension:0.25, spanGaps:false
  }));
  if (charts.temporal) charts.temporal.destroy();
  charts.temporal = new Chart(document.getElementById('cTemporal'), {
    type:'line', data:{datasets},
    options: {
      responsive:true, maintainAspectRatio:false,
      parsing:{xAxisKey:'x',yAxisKey:'y'},
      interaction:{mode:'index',intersect:false},
      plugins: {
        legend:{position:'top',labels:{font:{size:11},boxWidth:14,padding:10,usePointStyle:true}},
        tooltip:{callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.raw.y?.toFixed(2)}%`}}
      },
      scales: {
        x:{type:'time',time:{unit:'week',displayFormats:{week:'d MMM'},tooltipFormat:'dd/MM/yyyy'},
           grid:{color:'#f3f4f6'},ticks:{font:{size:10}}},
        y:{grid:{color:'#f3f4f6'},ticks:{callback:v=>v+'%',font:{size:11}},
           title:{display:true,text:'TNA %',font:{size:11}}}
      }
    }
  });
}

// ── Montos bar ────────────────────────────────────────────────────────────────
function updMontos(d) {
  const m = {};
  d.forEach(r=>{ if(r.date) m[r.date]=(m[r.date]||0)+r.monto; });
  const sorted = Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0]));
  document.getElementById('montSub').textContent = 'Total: '+fmtM(sorted.reduce((s,[,v])=>s+v,0));
  if (charts.montos) charts.montos.destroy();
  // Labels as formatted dates (category axis — avoids blank gaps for weekends/holidays)
  const labels = sorted.map(([dateStr])=>fmtDate(dateStr));
  charts.montos = new Chart(document.getElementById('cMontos'), {
    type:'bar',
    data:{
      labels,
      datasets:[{label:'Monto diario', data:sorted.map(([,v])=>+(v/1e9).toFixed(3)),
                 backgroundColor:'rgba(26,73,200,.45)',borderColor:'#1A49C8',
                 borderWidth:1,borderRadius:3}]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false},
               tooltip:{callbacks:{label:ctx=>' '+ctx.raw.toFixed(1)+' MM'}}},
      scales:{
        x:{type:'category',
           grid:{display:false},
           ticks:{font:{size:10}, maxRotation:45, autoSkip:true, maxTicksLimit:20}},
        y:{grid:{color:'#f3f4f6'},
           ticks:{callback:v=>v.toFixed(0)+' MM',font:{size:10}},
           title:{display:true,text:'Miles de millones ($)',font:{size:11}}}
      }
    }
  });
}

// ── Tabla empresas ────────────────────────────────────────────────────────────
function updTable(d) {
  // Pre-filter by tramo before aggregating (tramo lives at row level)
  const src = tblTramo === 'ALL' ? d : d.filter(r => (r.tramo||'') === tblTramo);

  // Aggregate by empresa
  const m = {};
  src.forEach(r=>{
    if(!r.empresa) return;
    if(!m[r.empresa]) m[r.empresa]={sM:0,sTM:0,cat:r.categoria};
    m[r.empresa].sM+=r.monto; m[r.empresa].sTM+=r.tasa*r.monto;
  });

  // ── Categoría chips (built from full d, not src, so options don't disappear) ──
  const allCats = ['ALL',...d.reduce((s,r)=>{ s.add(r.categoria||'Sin clasificar'); return s;}, new Set())];
  const chipsEl = document.getElementById('catChips');
  if (chipsEl) {
    chipsEl.innerHTML = allCats.map(c=>{
      const col = c==='ALL' ? '#6B7280' : (CAT_COLORS[c]||'#94a3b8');
      const on  = tblCat===c;
      return `<button onclick="tblCat='${c}';updTable(filteredData)"
        style="padding:3px 10px;border-radius:20px;border:1px solid ${col};cursor:pointer;font-family:inherit;font-size:11px;
               background:${on?col:'transparent'};color:${on?'#fff':col};transition:all .15s">
        ${c==='ALL'?'Todas':c}</button>`;
    }).join('');
  }

  // ── Tramo chips (built from full d so options don't disappear) ──
  const allTramos = ['ALL',...[...d.reduce((s,r)=>{ if(r.tramo) s.add(r.tramo); return s;}, new Set())]
    .sort((a,b)=>parseInt(a)-parseInt(b))];
  const tramoEl = document.getElementById('tramoChips');
  if (tramoEl) {
    tramoEl.innerHTML = allTramos.map(t=>{
      const on = tblTramo===t;
      return `<button onclick="tblTramo='${t}';updTable(filteredData)"
        style="padding:3px 10px;border-radius:20px;border:1px solid #1A49C8;cursor:pointer;font-family:inherit;font-size:11px;
               background:${on?'#1A49C8':'transparent'};color:${on?'#fff':'#1A49C8'};transition:all .15s">
        ${t==='ALL'?'Todos':t+' días'}</button>`;
    }).join('');
  }

  // Apply category + search filters
  let rows = Object.entries(m);
  if (tblCat !== 'ALL') rows = rows.filter(([,v])=>(v.cat||'Sin clasificar')===tblCat);
  if (tblSearch) rows = rows.filter(([emp])=>emp.toLowerCase().includes(tblSearch));

  // Sort by monto desc, show top 20
  const top = rows.sort((a,b)=>b[1].sM-a[1].sM).slice(0,20);

  // Update subtitle
  const subEl = document.getElementById('tblSub');
  if (subEl) subEl.textContent = `${top.length} empresa${top.length!==1?'s':''} · ordenadas por monto`;

  document.getElementById('tEmp').innerHTML = top.map(([emp,v],i)=>{
    const cat=v.cat||'Sin clasificar', col=CAT_COLORS[cat]||'#94a3b8';
    return `<tr>
      <td style="color:var(--muted);width:24px">${i+1}</td>
      <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${emp}">${emp}</td>
      <td><span class="bcat" style="background:${col}22;color:${col}">${cat}</span></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmtM(v.sM)}</td>
      <td style="text-align:right;color:#E32D91;font-weight:700">${(v.sTM/v.sM).toFixed(2)}%</td>
    </tr>`;
  }).join('');
}

// ── Treemap ───────────────────────────────────────────────────────────────────
function updTreemap(d) {
  const m = {};
  d.forEach(r=>{ if(!r.empresa) return; if(!m[r.empresa]) m[r.empresa]={sM:0,cat:r.categoria}; m[r.empresa].sM+=r.monto; });
  const top60 = Object.entries(m).sort((a,b)=>b[1].sM-a[1].sM).slice(0,60)
    .map(([name,v])=>({name,value:v.sM,cat:v.cat}));
  if (!top60.length) return;
  const svgEl = document.getElementById('treemap');
  const W = svgEl.parentElement.clientWidth-36;
  const H = Math.max(280, Math.min(520, W*0.42));
  svgEl.setAttribute('width',W); svgEl.setAttribute('height',H);
  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  const root = d3.hierarchy({children:top60}).sum(d=>d.value).sort((a,b)=>b.value-a.value);
  d3.treemap().size([W,H]).padding(2).paddingOuter(3).round(true)(root);
  const cell = svg.selectAll('g').data(root.leaves()).join('g')
    .attr('transform',d=>`translate(${d.x0},${d.y0})`);
  cell.append('rect')
    .attr('width',d=>Math.max(0,d.x1-d.x0)).attr('height',d=>Math.max(0,d.y1-d.y0))
    .attr('fill',d=>CAT_COLORS[d.data.cat]||'#94a3b8').attr('rx',3)
    .append('title').text(d=>`${d.data.name}\n${fmtM(d.data.value)}\n${d.data.cat}`);
  cell.filter(d=>d.x1-d.x0>55&&d.y1-d.y0>22)
    .append('text').attr('x',5).attr('y',14)
    .attr('font-size',d=>Math.min(12,Math.max(9,(d.x1-d.x0)/11))+'px').attr('font-weight','600')
    .text(d=>{ const w=d.x1-d.x0,n=d.data.name,max=Math.floor(w/7); return n.length>max?n.slice(0,max-1)+'…':n; });
  cell.filter(d=>d.x1-d.x0>70&&d.y1-d.y0>38)
    .append('text').attr('x',5).attr('y',28).attr('font-size','10px').attr('opacity',.85)
    .text(d=>fmtM(d.data.value));
}

// ── Pie / Donut charts ────────────────────────────────────────────────────────
function makePie(canvasId, labels, data, colors) {
  const key = 'pie_' + canvasId;
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, padding: 10, font: { size: 11 }, color: '#6b7280', usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
              return ` ${ctx.label}: ${pct}%  (${fmtM(ctx.raw)})`;
            }
          }
        }
      }
    }
  });
}

function updPies(d) {
  // Por Instrumento
  const mTipo = {};
  d.forEach(r => { if (r.tipo) mTipo[r.tipo] = (mTipo[r.tipo] || 0) + r.monto; });
  const tiposSorted = Object.entries(mTipo).sort((a, b) => b[1] - a[1]);
  makePie('cPieInst',
    tiposSorted.map(([k]) => k),
    tiposSorted.map(([, v]) => v),
    tiposSorted.map((_, i) => TIPO_PALETTE[i % TIPO_PALETTE.length])
  );

  // Por Moneda
  const mMon = {};
  d.forEach(r => { if (r.moneda) mMon[r.moneda] = (mMon[r.moneda] || 0) + r.monto; });
  const monsSorted = Object.entries(mMon).sort((a, b) => b[1] - a[1]);
  makePie('cPieMon',
    monsSorted.map(([k]) => MON_LABELS[k] || k),
    monsSorted.map(([, v]) => v),
    monsSorted.map(([k]) => MON_PALETTE[k] || '#B2B2B2')
  );

  // Por Segmento
  const mSeg = {};
  d.forEach(r => { if (r.segmento) mSeg[r.segmento] = (mSeg[r.segmento] || 0) + r.monto; });
  const segsSorted = Object.entries(mSeg).sort((a, b) => b[1] - a[1]);
  makePie('cPieSeg',
    segsSorted.map(([k]) => segLbl(k)),
    segsSorted.map(([, v]) => v),
    segsSorted.map((_, i) => SEG_PALETTE[i % SEG_PALETTE.length])
  );
}

// ── Tasas por Tramo × Segmento ────────────────────────────────────────────────
function updTasaTramo(d) {
  // Build map: segmento → tramo → {sM, sTM}
  const m = {};
  const tramoSet = new Set();
  const segSet   = new Set();
  d.forEach(r => {
    if (!r.tramo || !r.segmento) return;
    tramoSet.add(r.tramo);
    segSet.add(r.segmento);
    if (!m[r.segmento]) m[r.segmento] = {};
    if (!m[r.segmento][r.tramo]) m[r.segmento][r.tramo] = { sM: 0, sTM: 0 };
    m[r.segmento][r.tramo].sM  += r.monto;
    m[r.segmento][r.tramo].sTM += r.tasa * r.monto;
  });

  const tramos   = [...tramoSet].sort((a, b) => parseInt(a) - parseInt(b));
  const segmentos = [...segSet].sort();

  const datasets = segmentos.map((seg, i) => ({
    label: segLbl(seg),
    data: tramos.map(t => {
      const v = m[seg]?.[t];
      return v && v.sM > 0 ? +(v.sTM / v.sM).toFixed(3) : null;
    }),
    montoData: tramos.map(t => m[seg]?.[t]?.sM || 0),
    borderColor: SEG_PALETTE[i % SEG_PALETTE.length],
    backgroundColor: 'transparent',
    pointBackgroundColor: SEG_PALETTE[i % SEG_PALETTE.length],
    borderWidth: 2.2, pointRadius: 5, pointHoverRadius: 7,
    tension: 0.25, spanGaps: false
  }));

  if (charts.tasaTramo) charts.tasaTramo.destroy();
  charts.tasaTramo = new Chart(document.getElementById('cTasaTramo'), {
    type: 'line',
    data: { labels: tramos.map(t => t + ' días'), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 12, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.raw === null) return null;
              const monto = ctx.dataset.montoData?.[ctx.dataIndex] ?? 0;
              return ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%  ·  ${fmtM(monto)}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
        y: {
          grid: { color: '#f3f4f6' },
          ticks: { callback: v => v + '%', font: { size: 11 } },
          title: { display: true, text: 'Tasa Ponderada TNA (%)', font: { size: 11 } }
        }
      }
    }
  });
}

// ── Resumen por Instrumento ─────────────────────────────────────────────────────────
const SEG_ORDER_INSTR = ['Avalado', 'No Garantizado', 'Garantizado'];

function instrMatch(tipo) {
  const t = (tipo || '').toLowerCase();
  if (F_inst === 'PAG') return t.includes('pagar');
  if (F_inst === 'FCE') return t.includes('fce');
  if (F_inst === 'CPD') return !t.includes('pagar') && !t.includes('fce'); // catch-all
  return true; // ALL
}

function updInstrPyme(d) {
  // Apply instrumento toggle filter
  const rows = F_inst === 'ALL' ? d : d.filter(r => instrMatch(r.tipo));

  // Group: segmento → moneda → {sM, sTM, tramos:{}}
  const m = {};
  rows.forEach(r => {
    const seg = r.segmento || 'Sin segmento';
    const mon = r.moneda   || 'Sin moneda';
    const key = seg + '‖' + mon;
    if (!m[key]) m[key] = { seg, mon, sM: 0, sTM: 0, tramos: {} };
    m[key].sM  += r.monto;
    m[key].sTM += r.tasa * r.monto;
    const t = r.tramo || 'Sin tramo';
    m[key].tramos[t] = (m[key].tramos[t] || 0) + r.monto;
  });

  // Group by segmento
  const bySeg = {};
  Object.values(m).forEach(v => {
    if (!bySeg[v.seg]) bySeg[v.seg] = [];
    bySeg[v.seg].push(v);
  });

  const segsFound = Object.keys(bySeg);
  const segs = SEG_ORDER_INSTR.filter(s => segsFound.includes(s))
               .concat(segsFound.filter(s => !SEG_ORDER_INSTR.includes(s)));

  let html = '';
  segs.forEach(seg => {
    const subrows = bySeg[seg].sort((a, b) => b.sM - a.sM);
    const segTotal = subrows.reduce((s, r) => s + r.sM, 0);

    html += `<tr class="seg-hdr"><td colspan="6">
      ${segLbl(seg)}<span>${fmtM(segTotal)}</span>
    </td></tr>`;

    subrows.forEach(row => {
      const tna = row.sM > 0 ? row.sTM / row.sM : 0;
      const tem = tna / 12;
      const tea = (Math.pow(1 + tna / 100 / 12, 12) - 1) * 100;
      const majorTramo = Object.entries(row.tramos)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
      const monLabel = MON_LABELS[row.mon] || row.mon;

      html += `<tr>
        <td style="padding-left:22px;color:var(--muted);font-size:12px">${monLabel}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtN(row.sM)}</td>
        <td style="text-align:center;font-weight:600">${majorTramo} días</td>
        <td style="text-align:right;color:#E32D91;font-weight:700">${tea.toFixed(2)}%</td>
        <td style="text-align:right;font-weight:600">${tem.toFixed(2)}%</td>
        <td style="text-align:right;font-weight:700;color:var(--pri)">${tna.toFixed(2)}%</td>
      </tr>`;
    });
  });

  if (!html) html = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">Sin datos para los filtros seleccionados</td></tr>';
  document.getElementById('tInstr').innerHTML = html;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtN(v) {
  if (!v || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('es-AR');
}
function fmtM(v) {
  if (!v||isNaN(v)) return '—';
  if (v>=1e12) return '$'+(v/1e12).toFixed(1)+' B';
  if (v>=1e9)  return '$'+(v/1e9).toFixed(1)+' MM';
  if (v>=1e6)  return '$'+(v/1e6).toFixed(0)+' M';
  return '$'+v.toLocaleString('es-AR');
}
function fmtDate(d) {
  if(!d) return ''; const [y,m,day]=d.split('-'); return `${day}/${m}/${y}`;
}
function showLoading(msg) {
  document.getElementById('overlay').style.display='flex';
  document.getElementById('spinner').style.display='block';
  document.getElementById('loadMsg').textContent = msg;
}
function hideLoading() { document.getElementById('overlay').style.display='none'; }
function showError(msg) {
  document.getElementById('spinner').style.display='none';
  document.getElementById('loadMsg').innerHTML=`
    <div class="err-box">
      <h3>⚠ Error al cargar datos</h3>
      <p>${msg}</p>
      <button class="btn-pri" onclick="loadAndRender()">Reintentar</button>
    </div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadAndRender();
window.addEventListener('resize', ()=>{ if(rawData.length) updTreemap(filtered()); });

// ══════════════════════════════════════════════════════════════════════════════
// TIEMPO REAL
// ══════════════════════════════════════════════════════════════════════════════

// RT_GID se define arriba, en Config
const RT_CSV_URLS = [
  `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pub?gid=${RT_GID}&single=true&output=csv`,
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${RT_GID}`,
];

let rtRawData    = [];
let rtCharts     = {};
let rtFilteredData = [];
let rtTblSearch  = '';
let rtTblCat     = 'ALL';
const RT_F = { monedas: [], segmento: 'ALL', tipo: 'ALL' };
let rtAutoRefresh = null;

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('on', (i===0 && tab==='hist') || (i===1 && tab==='rt') || (i===2 && tab==='emp'))
  );
  document.getElementById('sect-hist').classList.toggle('on', tab==='hist');
  document.getElementById('sect-rt').classList.toggle('on', tab==='rt');
  document.getElementById('sect-emp').classList.toggle('on', tab==='emp');
  if (tab==='rt' && !rtRawData.length) loadRT();
  if (tab==='rt' && !rtAutoRefresh) {
    rtAutoRefresh = setInterval(loadRT, 5 * 60 * 1000); // refresh c/5 min
  }
  if (tab==='hist' && rtAutoRefresh) {
    clearInterval(rtAutoRefresh); rtAutoRefresh = null;
  }
}

// ── RT Data loader ────────────────────────────────────────────────────────────
async function loadRT() {
  showLoading('Cargando datos en tiempo real…');
  let lastErr = '';
  for (const url of RT_CSV_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showLoading('Procesando…');
      rtRawData = rtParseCSV(await res.text());
      if (!rtRawData.length) throw new Error('Sin filas válidas.');
      rtInitFilters();
      rtApplyFilters();
      hideLoading();
      document.getElementById('rtUpdBadge').textContent =
        'Actualizado ' + new Date().toLocaleString('es-AR',
          {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return;
    } catch(e) { lastErr = e.message; }
  }
  showError(`Error tiempo real: ${lastErr}`);
}

// ── RT CSV parser ─────────────────────────────────────────────────────────────
function rtParseCSV(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if (lines.length < 2) return [];
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = parseCSVRow(headerLine).map(h => h.trim().replace(/"/g,''));
  const idx = {};
  headers.forEach((h,i) => idx[h] = i);

  const C = {
    fecha:    idx['FEC.SUB.']           ?? 1,
    hora:     idx['T.MIN.']             ?? 10,
    segmento: idx['SEGMENTO']           ?? 2,
    tipo:     idx['TIPO INSTRUMENTO']   ?? 6,
    tasaC:    idx['TASA C.']            ?? 14,
    moneda:   idx['MONEDA']             ?? 17,
    monto:    idx['MONTO']              ?? 18,
    empresa:  idx['NOMBRE RESPONSABLE'] ?? 24,
    categoria:idx['CATEGORIA']          ?? 26,
    tramo:    idx['TRAMO']              ?? 27,
    calif:    idx['CALIFICADO']         ?? -1,
  };

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const r = parseCSVRow(line);
    const fechaRaw = (r[C.fecha] || '').replace(/"/g,'').trim();
    if (!fechaRaw) continue;
    const parts = fechaRaw.split('/');
    if (parts.length !== 3) continue;
    const date = parts[2].padStart(4,'0')+'-'+parts[1].padStart(2,'0')+'-'+parts[0].padStart(2,'0');
    const tasa  = parseArg(r[C.tasaC]);
    const monto = parseArg(r[C.monto]);
    if (isNaN(tasa) || isNaN(monto) || monto <= 0) continue;
    const horaRaw = (r[C.hora] || '').replace(/"/g,'').trim();
    const catRaw  = (r[C.categoria] || '').replace(/"/g,'').trim();
    // Validar que categoria no sea un tramo (ej: "31-60", "181+")
    const KNOWN_CATS = Object.keys(CAT_COLORS);
    const catVal = KNOWN_CATS.includes(catRaw) ? catRaw : '';
    result.push({
      date,
      hora:      horaRaw,
      segmento:  (r[C.segmento]  || '').replace(/"/g,'').trim() + (C.calif >= 0 && (r[C.calif]||'').trim() === 'SI' ? ' Calificado' : ''),
      tipo:      (r[C.tipo]      || '').replace(/"/g,'').trim(),
      tasa, monto,
      moneda:    (r[C.moneda]    || '').replace(/"/g,'').trim(),
      empresa:   (r[C.empresa]   || '').replace(/"/g,'').trim(),
      categoria: catVal,
      tramo:     (r[C.tramo]     || '').replace(/"/g,'').trim(),
    });
  }
  return result;
}

// ── RT Filters ────────────────────────────────────────────────────────────────
function rtInitFilters() {
  const uniq = arr => [...new Set(arr)].filter(Boolean).sort();
  const monedas   = uniq(rtRawData.map(r => r.moneda));
  const segmentos = uniq(rtRawData.map(r => r.segmento));
  const tipos     = uniq(rtRawData.map(r => r.tipo));

  // Monedas: siempre mostrar todas las del histórico; marcar sin datos si no aparecen hoy
  const uniqHist = arr => [...new Set(arr)].filter(Boolean).sort();
  const allMonedas = rawData.length ? uniqHist(rawData.map(r=>r.moneda)) : monedas;
  const wrap = document.getElementById('rtMonWrap');
  wrap.innerHTML = '';
  if (!RT_F.monedas.length) RT_F.monedas = [allMonedas.includes('$') ? '$' : allMonedas[0]];
  allMonedas.forEach(m => {
    const hasData = monedas.includes(m);
    const b = document.createElement('button');
    b.className = 'mon-btn' + (RT_F.monedas.includes(m) ? ' on' : '');
    b.dataset.v = m;
    b.textContent = MON_LABELS[m] || m;
    b.title = hasData ? '' : 'Sin operaciones hoy';
    b.style.opacity = hasData ? '1' : '0.45';
    b.onclick = function(){ rtSetMon(this); };
    wrap.appendChild(b);
  });

  const fSeg = document.getElementById('rtFSeg');
  fSeg.innerHTML = '<option value="ALL">Todos</option>';
  if (segmentos.some(s => s.toLowerCase().includes('garantizado') && !s.toLowerCase().includes('no')))
    fSeg.add(new Option('── Garantizado Total', '_G_TOTAL'));
  if (segmentos.some(s => s.toLowerCase().includes('no garantizado')))
    fSeg.add(new Option('── No Garantizado Total', '_NG_TOTAL'));
  segmentos.forEach(s => fSeg.add(new Option(segLbl(s), s)));
  fSeg.onchange = () => { RT_F.segmento = fSeg.value; rtApplyFilters(); };

  const fTipo = document.getElementById('rtFTipo');
  fTipo.innerHTML = '<option value="ALL">Todos</option>';
  tipos.forEach(t => fTipo.add(new Option(t, t)));
  fTipo.onchange = () => { RT_F.tipo = fTipo.value; rtApplyFilters(); };
}

function rtSetMon(btn) {
  const v = btn.dataset.v;
  const idx = RT_F.monedas.indexOf(v);
  if (idx >= 0) { if (RT_F.monedas.length > 1) RT_F.monedas.splice(idx,1); }
  else RT_F.monedas.push(v);
  document.querySelectorAll('#rtMonWrap .mon-btn').forEach(b =>
    b.classList.toggle('on', RT_F.monedas.includes(b.dataset.v))
  );
  rtApplyFilters();
}

function rtResetFilters() {
  const monedas = [...new Set(rtRawData.map(r=>r.moneda))].filter(Boolean).sort();
  RT_F.monedas = [monedas.includes('$') ? '$' : monedas[0]];
  RT_F.segmento = 'ALL'; RT_F.tipo = 'ALL';
  document.querySelectorAll('#rtMonWrap .mon-btn').forEach(b =>
    b.classList.toggle('on', RT_F.monedas.includes(b.dataset.v))
  );
  document.getElementById('rtFSeg').value  = 'ALL';
  document.getElementById('rtFTipo').value = 'ALL';
  rtApplyFilters();
}

function rtFiltered() {
  return rtRawData.filter(r => {
    if (RT_F.monedas.length && !RT_F.monedas.includes(r.moneda)) return false;
    if (!segMatch(r.segmento, RT_F.segmento)) return false;
    if (RT_F.tipo !== 'ALL' && r.tipo !== RT_F.tipo) return false;
    return true;
  });
}

function rtApplyFilters() {
  rtFilteredData = rtFiltered();
  rtUpdKPIs(rtFilteredData);
  rtUpdTramo(rtFilteredData);
  rtUpdIntraday(rtFilteredData);
  rtUpdMontos(rtFilteredData);
  rtUpdTasaTramo(rtFilteredData);
  rtUpdPies(rtFilteredData);
  rtUpdTable(rtFilteredData);
  rtUpdBubble(rtFilteredData);
}

// ── RT KPIs ───────────────────────────────────────────────────────────────────
function rtUpdKPIs(d) {
  const sumM  = d.reduce((s,r) => s+r.monto, 0);
  const sumTM = d.reduce((s,r) => s+r.tasa*r.monto, 0);
  const tasa  = sumM > 0 ? sumTM/sumM : NaN;
  document.getElementById('rtKTasa').textContent = isNaN(tasa) ? '—' : tasa.toFixed(2)+'%';
  document.getElementById('rtKOps').textContent  = d.length.toLocaleString('es-AR');
  document.getElementById('rtKMonto').textContent = fmtM(sumM);
  document.getElementById('rtKMon').textContent  = fmtM(sumM);
  // fecha del día
  const fechas = [...new Set(d.map(r=>r.date))].sort();
  document.getElementById('rtKFecha').textContent = fechas.length ? fmtDate(fechas[fechas.length-1]) : '—';
  // última operación (hora más alta)
  const horas = d.map(r=>r.hora).filter(Boolean).sort();
  const lastHora = horas.length ? horas[horas.length-1] : '—';
  document.getElementById('rtKHora').textContent = lastHora;
  document.getElementById('rtKFechaHora').textContent =
    fechas.length ? 'al ' + fmtDate(fechas[fechas.length-1]) : '—';
  // context tags
  const allMon = [...new Set(rtRawData.map(r=>r.moneda))].filter(Boolean);
  const allSel = RT_F.monedas.length >= allMon.length;
  const monLabel  = allSel ? 'Todas las monedas' : RT_F.monedas.map(m=>MON_LABELS[m]||m).join(' + ');
  const segLabel  = RT_F.segmento === 'ALL' ? 'Todos los segmentos' : segLbl(RT_F.segmento);
  const tipoLabel = RT_F.tipo     === 'ALL' ? 'Todos los instrumentos' : RT_F.tipo;
  const tags = [
    { text: monLabel,  color: allSel             ? '#B2B2B2' : '#E32D91' },
    { text: segLabel,  color: RT_F.segmento==='ALL' ? '#B2B2B2' : '#1A49C8' },
    { text: tipoLabel, color: RT_F.tipo==='ALL'     ? '#B2B2B2' : '#7B1FAE' },
  ];
  document.getElementById('rtKTasaTags').innerHTML = tags.map(t=>
    `<span class="kpi-tag" style="background:${t.color}18;color:${t.color};border:1px solid ${t.color}44">${t.text}</span>`
  ).join('');
}

// ── RT Tasa por Tramo (barras horizontales) ───────────────────────────────────
function rtUpdTramo(d) {
  const m = {};
  d.forEach(r => {
    if (!r.tramo) return;
    if (!m[r.tramo]) m[r.tramo] = { sM:0, sTM:0 };
    m[r.tramo].sM  += r.monto;
    m[r.tramo].sTM += r.tasa * r.monto;
  });
  const sorted = Object.entries(m).sort((a,b) => parseInt(a[0])-parseInt(b[0]));
  if (rtCharts.tramo) rtCharts.tramo.destroy();
  rtCharts.tramo = new Chart(document.getElementById('rtCTramo'), {
    type: 'bar',
    data: {
      labels: sorted.map(([t]) => t+' días'),
      datasets: [{
        label: 'Tasa pond.',
        data: sorted.map(([,v]) => v.sM>0 ? +(v.sTM/v.sM).toFixed(3) : null),
        backgroundColor: sorted.map(([t]) => TRAMO_COLORS[t] || '#B2B2B2'),
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false},
        tooltip:{callbacks:{label: ctx => ` ${ctx.raw?.toFixed(2)}%  ·  ${fmtM(sorted[ctx.dataIndex][1].sM)}`}} },
      scales: {
        x: { ticks:{callback:v=>v+'%',font:{size:10}}, grid:{color:'#f3f4f6'} },
        y: { grid:{display:false}, ticks:{font:{size:10}} }
      }
    }
  });
}

// ── RT Intraday: tasa ponderada acumulada por hora ────────────────────────────
function rtUpdIntraday(d) {
  // agrupar por hora (HH:MM → HH)
  const m = {};
  d.forEach(r => {
    if (!r.hora) return;
    const h = r.hora.slice(0,5); // HH:MM
    if (!m[h]) m[h] = { sM:0, sTM:0, ops:0 };
    m[h].sM  += r.monto;
    m[h].sTM += r.tasa * r.monto;
    m[h].ops++;
  });
  const sorted = Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0]));
  if (rtCharts.intraday) rtCharts.intraday.destroy();
  rtCharts.intraday = new Chart(document.getElementById('rtCIntraday'), {
    type: 'line',
    data: {
      labels: sorted.map(([h])=>h),
      datasets: [{
        label: 'Tasa pond.',
        data: sorted.map(([,v]) => v.sM>0 ? +(v.sTM/v.sM).toFixed(3) : null),
        borderColor: '#E32D91', backgroundColor: 'rgba(227,45,145,.08)',
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6,
        tension: 0.3, fill: true, spanGaps: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false},
        tooltip:{callbacks:{label: ctx => ` ${ctx.raw?.toFixed(2)}%`}} },
      scales: {
        x: { type:'category', grid:{display:false}, ticks:{font:{size:10}} },
        y: { grid:{color:'#f3f4f6'}, ticks:{callback:v=>v+'%',font:{size:10}} }
      }
    }
  });
}

// ── RT Monto por Hora ─────────────────────────────────────────────────────────
function rtUpdMontos(d) {
  const m = {};
  d.forEach(r => {
    if (!r.hora) return;
    const h = r.hora.slice(0,5);
    m[h] = (m[h]||0) + r.monto;
  });
  const sorted = Object.entries(m).sort((a,b)=>a[0].localeCompare(b[0]));
  const total = sorted.reduce((s,[,v])=>s+v,0);
  document.getElementById('rtMontSub').textContent = 'Total: '+fmtM(total);
  if (rtCharts.montos) rtCharts.montos.destroy();
  rtCharts.montos = new Chart(document.getElementById('rtCMontos'), {
    type: 'bar',
    data: {
      labels: sorted.map(([h])=>h),
      datasets: [{
        label: 'Monto',
        data: sorted.map(([,v]) => +(v/1e9).toFixed(3)),
        backgroundColor: 'rgba(26,73,200,.45)', borderColor:'#1A49C8',
        borderWidth:1, borderRadius:3
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false},
        tooltip:{callbacks:{label:ctx=>` ${ctx.raw.toFixed(1)} MM`}} },
      scales: {
        x: { type:'category', grid:{display:false}, ticks:{font:{size:10}} },
        y: { grid:{color:'#f3f4f6'},
          ticks:{callback:v=>v.toFixed(0)+' MM',font:{size:10}},
          title:{display:true,text:'Miles de millones ($)',font:{size:10}} }
      }
    }
  });
}

// ── RT Tasas por Tramo × Segmento ─────────────────────────────────────────────
function rtUpdTasaTramo(d) {
  const m = {};
  const tramoSet = new Set(), segSet = new Set();
  d.forEach(r => {
    if (!r.tramo || !r.segmento) return;
    tramoSet.add(r.tramo); segSet.add(r.segmento);
    if (!m[r.segmento]) m[r.segmento] = {};
    if (!m[r.segmento][r.tramo]) m[r.segmento][r.tramo] = {sM:0,sTM:0};
    m[r.segmento][r.tramo].sM  += r.monto;
    m[r.segmento][r.tramo].sTM += r.tasa*r.monto;
  });
  const tramos   = [...tramoSet].sort((a,b)=>parseInt(a)-parseInt(b));
  const segmentos = [...segSet].sort();
  const datasets = segmentos.map((seg,i) => ({
    label: seg,
    data: tramos.map(t => { const v=m[seg]?.[t]; return v&&v.sM>0?+(v.sTM/v.sM).toFixed(3):null; }),
    montoData: tramos.map(t => m[seg]?.[t]?.sM||0),
    borderColor: SEG_PALETTE[i%SEG_PALETTE.length],
    backgroundColor: 'transparent',
    pointBackgroundColor: SEG_PALETTE[i%SEG_PALETTE.length],
    borderWidth:2.2, pointRadius:5, pointHoverRadius:7, tension:0.25, spanGaps:false,
  }));
  if (rtCharts.tasaTramo) rtCharts.tasaTramo.destroy();
  rtCharts.tasaTramo = new Chart(document.getElementById('rtCTasaTramo'), {
    type:'line',
    data:{ labels: tramos.map(t=>t+' días'), datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{position:'top',labels:{font:{size:10},boxWidth:10,padding:10,usePointStyle:true}},
        tooltip:{callbacks:{label:ctx=>{
          if(ctx.raw===null) return null;
          const monto=ctx.dataset.montoData?.[ctx.dataIndex]??0;
          return ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%  ·  ${fmtM(monto)}`;
        }}}
      },
      scales:{
        x:{grid:{color:'#f3f4f6'},ticks:{font:{size:10}}},
        y:{grid:{color:'#f3f4f6'},ticks:{callback:v=>v+'%',font:{size:10}},
           title:{display:true,text:'TNA (%)',font:{size:10}}}
      }
    }
  });
}

// ── RT Pies ───────────────────────────────────────────────────────────────────
function rtUpdPies(d) {
  const mTipo={}, mMon={}, mSeg={};
  d.forEach(r => {
    if(r.tipo)    mTipo[r.tipo]    = (mTipo[r.tipo]||0)+r.monto;
    if(r.moneda)  mMon[r.moneda]   = (mMon[r.moneda]||0)+r.monto;
    if(r.segmento)mSeg[r.segmento] = (mSeg[r.segmento]||0)+r.monto;
  });
  const mk = (canvasId, key, entries, colors) => {
    if (rtCharts[key]) rtCharts[key].destroy();
    rtCharts[key] = new Chart(document.getElementById(canvasId), {
      type:'doughnut',
      data:{ labels: entries.map(([k])=>k), datasets:[{
        data: entries.map(([,v])=>v),
        backgroundColor: colors, borderColor:'#fff', borderWidth:2, hoverOffset:5
      }]},
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'58%',
        plugins:{
          legend:{position:'bottom',labels:{boxWidth:8,padding:8,font:{size:10},color:'#6b7280',usePointStyle:true}},
          tooltip:{callbacks:{label:ctx=>{
            const total=ctx.dataset.data.reduce((a,b)=>a+b,0);
            return ` ${ctx.label}: ${total>0?((ctx.raw/total)*100).toFixed(1):0}%  (${fmtM(ctx.raw)})`;
          }}}
        }
      }
    });
  };
  const tiposSorted = Object.entries(mTipo).sort((a,b)=>b[1]-a[1]);
  mk('rtCPieInst','pie_rtInst', tiposSorted, tiposSorted.map((_,i)=>TIPO_PALETTE[i%TIPO_PALETTE.length]));
  const monsSorted  = Object.entries(mMon).sort((a,b)=>b[1]-a[1]);
  mk('rtCPieMon','pie_rtMon',
    monsSorted.map(([k,v])=>[MON_LABELS[k]||k,v]),
    monsSorted.map(([k])=>MON_PALETTE[k]||'#B2B2B2'));
  const segsSorted  = Object.entries(mSeg).sort((a,b)=>b[1]-a[1]);
  mk('rtCPieSeg','pie_rtSeg', segsSorted.map(([k,v])=>[segLbl(k),v]), segsSorted.map((_,i)=>SEG_PALETTE[i%SEG_PALETTE.length]));
}

// ── RT Tabla operaciones ──────────────────────────────────────────────────────
function rtUpdTable(d) {
  // Cat chips
  const allCats = ['ALL',...d.reduce((s,r)=>{ s.add(r.categoria||'Sin clasificar'); return s;},new Set())];
  const chipsEl = document.getElementById('rtCatChips');
  if (chipsEl) {
    chipsEl.innerHTML = allCats.map(c=>{
      const col=c==='ALL'?'#6B7280':(CAT_COLORS[c]||'#94a3b8'), on=rtTblCat===c;
      return `<button onclick="rtTblCat='${c}';rtUpdTable(rtFilteredData)"
        style="padding:3px 10px;border-radius:20px;border:1px solid ${col};cursor:pointer;font-family:inherit;font-size:11px;
               background:${on?col:'transparent'};color:${on?'#fff':col};transition:all .15s">
        ${c==='ALL'?'Todas':c}</button>`;
    }).join('');
  }

  // Filtros
  let rows = [...d].sort((a,b)=>b.hora?.localeCompare(a.hora||''));
  if (rtTblCat !== 'ALL') rows = rows.filter(r=>(r.categoria||'Sin clasificar')===rtTblCat);
  if (rtTblSearch) rows = rows.filter(r=>r.empresa.toLowerCase().includes(rtTblSearch));

  document.getElementById('rtTblSub').textContent =
    `${rows.length} operación${rows.length!==1?'es':''} · ordenadas por hora (desc)`;

  document.getElementById('rtTEmp').innerHTML = rows.map((r,i)=>{
    const cat=r.categoria||'Sin clasificar', col=CAT_COLORS[cat]||'#94a3b8';
    return `<tr>
      <td style="color:var(--muted);width:24px">${i+1}</td>
      <td style="font-weight:600;color:#1A49C8">${r.hora||'—'}</td>
      <td style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.empresa}">${r.empresa||'—'}</td>
      <td><span class="bcat" style="background:${col}22;color:${col}">${cat}</span></td>
      <td style="color:var(--muted)">${r.tramo||'—'} días</td>
      <td style="color:var(--muted)">${segLbl(r.segmento)||'—'}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmtM(r.monto)}</td>
      <td style="text-align:right;color:#E32D91;font-weight:700">${r.tasa.toFixed(2)}%</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════════
// BUBBLE CHART – Curva de Tasas por Plazo
// ══════════════════════════════════════════════════════════════════════════════

let bubbleCat       = 'ALL';   // filtro categoría
let bubbleEmpresas  = [];      // [] = todas; array de nombres = sólo esas
let bubbleColorBy   = 'empresa'; // 'empresa' | 'categoria' | 'segmento'

// Convierte tramo "31-60" → midpoint 45 | "181+" → 200
function tramoMid(tramo) {
  if (!tramo) return 0;
  const s = tramo.replace(/\s/g,'').replace('+','');
  const p = s.split('-');
  if (p.length === 2) return (parseInt(p[0]) + parseInt(p[1])) / 2;
  return parseInt(p[0]) || 0;
}

// Paleta dinámica — cicla por los colores disponibles
const BUBBLE_PALETTE = [
  '#E32D91','#1A49C8','#7B1FAE','#22c55e','#f59e0b','#06b6d4',
  '#ef4444','#8b5cf6','#10b981','#f97316','#3b82f6','#ec4899',
  '#14b8a6','#a855f7','#eab308','#6366f1','#84cc16','#f43f5e',
];

function bubbleColorPalette(keys) {
  const map = {};
  keys.forEach((k, i) => { map[k] = BUBBLE_PALETTE[i % BUBBLE_PALETTE.length]; });
  return map;
}

// ── Categoría chips ───────────────────────────────────────────────────────────
// "_NG_TOTAL" = virtual: filtra segmento que contiene "No Garantizado"
const BUBBLE_VIRTUAL_CATS = [
  { id:'_G_TOTAL',  label:'Garantizado Total',    color:'#1A49C8',
    match: r => { const s=(r.segmento||'').toLowerCase(); return s.includes('garantizado') && !s.includes('no garantizado'); } },
  { id:'_NG_TOTAL', label:'No Garantizado Total', color:'#0ea5e9',
    match: r => (r.segmento||'').toLowerCase().includes('no garantizado') },
];

function bubbleRenderCatChips(d) {
  const knownCats = Object.keys(CAT_COLORS);
  const dataCats  = new Set(d.map(r => r.categoria).filter(c => c && knownCats.includes(c)));
  // Categorías reales con datos hoy
  const cats = ['ALL', ...knownCats.filter(c => dataCats.has(c))];
  // Virtuales con datos hoy
  const virtuals = BUBBLE_VIRTUAL_CATS.filter(v => d.some(v.match));
  const el = document.getElementById('bubbleCatChips');
  if (!el) return;
  const realChips = cats.map(c => {
    const col = c==='ALL' ? '#6B7280' : (CAT_COLORS[c]||'#94a3b8');
    const on  = bubbleCat === c;
    return `<button onclick="bubbleCat='${c}';rtUpdBubble(rtFilteredData)"
      style="padding:3px 10px;border-radius:20px;border:1px solid ${col};cursor:pointer;
             font-family:inherit;font-size:11px;
             background:${on?col:'transparent'};color:${on?'#fff':col};transition:all .15s">
      ${c==='ALL'?'Todas':c}</button>`;
  });
  const virtChips = virtuals.map(v => {
    const on = bubbleCat === v.id;
    return `<button onclick="bubbleCat='${v.id}';rtUpdBubble(rtFilteredData)"
      style="padding:3px 10px;border-radius:20px;border:1px solid ${v.color};cursor:pointer;
             font-family:inherit;font-size:11px;
             background:${on?v.color:'transparent'};color:${on?'#fff':v.color};transition:all .15s">
      ${v.label}</button>`;
  });
  el.innerHTML = [...realChips, ...virtChips].join('');
}

// ── Empresa selector ──────────────────────────────────────────────────────────
let _bubbleAllEmps = [];

function bubbleRenderEmpSelector(d) {
  _bubbleAllEmps = [...new Set(d.map(r=>r.empresa).filter(Boolean))].sort();
  bubbleRenderEmpChips();
  bubbleRenderEmpList('');
}

function bubbleRenderEmpChips() {
  const el = document.getElementById('bubbleEmpChips');
  if (!el) return;
  el.innerHTML = bubbleEmpresas.map(e =>
    `<span class="emp-chip">${e}
      <button onclick="bubbleRemoveEmp('${e.replace(/'/g,"\\'")}');event.stopPropagation()">×</button>
    </span>`
  ).join('');
  const cnt = document.getElementById('bubbleEmpCount');
  if (cnt) cnt.textContent = bubbleEmpresas.length
    ? `(${bubbleEmpresas.length} seleccionada${bubbleEmpresas.length>1?'s':''})`
    : '(todas)';
}

function bubbleRenderEmpList(query) {
  const el = document.getElementById('bubbleEmpList');
  if (!el) return;
  const q = query.toLowerCase();
  const filtered = q ? _bubbleAllEmps.filter(e=>e.toLowerCase().includes(q)) : _bubbleAllEmps;
  el.innerHTML = filtered.map(e => {
    const sel = bubbleEmpresas.includes(e);
    return `<label class="emp-opt ${sel?'selected':''}">
      <input type="checkbox" ${sel?'checked':''} onchange="bubbleToggleEmp('${e.replace(/'/g,"\\'")}',this.checked)">
      ${e}
    </label>`;
  }).join('');
}

function bubbleToggleDropdown() {
  const dd = document.getElementById('bubbleEmpDropdown');
  dd?.classList.toggle('open');
}
function bubbleOpenDropdown() {
  document.getElementById('bubbleEmpDropdown')?.classList.add('open');
}
function bubbleFilterDropdown(val) {
  bubbleRenderEmpList(val);
  document.getElementById('bubbleEmpDropdown')?.classList.add('open');
}
function bubbleToggleEmp(emp, checked) {
  if (checked && !bubbleEmpresas.includes(emp)) bubbleEmpresas.push(emp);
  else if (!checked) bubbleEmpresas = bubbleEmpresas.filter(e=>e!==emp);
  bubbleRenderEmpChips();
  rtUpdBubble(rtFilteredData);
}
function bubbleRemoveEmp(emp) {
  bubbleEmpresas = bubbleEmpresas.filter(e=>e!==emp);
  bubbleRenderEmpChips();
  bubbleRenderEmpList(document.getElementById('bubbleEmpInput')?.value||'');
  rtUpdBubble(rtFilteredData);
}
function bubbleSelectAll() {
  bubbleEmpresas = [..._bubbleAllEmps];
  bubbleRenderEmpChips();
  bubbleRenderEmpList(document.getElementById('bubbleEmpInput')?.value||'');
  rtUpdBubble(rtFilteredData);
}
function bubbleClearAll() {
  bubbleEmpresas = [];
  bubbleRenderEmpChips();
  bubbleRenderEmpList(document.getElementById('bubbleEmpInput')?.value||'');
  rtUpdBubble(rtFilteredData);
}
function bubbleSetColorBy(by) {
  bubbleColorBy = by;
  ['empresa','categoria','segmento'].forEach(k => {
    const b = document.getElementById('bcBy-'+k);
    if (!b) return;
    const on = k===by;
    b.style.background = on ? 'var(--pri)' : 'transparent';
    b.style.color      = on ? '#fff' : 'var(--muted)';
    b.style.borderColor= on ? 'var(--pri)' : 'var(--border)';
  });
  rtUpdBubble(rtFilteredData);
}

// Cerrar dropdown al clickear fuera
document.addEventListener('click', e => {
  const sel = document.getElementById('bubbleEmpSelector');
  if (sel && !sel.contains(e.target))
    document.getElementById('bubbleEmpDropdown')?.classList.remove('open');
});

// ── Main bubble chart renderer ────────────────────────────────────────────────
function rtUpdBubble(d) {
  bubbleRenderCatChips(d);
  bubbleRenderEmpSelector(d);

  // Filtros locales al bubble
  let rows = d;
  if (bubbleCat !== 'ALL') {
    const virt = BUBBLE_VIRTUAL_CATS.find(v => v.id === bubbleCat);
    if (virt) rows = rows.filter(virt.match);
    else rows = rows.filter(r => (r.categoria||'Sin clasificar') === bubbleCat);
  }
  if (bubbleEmpresas.length) rows = rows.filter(r=>bubbleEmpresas.includes(r.empresa));

  // Agregar: groupKey × tramo → {sM, sTM}
  const getKey = r => {
    if (bubbleColorBy==='empresa')   return r.empresa || 'Sin empresa';
    if (bubbleColorBy==='categoria') return r.categoria || 'Sin clasificar';
    return segLbl(r.segmento) || 'Sin segmento';
  };

  const agg = {};
  rows.forEach(r => {
    if (!r.tramo) return;
    const key   = getKey(r);
    const tramo = r.tramo;
    const k     = key + '||' + tramo;
    if (!agg[k]) agg[k] = { key, tramo, sM:0, sTM:0 };
    agg[k].sM  += r.monto;
    agg[k].sTM += r.tasa * r.monto;
  });

  // Obtener todas las keys (empresas/cats/segs) para asignar colores
  const allKeys = [...new Set(Object.values(agg).map(v=>v.key))].sort();
  const colorMap = bubbleColorBy==='categoria'
    ? Object.fromEntries(allKeys.map(k=>[k, CAT_COLORS[k]||'#94a3b8']))
    : bubbleColorBy==='segmento'
    ? Object.fromEntries(allKeys.map((k,i)=>[k, SEG_PALETTE[i%SEG_PALETTE.length]]))
    : bubbleColorPalette(allKeys);

  // Normalizar radios: sqrt(monto), máx = 30px
  const maxMonto = Math.max(...Object.values(agg).map(v=>v.sM), 1);
  const scaleR   = v => Math.max(4, Math.sqrt(v.sM / maxMonto) * 30);

  // Un dataset por key para que la leyenda funcione
  const datasets = allKeys.map(key => {
    const pts = Object.values(agg)
      .filter(v => v.key === key && v.sM > 0)
      .map(v => ({
        x: tramoMid(v.tramo),
        y: +(v.sTM / v.sM).toFixed(3),
        r: scaleR(v),
        _monto: v.sM,
        _tramo: v.tramo,
        _key:   key,
      }));
    const col = colorMap[key] || '#B2B2B2';
    return {
      label: key,
      data:  pts,
      backgroundColor: col + 'aa',
      borderColor:     col,
      borderWidth: 1.5,
    };
  }).filter(ds => ds.data.length > 0);

  document.getElementById('bubbleSub').textContent =
    `${rows.length} operaciones · ${allKeys.length} ${bubbleColorBy==='empresa'?'empresa':'grupo'}${allKeys.length!==1?'s':''}`;

  if (rtCharts.bubble) rtCharts.bubble.destroy();
  rtCharts.bubble = new Chart(document.getElementById('rtCBubble'), {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode:'point', intersect:true },
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth:10, padding:10, font:{size:11}, usePointStyle:true,
            // Si hay muchas empresas, limitar leyenda
            filter: (_, data) => data.datasets.length <= 20
          }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const p = ctx.raw;
              return [
                ` ${p._key}`,
                ` Tramo: ${p._tramo} días`,
                ` Tasa:  ${p.y.toFixed(2)}%`,
                ` Monto: ${fmtM(p._monto)}`,
              ];
            }
          }
        }
      },
      scales: {
        x: {
          title: { display:true, text:'Plazo (días)', font:{size:11} },
          ticks: { font:{size:10}, callback: v => Math.round(v)+' d' },
          grid:  { color:'#f3f4f6' },
          min: 0,
        },
        y: {
          title: { display:true, text:'Tasa Ponderada TNA (%)', font:{size:11} },
          ticks: { callback: v => (+v).toFixed(2)+'%', font:{size:10}, maxTicksLimit: 8 },
          grid:  { color:'#f3f4f6' },
          min: 0,
        }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  PESTAÑA EMPRESAS
// ══════════════════════════════════════════════════════════════════

let empMain      = null;   // empresa principal (string o null)
let empCmpList   = [];     // empresas de comparación (array)
let empAllNames  = [];
let empChartVenc         = null;
let empChartMontos       = null;
let empChartCompradorBar = null;
let empChartVendedorBar  = null;
let empChartPieMon  = null;
let empChartPieInst = null;
let empChartPieTasa = null;
let empOpRows    = [];
let empInstrFilter = 'ALL';
let empMonedas   = [];     // [] = todas; igual que F.monedas en Histórico

const EMP_PALETTE = [
  '#E32D91','#7B1FAE','#3B6FE8','#C01070','#6B93F0',
  '#F06AB8','#0D2E7A','#8B0050','#9BB8F7','#4B2080',
];
const EMP_MAIN_COLOR = '#1A49C8';

// ── Init ──────────────────────────────────────────────────────────
function initEmpTab() {
  if (!rawData.length) return;
  empAllNames = [...new Set(rawData.map(r => r.empresa).filter(Boolean))].sort();

  // Moneda buttons (multi-select, igual que Histórico)
  const monedas = [...new Set(rawData.map(r => r.moneda).filter(Boolean))].sort();
  if (!empMonedas.length) empMonedas = [monedas.includes('$') ? '$' : monedas[0]];
  const wrap = document.getElementById('empMonWrap');
  if (wrap) {
    wrap.innerHTML = '';
    monedas.forEach(m => {
      const b = document.createElement('button');
      b.className = 'mon-btn' + (empMonedas.includes(m) ? ' on' : '');
      b.dataset.v = m;
      b.textContent = MON_LABELS[m] || m;
      b.onclick = function() { empSetMon(this); };
      wrap.appendChild(b);
    });
  }

  // Segmento select
  const segmentos = [...new Set(rawData.map(r => r.segmento).filter(Boolean))].sort();
  const fSeg = document.getElementById('empSegmento');
  if (fSeg) {
    fSeg.innerHTML = '<option value="ALL">Todos</option>';
    segmentos.forEach(s => fSeg.add(new Option(segLbl(s), s)));
  }

  const dates = rawData.map(r => r.date).sort();
  const elDesde = document.getElementById('empDesde');
  const elHasta = document.getElementById('empHasta');
  if (elDesde) elDesde.value = dates[0] || '';
  if (elHasta) elHasta.value = dates[dates.length - 1] || '';
  renderEmpMainDrop('');
  renderEmpCmpDrop('');
}

function empSetMon(btn) {
  const v = btn.dataset.v;
  const i = empMonedas.indexOf(v);
  if (i >= 0) { if (empMonedas.length > 1) empMonedas.splice(i, 1); }
  else empMonedas.push(v);
  document.querySelectorAll('#empMonWrap .mon-btn').forEach(b =>
    b.classList.toggle('on', empMonedas.includes(b.dataset.v))
  );
  renderEmp();
}

// ── Dropdown empresa principal (single select) ─────────────────────
function focusEmpMainInput() { document.getElementById('empMainTextIn').focus(); }
function openEmpMainDrop()   { document.getElementById('empMainDd').classList.add('open'); }
function closeEmpMainDrop()  { document.getElementById('empMainDd').classList.remove('open'); }
function filterEmpMainDrop(q){ openEmpMainDrop(); renderEmpMainDrop(q); }

function renderEmpMainDrop(q) {
  const dd  = document.getElementById('empMainDd');
  const lcq = q.toLowerCase();
  const hits = empAllNames.filter(n => n.toLowerCase().includes(lcq));
  if (!hits.length) { dd.innerHTML = '<div class="emp-dd-none">Sin coincidencias</div>'; return; }
  dd.innerHTML = hits.map(n => {
    const sel = empMain === n;
    return `<div class="emp-dd-item ${sel?'sel':''}" onclick="selectEmpMain('${n.replace(/'/g,"\\'")}')">
      ${sel ? '✓ ' : ''} ${n}
    </div>`;
  }).join('');
}

function selectEmpMain(name) {
  empMain = empMain === name ? null : name;
  // Quitar de comparación si estaba ahí
  empCmpList = empCmpList.filter(n => n !== name);
  renderEmpMainChip();
  renderEmpCmpChips();
  renderEmpMainDrop(document.getElementById('empMainTextIn').value);
  renderEmpCmpDrop(document.getElementById('empCmpTextIn').value);
  renderEmp();
}

function renderEmpMainChip() {
  const wrap  = document.getElementById('empMainInput');
  const input = document.getElementById('empMainTextIn');
  wrap.querySelectorAll('.emp-chip2').forEach(c => c.remove());
  if (empMain) {
    const chip = document.createElement('div');
    chip.className = 'emp-chip2';
    chip.style.background = EMP_MAIN_COLOR + '22';
    chip.style.color       = EMP_MAIN_COLOR;
    chip.innerHTML = `${empMain}<button onclick="selectEmpMain('${empMain.replace(/'/g,"\\'")}')" title="Quitar">×</button>`;
    wrap.insertBefore(chip, input);
  }
  input.placeholder = empMain ? '' : 'Buscar empresa…';
}

// ── Dropdown empresas de comparación (multi select) ────────────────
function focusEmpCmpInput() { document.getElementById('empCmpTextIn').focus(); }
function openEmpCmpDrop()   { document.getElementById('empCmpDd').classList.add('open'); }
function closeEmpCmpDrop()  { document.getElementById('empCmpDd').classList.remove('open'); }
function filterEmpCmpDrop(q){ openEmpCmpDrop(); renderEmpCmpDrop(q); }

function renderEmpCmpDrop(q) {
  const dd  = document.getElementById('empCmpDd');
  const lcq = q.toLowerCase();
  // Excluir la empresa principal del listado de comparación
  const hits = empAllNames.filter(n => n !== empMain && n.toLowerCase().includes(lcq));
  if (!hits.length) { dd.innerHTML = '<div class="emp-dd-none">Sin coincidencias</div>'; return; }
  dd.innerHTML = hits.map(n => {
    const sel = empCmpList.includes(n);
    return `<div class="emp-dd-item ${sel?'sel':''}" onclick="toggleEmpCmp('${n.replace(/'/g,"\\'")}')">
      <input type="checkbox" ${sel?'checked':''} style="accent-color:var(--pri)"> ${n}
    </div>`;
  }).join('');
}

function toggleEmpCmp(name) {
  if (empCmpList.includes(name)) empCmpList = empCmpList.filter(n => n !== name);
  else empCmpList.push(name);
  renderEmpCmpChips();
  renderEmpCmpDrop(document.getElementById('empCmpTextIn').value);
  renderEmp();
}

function renderEmpCmpChips() {
  const wrap  = document.getElementById('empCmpInput');
  const input = document.getElementById('empCmpTextIn');
  wrap.querySelectorAll('.emp-chip2').forEach(c => c.remove());
  empCmpList.forEach((n, i) => {
    const chip = document.createElement('div');
    chip.className = 'emp-chip2';
    chip.style.background = EMP_PALETTE[(i + 1) % EMP_PALETTE.length] + '22';
    chip.style.color       = EMP_PALETTE[(i + 1) % EMP_PALETTE.length];
    chip.innerHTML = `${n}<button onclick="toggleEmpCmp('${n.replace(/'/g,"\\'")}')" title="Quitar">×</button>`;
    wrap.insertBefore(chip, input);
  });
  input.placeholder = empCmpList.length ? '' : 'Agregar empresas…';
}

// ── Filtro instrumento ──────────────────────────────────────────────
function setEmpInstr(btn) {
  document.querySelectorAll('#empInstrToggle .instr-btn').forEach(b =>
    b.classList.toggle('on', b === btn)
  );
  empInstrFilter = btn.dataset.inst;
  renderEmp();
}

// ── Render principal ────────────────────────────────────────────────
let _empLastData = [];

function renderEmp() {
  const empty = document.getElementById('empEmpty');
  const kpis  = document.getElementById('empKpis');
  if (!empMain) { empty.style.display = ''; kpis.style.display = 'none'; return; }
  empty.style.display = 'none'; kpis.style.display = '';

  const desde    = document.getElementById('empDesde')?.value    || '';
  const hasta    = document.getElementById('empHasta')?.value    || '';
  const segmento = document.getElementById('empSegmento')?.value || 'ALL';

  const allEmps = [empMain, ...empCmpList];
  const empInstrMatch = tipo => {
    const t = (tipo || '').toLowerCase();
    if (empInstrFilter === 'PAG') return t.includes('pagar');
    if (empInstrFilter === 'FCE') return t.includes('fce');
    if (empInstrFilter === 'CPD') return !t.includes('pagar') && !t.includes('fce');
    return true;
  };
  const data = rawData.filter(r =>
    allEmps.includes(r.empresa) &&
    (!desde || r.date >= desde) &&
    (!hasta || r.date <= hasta) &&
    (!empMonedas.length || empMonedas.includes(r.moneda)) &&
    empInstrMatch(r.tipo) &&
    (segmento === 'ALL' || segMatch(r.segmento, segmento))
  );
  _empLastData = data;

  const mainData = data.filter(r => r.empresa === empMain);
  const cmpData  = data.filter(r => empCmpList.includes(r.empresa));

  renderEmpKpis(mainData, cmpData);
  renderEmpComparativo(data);
  renderEmpPies(mainData);
  renderEmpVencimientos(data);
  renderEmpMontos(data);
  renderEmpVendedor(data);
  renderEmpComprador(data);
  renderEmpTramos(mainData);
  empOpRows = data;
  // Poblar selects de agente con los valores presentes en los datos filtrados
  ['empOpVendedor','empOpComprador'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const field = id === 'empOpVendedor' ? 'vendedor' : 'comprador';
    const cur = sel.value;
    const vals = [...new Set(data.map(r => r[field]).filter(v => v && v !== 'sin datos'))].sort();
    sel.innerHTML = `<option value="ALL">${id === 'empOpVendedor' ? 'Ag. Vendedor' : 'Ag. Comprador'}</option>`;
    vals.forEach(v => sel.add(new Option(v, v)));
    sel.value = vals.includes(cur) ? cur : 'ALL';
  });
  renderEmpOpTable();
}

// ── KPI cards (empresa principal) ──────────────────────────────────
function renderEmpKpis(mainData, cmpData) {
  const grid = document.getElementById('empKpiGrid');
  grid.innerHTML = '';
  const m = mainData.reduce((s,r)=>s+r.monto,0);
  const t = mainData.reduce((s,r)=>s+r.tasa*r.monto,0)/(m||1);
  const ppvD = mainData.filter(r=>!isNaN(r.ppv)&&r.ppv>0);
  const p = ppvD.reduce((s,r)=>s+r.ppv*r.monto,0)/(ppvD.reduce((s,r)=>s+r.monto,0)||1);
  // Promedio ponderado de las empresas de comparación
  const cm = cmpData.reduce((s,r)=>s+r.monto,0);
  const ct = cmpData.reduce((s,r)=>s+r.tasa*r.monto,0)/(cm||1);

  const cards = [
    { lbl:'Monto Total',         val: fmtM(m),                                       sub: `${mainData.length} operaciones`,          color: EMP_MAIN_COLOR },
    { lbl:'Tasa Pond. (TNA)',    val: t.toFixed(2)+'%',                              sub: 'ponderada por monto',                    color: '#E32D91'      },
    { lbl:'PPV Pond.',           val: isFinite(p)?Math.round(p)+' días':'—',         sub: 'plazo ponderado por monto',              color: '#7B1FAE'      },
  ];
  if (empCmpList.length) {
    cards.push({ lbl:'Tasa Pond. comparación', val: cm>0?ct.toFixed(2)+'%':'—', sub: `promedio de ${empCmpList.length} empresa${empCmpList.length>1?'s':''}`, color:'#22c55e' });
  }
  cards.forEach(k => {
    const d = document.createElement('div');
    d.className = 'emp-kpi'; d.style.borderLeftColor = k.color;
    d.innerHTML = `<div class="emp-kpi-lbl">${k.lbl}</div><div class="emp-kpi-val">${k.val}</div><div class="emp-kpi-sub">${k.sub}</div>`;
    grid.appendChild(d);
  });
}

// ── Tabla comparativa ────────────────────────────────────────────────
function renderEmpComparativo(data) {
  const row = document.getElementById('empCmpRow');
  if (!empCmpList.length) { row.style.display = 'none'; return; }
  row.style.display = '';

  const allEmps = [empMain, ...empCmpList];
  const tramos  = [...new Set(data.map(r=>r.tramo).filter(Boolean))]
    .sort((a,b) => parseInt(a) - parseInt(b));

  document.getElementById('empCmpTtl').textContent =
    `${empMain} vs. ${empCmpList.length > 1 ? empCmpList.length+' empresas' : empCmpList[0]}`;
  document.getElementById('empCmpHead').innerHTML = `<tr>
    <th>Empresa</th><th>Monto Total</th><th>Tasa Pond.</th><th>PPV Pond.</th><th>Ops.</th>
    ${tramos.map(t=>`<th>${t} d</th>`).join('')}
  </tr>`;

  const stats = allEmps.map((emp, i) => {
    const ed = data.filter(r=>r.empresa===emp);
    const mo = ed.reduce((s,r)=>s+r.monto,0);
    const ta = ed.reduce((s,r)=>s+r.tasa*r.monto,0)/(mo||1);
    const pd = ed.filter(r=>!isNaN(r.ppv)&&r.ppv>0);
    const pp = pd.reduce((s,r)=>s+r.ppv*r.monto,0)/(pd.reduce((s,r)=>s+r.monto,0)||1);
    // Tasa ponderada por tramo + acumuladores para el footer
    const tm     = {}; // tasa ponderada (para display)
    const tm_raw = {}; // {sM, sTM} para ponderar el footer
    tramos.forEach(t => {
      const rows = ed.filter(r => r.tramo === t);
      const sM   = rows.reduce((s,r) => s+r.monto, 0);
      const sTM  = rows.reduce((s,r) => s+r.tasa*r.monto, 0);
      tm[t]     = sM > 0 ? sTM / sM : null; // null → sin datos
      tm_raw[t] = { sM, sTM };
    });
    const color = i === 0 ? EMP_MAIN_COLOR : EMP_PALETTE[i % EMP_PALETTE.length];
    const label = i === 0 ? `★ ${emp}` : emp;
    return { emp, label, mo, ta, pp, ops:ed.length, tm, tm_raw, color };
  });

  document.getElementById('empCmpBody').innerHTML = stats.map(r=>`<tr>
    <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${r.color};margin-right:6px"></span>${r.label}</td>
    <td>${fmtM(r.mo)}</td><td>${r.mo>0?r.ta.toFixed(2)+'%':'—'}</td>
    <td>${isFinite(r.pp)&&r.pp>0?Math.round(r.pp)+' d':'—'}</td><td>${r.ops||0}</td>
    ${tramos.map(t=>`<td>${r.tm[t]!==null?r.tm[t].toFixed(2)+'%':'—'}</td>`).join('')}
  </tr>`).join('');

  // Promedio ponderado SOLO de las empresas de comparación
  const cmpStats = stats.slice(1);
  const tot  = cmpStats.reduce((s,r)=>s+r.mo,0);
  const totT = cmpStats.reduce((s,r)=>s+r.ta*r.mo,0)/(tot||1);
  const totP = cmpStats.reduce((s,r)=>s+(isFinite(r.pp)?r.pp:0)*r.mo,0)/(tot||1);
  // Tasa ponderada por tramo del grupo de comparación
  const totTm = {};
  tramos.forEach(t => {
    const sM  = cmpStats.reduce((s,r)=>s+(r.tm_raw[t]?.sM  || 0), 0);
    const sTM = cmpStats.reduce((s,r)=>s+(r.tm_raw[t]?.sTM || 0), 0);
    totTm[t] = sM > 0 ? sTM / sM : null;
  });
  document.getElementById('empCmpFoot').innerHTML = `<tr>
    <td>Prom. pond. comparación</td><td>${fmtM(tot)}</td><td>${tot>0?totT.toFixed(2)+'%':'—'}</td>
    <td>${tot>0&&isFinite(totP)&&totP>0?Math.round(totP)+' d':'—'}</td><td>${cmpStats.reduce((s,r)=>s+r.ops,0)}</td>
    ${tramos.map(t=>`<td>${totTm[t]!==null?totTm[t].toFixed(2)+'%':'—'}</td>`).join('')}
  </tr>`;
}

// ── Pies: moneda e instrumento (empresa principal) ──────────────────
function renderEmpPies(data) {
  // Por moneda
  const byMon = {};
  data.forEach(r=>{ byMon[r.moneda]=(byMon[r.moneda]||0)+r.monto; });
  const monLabels = Object.keys(byMon);
  const monData   = monLabels.map(k=>byMon[k]);
  const monColors = monLabels.map((_,i)=>EMP_PALETTE[i%EMP_PALETTE.length]);

  if (empChartPieMon) empChartPieMon.destroy();
  empChartPieMon = makePie('empCPieMon',
    monLabels.map(k=>MON_LABELS[k]||k), monData, monColors);

  // Por instrumento
  const byInst = {};
  data.forEach(r=>{ const t=r.tipo||'Otro'; byInst[t]=(byInst[t]||0)+r.monto; });
  const instLabels = Object.keys(byInst).sort((a,b)=>byInst[b]-byInst[a]);
  const instData   = instLabels.map(k=>byInst[k]);
  const instColors = instLabels.map((_,i)=>EMP_PALETTE[i%EMP_PALETTE.length]);

  if (empChartPieInst) empChartPieInst.destroy();
  empChartPieInst = makePie('empCPieInst', instLabels, instData, instColors);
}

// ── Resumen por instrumento (agrupado en Garantizado Total / No Garantizado Total) ──
function renderEmpInstr(data) {
  // Clasifica cada fila en uno de los dos grupos virtuales
  const isGar  = r => { const s=(r.segmento||'').toLowerCase(); return s.includes('avalado') || (s.includes('garantizado') && !s.includes('no garantizado')); };
  const isNoGar= r => (r.segmento||'').toLowerCase().includes('no garantizado');

  const GROUPS = [
    { key:'_G_TOTAL',  label:'Garantizado Total',    match: isGar   },
    { key:'_NG_TOTAL', label:'No Garantizado Total',  match: isNoGar },
  ];

  // Agrega por grupo+moneda
  const byGroup = {};
  GROUPS.forEach(g => { byGroup[g.key] = {}; });

  data.forEach(r => {
    const grp = GROUPS.find(g => g.match(r));
    if (!grp) return;
    const mon = r.moneda || 'Sin moneda';
    if (!byGroup[grp.key][mon]) byGroup[grp.key][mon] = { sM:0, sTM:0, tramos:{} };
    byGroup[grp.key][mon].sM  += r.monto;
    byGroup[grp.key][mon].sTM += r.tasa * r.monto;
    const t = r.tramo || '—';
    byGroup[grp.key][mon].tramos[t] = (byGroup[grp.key][mon].tramos[t] || 0) + r.monto;
  });

  let html = '';
  GROUPS.forEach(g => {
    const monRows = Object.entries(byGroup[g.key]);
    if (!monRows.length) return;
    const groupTotal = monRows.reduce((s, [, v]) => s + v.sM, 0);
    html += `<tr class="seg-hdr"><td colspan="6">${g.label}<span>${fmtM(groupTotal)}</span></td></tr>`;
    monRows.sort((a, b) => b[1].sM - a[1].sM).forEach(([mon, row]) => {
      const tna = row.sM > 0 ? row.sTM / row.sM : 0;
      const tem = tna / 12;
      const tea = (Math.pow(1 + tna / 100 / 12, 12) - 1) * 100;
      const majorTramo = Object.entries(row.tramos).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
      html += `<tr>
        <td style="padding-left:22px;color:var(--muted);font-size:12px">${MON_LABELS[mon]||mon}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtN(row.sM)}</td>
        <td style="text-align:center;font-weight:600">${majorTramo} días</td>
        <td style="text-align:right;color:#E32D91;font-weight:700">${tea.toFixed(2)}%</td>
        <td style="text-align:right;font-weight:600">${tem.toFixed(2)}%</td>
        <td style="text-align:right;font-weight:700;color:var(--pri)">${tna.toFixed(2)}%</td>
      </tr>`;
    });
  });
  if (!html) html = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">Sin datos</td></tr>';
  document.getElementById('empTInstr').innerHTML = html;
}

// ── Vencimientos por mes ────────────────────────────────────────────
function fmtMesLabel(mesStr) {
  if (!mesStr) return '';
  const [y, m] = mesStr.split('-');
  return new Date(+y, +m-1, 1).toLocaleDateString('es-AR', {month:'long', year:'numeric'});
}

function renderEmpVencimientos(data) {
  const allEmps = [empMain, ...empCmpList];
  const now = new Date();
  const mesCur = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');

  // Calcular vencimientos proyectados (fecha emisión + PPV)
  const byMes = {};
  data.forEach(r => {
    if (isNaN(r.ppv)||r.ppv<=0) return;
    const vto = new Date(r.date+'T00:00:00');
    vto.setDate(vto.getDate()+Math.round(r.ppv));
    const k = vto.getFullYear()+'-'+String(vto.getMonth()+1).padStart(2,'0');
    if (k < mesCur) return; // solo desde hoy en adelante
    if (!byMes[k]) byMes[k]={};
    byMes[k][r.empresa]=(byMes[k][r.empresa]||0)+r.monto;
  });

  const futureMeses = Object.keys(byMes).sort();
  if (!futureMeses.length) {
    if (empChartVenc){ empChartVenc.destroy(); empChartVenc=null; }
    document.getElementById('empVncSub').textContent = 'Sin vencimientos proyectados desde hoy';
    return;
  }

  // Range: desde mes actual hasta último mes con datos
  const range = [];
  let cur = new Date(mesCur+'-01T00:00:00');
  const end = new Date(futureMeses[futureMeses.length-1]+'-01T00:00:00');
  while (cur <= end) {
    range.push(cur.getFullYear()+'-'+String(cur.getMonth()+1).padStart(2,'0'));
    cur = new Date(cur.getFullYear(), cur.getMonth()+1, 1);
  }

  const datasets = allEmps.map((emp,i) => {
    const baseColor = i===0 ? EMP_MAIN_COLOR : EMP_PALETTE[i%EMP_PALETTE.length];
    return {
      label: emp,
      data: range.map(m => (byMes[m]?.[emp]||0)/1e9),
      backgroundColor: baseColor+'cc',
      borderColor: baseColor,
      borderWidth: 1,
    };
  });

  if (empChartVenc) empChartVenc.destroy();
  empChartVenc = new Chart(document.getElementById('empCVenc'), {
    type:'bar', data:{ labels: range.map(fmtMesLabel), datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{ position:'top', labels:{boxWidth:10,font:{size:11}} },
        tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(1)} MM` } }
      },
      scales:{
        x:{ stacked:true, ticks:{font:{size:10},maxRotation:45}, grid:{display:false} },
        y:{ stacked:true,
            title:{display:true,text:'Miles de millones ($)',font:{size:11}},
            ticks:{callback:v=>'$'+v+' MM',font:{size:10}},
            grid:{color:'#f3f4f6'} }
      }
    }
  });

  // Subtítulo: total proyectado
  const total = Object.values(byMes).flatMap(Object.values).reduce((a,b)=>a+b,0);
  document.getElementById('empVncSub').textContent =
    `Vencimientos proyectados: ${fmtM(total)} · hasta ${fmtMesLabel(futureMeses[futureMeses.length-1])}`;
}

// ── Montos emitidos por fecha (pestaña Empresas) ────────────────────
function renderEmpMontos(data) {
  const allEmps = [empMain, ...empCmpList];

  // Acumular monto por fecha × empresa
  const byDate = {};
  data.forEach(r => {
    if (!r.date || !r.empresa) return;
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][r.empresa] = (byDate[r.date][r.empresa] || 0) + r.monto;
  });

  const dates = Object.keys(byDate).sort();
  const subEl = document.getElementById('empMontSub');
  if (empChartMontos) { empChartMontos.destroy(); empChartMontos = null; }
  if (!dates.length) { if (subEl) subEl.textContent = 'Sin datos'; return; }

  const total = data.reduce((s, r) => s + r.monto, 0);
  if (subEl) subEl.textContent = 'Total: ' + fmtM(total);

  const labels = dates.map(fmtDate);
  const datasets = allEmps.map((emp, i) => {
    const baseColor = i === 0 ? EMP_MAIN_COLOR : EMP_PALETTE[i % EMP_PALETTE.length];
    return {
      label: emp,
      data: dates.map(d => +((byDate[d]?.[emp] || 0) / 1e9).toFixed(3)),
      backgroundColor: baseColor + 'cc',
      borderColor: baseColor,
      borderWidth: 1,
      stack: 'montos',
    };
  });

  empChartMontos = new Chart(document.getElementById('empCMontos'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(1)} MM` } }
      },
      scales: {
        x: { stacked: true, type: 'category', grid: { display: false },
             ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 20 } },
        y: { stacked: true, grid: { color: '#f3f4f6' },
             ticks: { callback: v => v.toFixed(0) + ' MM', font: { size: 10 } },
             title: { display: true, text: 'Miles de millones ($)', font: { size: 11 } } }
      }
    }
  });
}

// ── Distribución por Agente (genérico: comprador o vendedor) ────────
const COMP_PIE_COLORS = ['#1A49C8','#E32D91','#3B6FE8','#C01070','#6B93F0','#F06AB8','#0D2E7A','#8B0050','#B2B2B2','#6B7280','#4B5563','#191919','#9BB8F7','#7B1FAE','#4B2080'];

function renderEmpAgente(data, campo, pieId, barId, barChartRef, setter) {
  const totByAgente = {};
  data.forEach(r => {
    const c = r[campo] || 'sin datos';
    totByAgente[c] = (totByAgente[c] || 0) + r.monto;
  });
  const sorted = Object.entries(totByAgente).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return;

  // Pie: top 10 + Otros
  const TOP_PIE = 10;
  const topPie  = sorted.slice(0, TOP_PIE);
  const otrosV  = sorted.slice(TOP_PIE).reduce((s, [, v]) => s + v, 0);
  if (otrosV > 0) topPie.push(['Otros', otrosV]);
  makePie(
    pieId,
    topPie.map(([k]) => k),
    topPie.map(([, v]) => +(v / 1e9).toFixed(3)),
    topPie.map((_, i) => COMP_PIE_COLORS[i] || '#94a3b8')
  );

  // Bar horizontal: top 15, apilado por empresa
  const TOP_BAR  = 15;
  const top15    = sorted.slice(0, TOP_BAR).map(([k]) => k);
  const allEmps  = [empMain, ...empCmpList];
  const byEmpAge = {};
  data.forEach(r => {
    if (!top15.includes(r[campo])) return;
    if (!byEmpAge[r.empresa]) byEmpAge[r.empresa] = {};
    byEmpAge[r.empresa][r[campo]] = (byEmpAge[r.empresa][r[campo]] || 0) + r.monto;
  });

  const barDatasets = allEmps.map((emp, i) => {
    const color = i === 0 ? EMP_MAIN_COLOR : EMP_PALETTE[i % EMP_PALETTE.length];
    return {
      label: emp,
      data: top15.map(ag => +((byEmpAge[emp]?.[ag] || 0) / 1e9).toFixed(3)),
      backgroundColor: color + 'cc',
      borderColor: color,
      borderWidth: 1,
      stack: 'ag',
    };
  });

  if (barChartRef) barChartRef.destroy();
  const chart = new Chart(document.getElementById(barId), {
    type: 'bar',
    data: { labels: top15, datasets: barDatasets },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.x.toFixed(1)} MM` } }
      },
      scales: {
        x: { stacked: true, grid: { color: '#f3f4f6' },
             ticks: { callback: v => v.toFixed(0) + ' MM', font: { size: 10 } },
             title: { display: true, text: 'Miles de millones ($)', font: { size: 11 } } },
        y: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
  setter(chart);
}

function renderEmpVendedor(data) {
  renderEmpAgente(data, 'vendedor', 'empCVendedorPie', 'empCVendedorBar',
    empChartVendedorBar, c => { empChartVendedorBar = c; });
}

function renderEmpComprador(data) {
  renderEmpAgente(data, 'comprador', 'empCCompradorPie', 'empCCompradorBar',
    empChartCompradorBar, c => { empChartCompradorBar = c; });
}

// ── Distribución por tramo (empresa principal) ──────────────────────
function renderEmpTramos(data) {
  const wrap=document.getElementById('empTramoWrap');
  const total=data.reduce((s,r)=>s+r.monto,0);
  const tm={};
  data.forEach(r=>{tm[r.tramo]=(tm[r.tramo]||0)+r.monto;});
  wrap.innerHTML='<div class="tramo-bar-wrap">'+
    Object.entries(tm).sort((a,b)=>b[1]-a[1]).map(([t,mo])=>{
      const pct=total?(mo/total*100):0;
      return `<div class="tramo-bar-row">
        <span class="tramo-bar-lbl">${t} d</span>
        <div class="tramo-bar-bg"><div class="tramo-bar-fill" style="width:${pct.toFixed(1)}%;background:${TRAMO_COLORS[t]||'var(--pri)'}"></div></div>
        <span class="tramo-bar-pct">${pct.toFixed(1)}%</span></div>`;
    }).join('')+'</div>';
}

// ── Tabla detalle operaciones ────────────────────────────────────────
function renderEmpOpTable() {
  const q=(document.getElementById('empOpSearch').value||'').toLowerCase();
  const fVend=(document.getElementById('empOpVendedor')?.value||'ALL');
  const fComp=(document.getElementById('empOpComprador')?.value||'ALL');
  const allEmps=[empMain,...empCmpList];
  const rows=empOpRows.filter(r=>
    (!q||r.empresa.toLowerCase().includes(q)||r.tipo.toLowerCase().includes(q)||r.moneda.toLowerCase().includes(q)||(r.tramo||'').toLowerCase().includes(q))&&
    (fVend==='ALL'||r.vendedor===fVend)&&
    (fComp==='ALL'||r.comprador===fComp)
  ).sort((a,b)=>{
    const d=(b.date||'').localeCompare(a.date||'');
    return d!==0?d:b.monto-a.monto;
  });
  document.getElementById('empOpCount').textContent=`${rows.length} operaciones`;
  document.getElementById('empOpBody').innerHTML=rows.slice(0,500).map(r=>{
    let vtoStr='—';
    if (!isNaN(r.ppv)&&r.ppv>0){const v=new Date(r.date+'T00:00:00');v.setDate(v.getDate()+Math.round(r.ppv));vtoStr=v.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'});}
    const idx=allEmps.indexOf(r.empresa);
    const color=idx===0?EMP_MAIN_COLOR:EMP_PALETTE[idx%EMP_PALETTE.length];
    return `<tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${r.empresa}</td>
      <td>${r.date.split('-').reverse().join('/')}</td><td>${r.tipo}</td><td>${r.moneda}</td>
      <td style="text-align:right">${fmtM(r.monto)}</td><td style="text-align:right">${r.tasa.toFixed(2)}%</td>
      <td style="text-align:center"><span class="bcat" style="background:${(TRAMO_COLORS[r.tramo]||'#6b7280')+'22'};color:${TRAMO_COLORS[r.tramo]||'#6b7280'}">${r.tramo||'—'}</span></td>
      <td style="text-align:right">${isNaN(r.ppv)||r.ppv<=0?'—':Math.round(r.ppv)}</td>
      <td>${vtoStr}</td>
      <td>${r.vendedor||'—'}</td>
      <td>${r.comprador||'—'}</td></tr>`;
  }).join('');
}

function empResetDates() {
  const dates=rawData.map(r=>r.date).sort();
  document.getElementById('empDesde').value=dates[0]||'';
  document.getElementById('empHasta').value=dates[dates.length-1]||'';
  renderEmp();
}
