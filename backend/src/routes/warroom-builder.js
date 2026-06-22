const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const https   = require('https');
const http    = require('http');

// ── Warroom Type Registry (hardcoded, extensible) ─────────────────────────
const WARROOM_TYPE_REGISTRY = [
  {
    code: 'instaqris_mcc',
    name: 'InstaQRIS MCC Warroom',
    business_unit: 'InstaQRIS',
    business_model: 'B2B',
    entity_type: 'MCC',
    entity_label: 'MCC',
    color: '#E24B4A',
    default_plugins: ['merchant','transaction','revenue'],
  },
  {
    code: 'instaqris_merchant',
    name: 'InstaQRIS Merchant Warroom',
    business_unit: 'InstaQRIS',
    business_model: 'B2B',
    entity_type: 'Merchant',
    entity_label: 'Merchant',
    color: '#7F77DD',
    default_plugins: ['merchant','activation','retention','revenue'],
  },
  {
    code: 'speedcash_outlet',
    name: 'Speedcash Outlet Warroom',
    business_unit: 'Speedcash',
    business_model: 'B2C',
    entity_type: 'Outlet',
    entity_label: 'Outlet',
    color: '#F97316',
    default_plugins: ['transaction','margin','growth'],
  },
  {
    code: 'fastpay_product',
    name: 'Fastpay Product Warroom',
    business_unit: 'Fastpay',
    business_model: 'B2B',
    entity_type: 'Product',
    entity_label: 'Produk',
    color: '#639922',
    default_plugins: ['product','transaction','revenue'],
  },
  {
    code: 'fastpay_farming',
    name: 'Fastpay Farming Warroom',
    business_unit: 'Fastpay',
    business_model: 'B2B',
    entity_type: 'Agent',
    entity_label: 'Agent',
    color: '#10B981',
    default_plugins: ['agent','farming','activation','retention'],
  },
  {
    code: 'winme_seller',
    name: 'Winme Seller Warroom',
    business_unit: 'Winme',
    business_model: 'B2B2C',
    entity_type: 'Seller',
    entity_label: 'Seller',
    color: '#7F77DD',
    default_plugins: ['seller','revenue','growth'],
  },
  {
    code: 'pulsagram_partner',
    name: 'Pulsagram Partner Warroom',
    business_unit: 'Pulsagram',
    business_model: 'HOST_TO_HOST',
    entity_type: 'Partner',
    entity_label: 'Partner',
    color: '#378ADD',
    default_plugins: ['transaction','revenue','margin','reliability'],
  },
  {
    code: 'custom',
    name: 'Custom Warroom',
    business_unit: 'Custom',
    business_model: 'Custom',
    entity_type: 'Custom',
    entity_label: 'Entity',
    color: '#6B7280',
    default_plugins: ['transaction','revenue'],
  },
];

const PLUGIN_REGISTRY = [
  { code: 'revenue',      name: 'Revenue Plugin',      metrics: ['previous_revenue','current_revenue','dev_revenue'] },
  { code: 'transaction',  name: 'Transaction Plugin',  metrics: ['previous_trx','current_trx','dev_trx'] },
  { code: 'margin',       name: 'Margin Plugin',       metrics: ['previous_margin','current_margin','dev_margin'] },
  { code: 'merchant',     name: 'Merchant Plugin',     metrics: ['entity_count','entity_productivity'] },
  { code: 'agent',        name: 'Agent Plugin',        metrics: ['entity_count','entity_productivity','entity_retention'] },
  { code: 'seller',       name: 'Seller Plugin',       metrics: ['entity_count','entity_growth','entity_activation'] },
  { code: 'product',      name: 'Product Plugin',      metrics: ['mat','arpt','atpu','arpu'] },
  { code: 'activation',   name: 'Activation Plugin',   metrics: ['first_trx_date','activated_count','activation_rate'] },
  { code: 'retention',    name: 'Retention Plugin',    metrics: ['last_trx_date','active_count','dormant_count'] },
  { code: 'growth',       name: 'Growth Plugin',       metrics: ['growth_status','growth_pct','same_period_growth'] },
  { code: 'farming',      name: 'Farming Plugin',      metrics: ['same_period_previous_trx','same_period_current_trx'] },
  { code: 'reliability',  name: 'Reliability Plugin',  metrics: ['success_rate','failure_rate'] },
  { code: 'territory',    name: 'Territory Plugin',    metrics: ['province','city','territory_performance'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function parseNumber(v) {
  if (v === null || v === undefined || v === '' || v === '-') return 0;
  if (typeof v === 'number') return v;
  const s   = String(v).replace(/Rp\s*/gi, '').trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const num = parseFloat(s.replace(/[()]/g, '').replace(/,/g, '')) || 0;
  return neg ? -num : num;
}

function normalizeColName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractSheetId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function extractGid(url) {
  const m = url.match(/[#&?]gid=(\d+)/);
  return m ? m[1] : '0';
}

function buildCsvUrls(sheetId, gid) {
  // gviz endpoint is most reliable for "Anyone with link can view" sheets
  return [
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/pub?output=csv&gid=${gid}`,
  ];
}
function buildCsvUrl(sheetId, gid) {
  return buildCsvUrls(sheetId, gid)[0];
}

function fetchRaw(url, redirectDepth) {
  if ((redirectDepth || 0) > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BRICBot/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
    };
    const req = client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        res.resume();
        return fetchRaw(loc.startsWith('http') ? loc : new URL(loc, url).href, (redirectDepth||0)+1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // Detect HTML response (login page / consent page returned instead of CSV)
        const trimmed = data.trimStart();
        if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
          return reject(new Error('Sheet tidak bisa diakses — pastikan sheet sudah di-share "Anyone with the link can view"'));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchUrl(url) {
  return fetchRaw(url, 0);
}

async function fetchSheet(sheetId, gid) {
  const urls = buildCsvUrls(sheetId, gid);
  let lastErr;
  for (const u of urls) {
    try {
      const data = await fetchRaw(u, 0);
      return { data, csvUrl: u };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        cols.push(cur.trim()); cur = '';
      } else {
        cur += c;
      }
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

function detectHeaderRows(rows) {
  if (rows.length < 2) return { headerRows: 1, dataStartRow: 1 };
  const row0 = rows[0] || [];
  const row1 = rows[1] || [];

  // Jika baris pertama mengandung pola "Day N" atau ada merged cell (banyak kosong)
  const row0NonEmpty = row0.filter(c => c && c.trim()).length;
  const row0HasMonth = row0.some(c => /\b(jan|feb|mar|apr|mei|may|jun|jul|aug|sep|oct|nov|dec|januari|februari|maret|april|juni|juli|agustus|september|oktober|november|desember)\b/i.test(c));
  const row0HasNumbers = row0.some(c => /^\d{1,3}(,\d{3})*(\.\d+)?$/.test(c.replace(/[Rp\s]/g, '')));

  // Baris kedua: cek apakah berisi "Merchant|TRX|REV" (sub-header)
  const row1HasSubHeaders = row1.some(c => /\b(merchant|trx|rev|revenue|margin|gmv|order|mat|arpt|atpu|arpu|seller|agent|outlet|partner)\b/i.test(c));

  if (row0HasMonth && row1HasSubHeaders && !row0HasNumbers) {
    // 2-row multi header
    return { headerRows: 2, dataStartRow: 2 };
  }
  return { headerRows: 1, dataStartRow: 1 };
}

function flattenMultiHeader(rows, headerRows) {
  if (headerRows === 1) {
    return (rows[0] || []).map(normalizeColName);
  }
  // 2-row: forward-fill row0, combine with row1
  const row0 = [...(rows[0] || [])];
  const row1 = rows[1] || [];
  let lastParent = '';
  const cols = [];
  for (let i = 0; i < Math.max(row0.length, row1.length); i++) {
    const parent = (row0[i] || '').trim();
    const child  = (row1[i] || '').trim();
    if (parent) lastParent = parent;
    if (lastParent && child && lastParent !== child) {
      cols.push(normalizeColName(`${lastParent} ${child}`));
    } else if (child) {
      cols.push(normalizeColName(child));
    } else if (lastParent) {
      cols.push(normalizeColName(lastParent));
    } else {
      cols.push(`col_${i}`);
    }
  }
  return cols;
}

// Auto-detect standard field dari nama kolom
function autoDetectField(colName) {
  const c = colName.toLowerCase();
  const hints = [
    { field: 'entity_id',                  patterns: ['id_outlet','id outlet','kode','mcc','entity_id','id_mcc','id_merchant','id_seller','id_agent','id_partner'] },
    { field: 'entity_name',                 patterns: ['nama','name','kategori','segmen','produk','product','entity_name'] },
    { field: 'category',                    patterns: ['category','kategori','segment','segmen'] },
    { field: 'province',                    patterns: ['provinsi','province','propinsi'] },
    { field: 'city',                        patterns: ['kota','city','kabupaten'] },
    { field: 'registration_date',           patterns: ['tgl_reg','tgl reg','tanggal reg','registration','reg_date'] },
    { field: 'first_trx_date',              patterns: ['first_trx','first trx','tgl_first','tanggal first'] },
    { field: 'last_trx_date',               patterns: ['last_trx','last trx','tgl_last','tanggal last'] },
    { field: 'previous_trx',               patterns: ['trx_mei','trx_apr','trx_april','trx_previous','prev_trx','trx_lalu'] },
    { field: 'current_trx',                patterns: ['trx_jun','trx_juni','trx_current','curr_trx','trx_sekarang'] },
    { field: 'same_period_previous_trx',   patterns: ['trx_1_9_mei','trx_mei_9','trx_same_prev'] },
    { field: 'same_period_current_trx',    patterns: ['trx_1_9_jun','trx_jun_9','trx_same_curr'] },
    { field: 'previous_revenue',           patterns: ['rev_mei','rev_apr','revenue_mei','revenue_apr','rev_previous'] },
    { field: 'current_revenue',            patterns: ['rev_jun','rev_juni','revenue_jun','revenue_juni','rev_current'] },
    { field: 'previous_margin',            patterns: ['margin_mei','margin_apr','margin_previous'] },
    { field: 'current_margin',             patterns: ['margin_jun','margin_juni','margin_current'] },
    { field: 'dev_trx',                    patterns: ['dev_trx','delta_trx','selisih_trx','growth_trx'] },
    { field: 'dev_revenue',               patterns: ['dev_rev','dev_revenue','delta_rev','delta_revenue'] },
    { field: 'dev_margin',                patterns: ['dev_margin','delta_margin'] },
    { field: 'mat',                        patterns: ['mat'] },
    { field: 'arpt',                       patterns: ['arpt'] },
    { field: 'atpu',                       patterns: ['atpu'] },
    { field: 'arpu',                       patterns: ['arpu'] },
    { field: 'success_rate',              patterns: ['success_rate','sukses'] },
    { field: 'failure_rate',              patterns: ['failure_rate','gagal'] },
    { field: 'pic',                        patterns: ['pic','penanggung','person'] },
    { field: 'no_hp',                      patterns: ['no_hp','hp','phone','telepon','wa'] },
  ];

  for (const h of hints) {
    if (h.patterns.some(p => c.includes(p.replace(/_/g, '_')) || c === p)) {
      return { field: h.field, confidence: 0.8 };
    }
  }
  return { field: null, confidence: 0 };
}

// Period detection dari nama kolom
function detectPeriod(cols, rows) {
  const allCols = cols.join(' ').toLowerCase();

  // Cek apakah ada same period comparison
  const hasSamePeriod =
    (allCols.includes('mei') && allCols.includes('jun')) &&
    (allCols.includes('1_9') || allCols.includes('same'));

  // Cek MTD vs full month
  let periodType = 'full_month';
  let cutoffDay = null;

  // Coba detect "Day N" dari baris pertama/judul
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    for (const cell of rows[i]) {
      const m = String(cell).match(/day\s*(\d+)/i);
      if (m) {
        cutoffDay = parseInt(m[1]);
        periodType = 'mtd';
        break;
      }
    }
    if (cutoffDay) break;
  }

  // Detect bulan corrente
  let currentMonth = null;
  const monthMap = {
    jan:1, feb:2, mar:3, apr:4, mei:5, may:5, jun:6, jul:7,
    aug:8, sep:9, oct:10, nov:11, dec:12,
    januari:1, februari:2, maret:3, april:4, juni:6, juli:7,
    agustus:8, september:9, oktober:10, november:11, desember:12
  };
  for (const [k,v] of Object.entries(monthMap)) {
    if (allCols.includes(k)) currentMonth = v;
  }

  return {
    period_type: periodType,
    cutoff_day: cutoffDay,
    has_same_period: hasSamePeriod,
    current_month: currentMonth,
  };
}

// ── Insight Engine (rule-based) ───────────────────────────────────────────

function generateInsights(parsedData, summary, warroom) {
  const entityLabel = warroom.entity_label || 'Entity';
  const insights = {};

  // Executive Summary
  const revDelta   = summary.dev_revenue || 0;
  const revDeltaPct = summary.dev_revenue_pct || 0;
  const direction  = revDelta >= 0 ? 'naik' : 'turun';
  const pctAbs     = Math.abs(revDeltaPct).toFixed(1);
  insights.executive_summary =
    `${warroom.name}: Revenue ${direction} ${pctAbs}% vs periode sebelumnya. ` +
    `Total ${entityLabel} aktif: ${summary.active_entity || 0} dari ${summary.total_entity || 0}. ` +
    (summary.top_growth_name ? `Kontributor terbesar: ${summary.top_growth_name}.` : '');

  // Top Growth Driver
  if (summary.top_growth_name) {
    insights.top_growth_driver = {
      name: summary.top_growth_name,
      dev_revenue: summary.top_growth_dev_revenue,
      dev_trx: summary.top_growth_dev_trx,
    };
  }

  // Top Decliner
  if (summary.top_decline_name) {
    insights.top_decliner = {
      name: summary.top_decline_name,
      dev_revenue: summary.top_decline_dev_revenue,
      dev_trx: summary.top_decline_dev_trx,
    };
  }

  // Monetization Problem: TRX naik tapi revenue turun
  const monProb = parsedData.filter(r =>
    (r.dev_trx || 0) > 0 &&
    (r.dev_revenue !== undefined) && (r.dev_revenue || 0) < 0 &&
    (r.current_trx || 0) > 0
  );
  if (monProb.length > 0) {
    insights.monetization_problem = monProb.slice(0, 5).map(r => ({
      name: r.entity_name || r.entity_id,
      dev_trx: r.dev_trx,
      dev_revenue: r.dev_revenue,
    }));
    insights.monetization_problem_count = monProb.length;
  }

  // Churn Risk: dev_trx negatif besar
  const churnRisk = parsedData.filter(r =>
    (r.previous_trx || 0) > 0 && (r.current_trx || 0) === 0
  );
  if (churnRisk.length > 0) {
    insights.churn_risk_count = churnRisk.length;
    insights.churn_sample = churnRisk.slice(0, 3).map(r => r.entity_name || r.entity_id);
  }

  // Hidden Gem: entity baru dengan trx di atas rata-rata
  const avgTrx = summary.avg_current_trx || 0;
  const hiddenGems = parsedData.filter(r =>
    (r.previous_trx || 0) === 0 &&
    (r.current_trx || 0) > avgTrx * 1.5
  );
  if (hiddenGems.length > 0) {
    insights.hidden_gems = hiddenGems.slice(0, 3).map(r => ({
      name: r.entity_name || r.entity_id,
      current_trx: r.current_trx,
    }));
  }

  // Root cause hints
  const hints = [];
  if (revDelta < 0) {
    if ((summary.dev_trx || 0) < 0) hints.push('Volume TRX juga turun — bukan hanya masalah harga/margin');
    else hints.push('Volume TRX stabil — kemungkinan revenue per TRX yang melemah');
    if ((summary.active_entity || 0) < (summary.prev_active_entity || summary.active_entity || 0))
      hints.push(`Jumlah ${entityLabel} aktif berkurang`);
    if (monProb.length > 0) hints.push(`${monProb.length} ${entityLabel} mengalami monetization problem (TRX naik, revenue turun)`);
  }
  insights.root_cause_hints = hints;

  // Recommended Actions
  const actions = [];
  if (summary.top_growth_name) actions.push(`Scale ${summary.top_growth_name} — ${entityLabel} dengan growth terbaik`);
  if (summary.top_decline_name) actions.push(`Selidiki ${summary.top_decline_name} — ${entityLabel} dengan penurunan terbesar`);
  if (monProb.length > 0) actions.push(`Audit pricing/monetisasi ${monProb.length} ${entityLabel} yang TRX naik tapi revenue turun`);
  if (churnRisk.length > 0) actions.push(`Rescue ${churnRisk.length} ${entityLabel} yang baru churn bulan ini`);
  insights.recommended_actions = actions;

  return insights;
}

// ── Alert Engine ─────────────────────────────────────────────────────────

function generateAlerts(summary, warroom) {
  const alerts = [];
  const push = (type, level, title, message, val, threshold) =>
    alerts.push({ alert_type: type, level, title, message, metric_value: val, threshold_value: threshold });

  const revPct = summary.dev_revenue_pct || 0;
  const trxPct = summary.dev_trx_pct || 0;

  if (revPct < -20) push('revenue_drop', 'critical',
    'Revenue Drop Kritis', `Revenue turun ${Math.abs(revPct).toFixed(1)}% vs periode sebelumnya`, revPct, -20);
  else if (revPct < -10) push('revenue_drop', 'warning',
    'Revenue Drop', `Revenue turun ${Math.abs(revPct).toFixed(1)}%`, revPct, -10);

  if (trxPct < -20) push('trx_drop', 'critical',
    'TRX Drop Kritis', `Volume TRX turun ${Math.abs(trxPct).toFixed(1)}%`, trxPct, -20);
  else if (trxPct < -10) push('trx_drop', 'warning',
    'TRX Drop', `Volume TRX turun ${Math.abs(trxPct).toFixed(1)}%`, trxPct, -10);

  if ((summary.churn_count || 0) > 0) push('churn_risk', 'warning',
    'Entity Churn Terdeteksi', `${summary.churn_count} ${warroom.entity_label || 'entity'} baru churn`,
    summary.churn_count, 0);

  if ((summary.monetization_problem_count || 0) > 0) push('monetization_problem', 'info',
    'Monetization Problem', `${summary.monetization_problem_count} entity: TRX naik tapi revenue turun`,
    summary.monetization_problem_count, 0);

  return alerts;
}

// ── Score Engine ──────────────────────────────────────────────────────────

function calcScore(summary, alertsArr) {
  let score = 60; // baseline

  const revPct = summary.dev_revenue_pct || 0;
  const trxPct = summary.dev_trx_pct || 0;

  // Growth contribution (+/- 25 points)
  score += Math.min(25, Math.max(-25, (revPct + trxPct) / 2 * 0.5));

  // Retention (+10 if mostly active)
  const totalE = summary.total_entity || 1;
  const activeE = summary.active_entity || 0;
  const retentionRate = activeE / totalE;
  score += retentionRate * 10;

  // Alert penalty
  const criticals = alertsArr.filter(a => a.level === 'critical').length;
  const warnings  = alertsArr.filter(a => a.level === 'warning').length;
  score -= criticals * 15;
  score -= warnings * 5;

  score = Math.round(Math.max(0, Math.min(100, score)));

  let status = 'good';
  if (score >= 80) status = 'excellent';
  else if (score >= 60) status = 'good';
  else if (score >= 40) status = 'warning';
  else status = 'critical';

  return { score, score_status: status };
}

// ── Compute parsed data metrics ───────────────────────────────────────────

function computeRowMetrics(rows, mappings) {
  const fieldMap = {};
  for (const m of mappings) {
    if (m.standard_field) fieldMap[m.original_col] = m.standard_field;
  }

  const parsed = rows.map(row => {
    const r = {};
    for (const [origCol, val] of Object.entries(row)) {
      const sf = fieldMap[origCol];
      if (sf) r[sf] = val;
      else r[origCol] = val; // keep unmapped cols too
    }

    // Parse numbers for known numeric fields
    const numericFields = [
      'previous_trx','current_trx','same_period_previous_trx','same_period_current_trx',
      'previous_revenue','current_revenue','previous_margin','current_margin',
      'previous_gmv','current_gmv','previous_order','current_order',
      'dev_trx','dev_revenue','dev_margin','mat','arpt','atpu','arpu',
      'success_rate','failure_rate',
    ];
    for (const f of numericFields) {
      if (r[f] !== undefined) r[f] = parseNumber(r[f]);
    }

    // Compute derived
    if (r.current_trx !== undefined && r.previous_trx !== undefined) {
      r.dev_trx = r.dev_trx !== undefined ? r.dev_trx : (r.current_trx - r.previous_trx);
      r.dev_trx_pct = r.previous_trx > 0 ? ((r.current_trx - r.previous_trx) / r.previous_trx * 100) : null;
    }
    if (r.current_revenue !== undefined && r.previous_revenue !== undefined) {
      r.dev_revenue = r.dev_revenue !== undefined ? r.dev_revenue : (r.current_revenue - r.previous_revenue);
      r.dev_revenue_pct = r.previous_revenue > 0 ? ((r.current_revenue - r.previous_revenue) / r.previous_revenue * 100) : null;
    }
    if (r.current_margin !== undefined && r.previous_margin !== undefined) {
      r.dev_margin = r.dev_margin !== undefined ? r.dev_margin : (r.current_margin - r.previous_margin);
    }

    // Same period comparison (override dev if available)
    if (r.same_period_current_trx !== undefined && r.same_period_previous_trx !== undefined) {
      r.dev_trx = r.same_period_current_trx - r.same_period_previous_trx;
      r.dev_trx_pct = r.same_period_previous_trx > 0
        ? ((r.same_period_current_trx - r.same_period_previous_trx) / r.same_period_previous_trx * 100) : null;
    }

    // Growth status
    const currTrx = r.same_period_current_trx ?? r.current_trx ?? 0;
    const prevTrx = r.same_period_previous_trx ?? r.previous_trx ?? 0;
    if (prevTrx === 0 && currTrx > 0) r.growth_status = 'new';
    else if (currTrx === 0 && prevTrx > 0) r.growth_status = 'churned';
    else if ((r.dev_trx || 0) > 0) r.growth_status = 'growing';
    else if ((r.dev_trx || 0) < 0) r.growth_status = 'declining';
    else r.growth_status = 'stable';

    return r;
  }).filter(r => r.entity_id || r.entity_name); // skip rows without entity identifier

  return parsed;
}

function computeSummary(parsedData) {
  const total_entity  = parsedData.length;
  const active_entity = parsedData.filter(r => (r.current_trx ?? r.current_revenue ?? 0) > 0).length;
  const new_entity    = parsedData.filter(r => r.growth_status === 'new').length;
  const churn_count   = parsedData.filter(r => r.growth_status === 'churned').length;
  const growing_count = parsedData.filter(r => r.growth_status === 'growing').length;

  const sumField = (field) => parsedData.reduce((s, r) => s + (r[field] || 0), 0);

  const total_trx_prev  = sumField('previous_trx');
  const total_trx_curr  = sumField('current_trx');
  const total_rev_prev  = sumField('previous_revenue');
  const total_rev_curr  = sumField('current_revenue');
  const total_mar_prev  = sumField('previous_margin');
  const total_mar_curr  = sumField('current_margin');

  const dev_trx     = total_trx_curr - total_trx_prev;
  const dev_revenue = total_rev_curr - total_rev_prev;
  const dev_margin  = total_mar_curr - total_mar_prev;
  const dev_trx_pct = total_trx_prev > 0 ? (dev_trx / total_trx_prev * 100) : null;
  const dev_revenue_pct = total_rev_prev > 0 ? (dev_revenue / total_rev_prev * 100) : null;

  const avg_current_trx = active_entity > 0 ? total_trx_curr / active_entity : 0;

  // Monetization problem count
  const monetization_problem_count = parsedData.filter(r =>
    (r.dev_trx || 0) > 0 && (r.dev_revenue || 0) < 0 && (r.current_trx || 0) > 0
  ).length;

  // Top growth & decline by revenue
  const withRev = parsedData.filter(r => r.dev_revenue !== undefined);
  withRev.sort((a,b) => (b.dev_revenue||0) - (a.dev_revenue||0));
  const topGrowth  = withRev[0];
  const topDecline = withRev[withRev.length - 1];

  // Top 10 by current trx
  const sorted_trx = [...parsedData].sort((a,b) => (b.current_trx||0) - (a.current_trx||0));
  const top10_trx = sorted_trx.slice(0,10).map(r => ({
    name: r.entity_name || r.entity_id,
    current_trx: r.current_trx || 0,
    dev_trx: r.dev_trx || 0,
  }));

  // Top 10 by current revenue
  const sorted_rev = [...parsedData].sort((a,b) => (b.current_revenue||0) - (a.current_revenue||0));
  const top10_revenue = sorted_rev.slice(0,10).map(r => ({
    name: r.entity_name || r.entity_id,
    current_revenue: r.current_revenue || 0,
    dev_revenue: r.dev_revenue || 0,
  }));

  // Growth status distribution
  const status_dist = { growing: 0, declining: 0, stable: 0, new: 0, churned: 0 };
  for (const r of parsedData) {
    if (r.growth_status && status_dist[r.growth_status] !== undefined)
      status_dist[r.growth_status]++;
  }

  return {
    total_entity, active_entity, new_entity, churn_count, growing_count,
    total_trx_prev, total_trx_curr, dev_trx, dev_trx_pct,
    total_rev_prev, total_rev_curr, dev_revenue, dev_revenue_pct,
    total_mar_prev, total_mar_curr, dev_margin,
    avg_current_trx,
    monetization_problem_count,
    top_growth_name: topGrowth ? (topGrowth.entity_name || topGrowth.entity_id) : null,
    top_growth_dev_revenue: topGrowth?.dev_revenue,
    top_growth_dev_trx: topGrowth?.dev_trx,
    top_decline_name: topDecline && (topDecline.dev_revenue||0) < 0
      ? (topDecline.entity_name || topDecline.entity_id) : null,
    top_decline_dev_revenue: topDecline?.dev_revenue,
    top_decline_dev_trx: topDecline?.dev_trx,
    top10_trx,
    top10_revenue,
    status_dist,
  };
}

// ── Action Engine ─────────────────────────────────────────────────────────

function generateActions(parsedData, insights, warroom) {
  const entityLabel = warroom.entity_label || 'Entity';
  const actions = [];

  // Scale: top 5 growing revenue
  const growing = parsedData
    .filter(r => (r.dev_revenue||0) > 0 && r.growth_status === 'growing')
    .sort((a,b) => (b.dev_revenue||0) - (a.dev_revenue||0))
    .slice(0, 5);
  for (const r of growing) {
    actions.push({
      action_type: 'scale',
      priority: 1,
      entity_id: String(r.entity_id || ''),
      entity_name: String(r.entity_name || r.entity_id || ''),
      issue: `${entityLabel} growing — TRX +${(r.dev_trx||0)} | Revenue +${(r.dev_revenue||0)}`,
      recommendation: `Tingkatkan support dan promosi untuk ${r.entity_name || r.entity_id}`,
    });
  }

  // Rescue: top 5 declining revenue
  const declining = parsedData
    .filter(r => (r.dev_revenue||0) < 0 || r.growth_status === 'declining')
    .sort((a,b) => (a.dev_revenue||0) - (b.dev_revenue||0))
    .slice(0, 5);
  for (const r of declining) {
    actions.push({
      action_type: 'rescue',
      priority: 1,
      entity_id: String(r.entity_id || ''),
      entity_name: String(r.entity_name || r.entity_id || ''),
      issue: `${entityLabel} declining — TRX ${(r.dev_trx||0)} | Revenue ${(r.dev_revenue||0)}`,
      recommendation: `Hubungi dan identifikasi masalah ${r.entity_name || r.entity_id}`,
    });
  }

  // Fix Monetization
  if (insights.monetization_problem) {
    for (const item of insights.monetization_problem.slice(0, 3)) {
      actions.push({
        action_type: 'fix_monetization',
        priority: 2,
        entity_id: '',
        entity_name: String(item.name || ''),
        issue: `TRX naik +${item.dev_trx} tapi Revenue turun ${item.dev_revenue}`,
        recommendation: 'Audit pricing / mix produk / negosiasi ulang margin',
      });
    }
  }

  // Reactivate: churned
  const churned = parsedData
    .filter(r => r.growth_status === 'churned')
    .slice(0, 5);
  for (const r of churned) {
    actions.push({
      action_type: 'reactivate',
      priority: 2,
      entity_id: String(r.entity_id || ''),
      entity_name: String(r.entity_name || r.entity_id || ''),
      issue: `${entityLabel} baru churn — tidak ada TRX bulan ini`,
      recommendation: `Hubungi segera untuk reaktivasi ${r.entity_name || r.entity_id}`,
    });
  }

  // Hidden Gem: new with high TRX
  if (insights.hidden_gems) {
    for (const gem of insights.hidden_gems) {
      actions.push({
        action_type: 'hidden_gem',
        priority: 3,
        entity_id: '',
        entity_name: String(gem.name || ''),
        issue: `${entityLabel} baru dengan TRX di atas rata-rata: ${gem.current_trx}`,
        recommendation: `Berikan onboarding dan support premium untuk ${gem.name}`,
      });
    }
  }

  return actions;
}

// ── Routes ────────────────────────────────────────────────────────────────

// GET /registry
router.get('/registry', (req, res) => {
  res.json(WARROOM_TYPE_REGISTRY);
});

// GET /plugins
router.get('/plugins', (req, res) => {
  res.json(PLUGIN_REGISTRY);
});

// GET /overview
router.get('/overview', async (req, res) => {
  try {
    const [wrRes, alertRes, actionRes] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE last_generated_at IS NOT NULL) AS active FROM wb_warrooms'),
      pool.query("SELECT COUNT(*) AS critical FROM wb_alerts WHERE level='critical' AND is_resolved=FALSE"),
      pool.query("SELECT COUNT(*) AS open FROM wb_actions WHERE status='open'"),
    ]);
    const lastSyncRes = await pool.query('SELECT MAX(last_synced_at) AS last_sync FROM wb_warrooms');
    res.json({
      total_warroom: parseInt(wrRes.rows[0].total),
      active_warroom: parseInt(wrRes.rows[0].active),
      critical_alerts: parseInt(alertRes.rows[0].critical),
      open_actions: parseInt(actionRes.rows[0].open),
      last_sync: lastSyncRes.rows[0].last_sync,
    });
  } catch (e) {
    console.error('[WB overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms
router.get('/warrooms', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.*,
        (SELECT COUNT(*) FROM wb_alerts a WHERE a.warroom_id=w.id AND a.is_resolved=FALSE AND a.level='critical') AS critical_alerts,
        (SELECT COUNT(*) FROM wb_actions ac WHERE ac.warroom_id=w.id AND ac.status='open') AS open_actions
      FROM wb_warrooms w
      ORDER BY w.updated_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('[WB warrooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /warrooms
router.post('/warrooms', async (req, res) => {
  const {
    name, description, business_unit, business_model, entity_type,
    entity_label, warroom_type_code, plugin_codes, color,
  } = req.body;
  if (!name || !business_unit || !business_model || !entity_type)
    return res.status(400).json({ error: 'name, business_unit, business_model, entity_type required' });
  try {
    const result = await pool.query(
      `INSERT INTO wb_warrooms
        (name, description, business_unit, business_model, entity_type, entity_label,
         warroom_type_code, plugin_codes, color, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING *`,
      [name, description||'', business_unit, business_model, entity_type,
       entity_label||'Entity', warroom_type_code||null,
       JSON.stringify(plugin_codes||[]), color||'#1D9E75',
       req.user?.username || 'system']
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error('[WB create warroom]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id
router.get('/warrooms/:id', async (req, res) => {
  try {
    const [wrRes, sheetRes, mapRes] = await Promise.all([
      pool.query('SELECT * FROM wb_warrooms WHERE id=$1', [req.params.id]),
      pool.query('SELECT * FROM wb_sheet_sources WHERE warroom_id=$1 ORDER BY id', [req.params.id]),
      pool.query('SELECT * FROM wb_column_mappings WHERE warroom_id=$1 ORDER BY id', [req.params.id]),
    ]);
    if (!wrRes.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...wrRes.rows[0], sheet_source: sheetRes.rows[0]||null, column_mappings: mapRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /warrooms/:id
router.put('/warrooms/:id', async (req, res) => {
  const {
    name, description, business_unit, business_model, entity_type,
    entity_label, warroom_type_code, plugin_codes, color, dashboard_config,
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE wb_warrooms SET
        name=$1, description=$2, business_unit=$3, business_model=$4,
        entity_type=$5, entity_label=$6, warroom_type_code=$7,
        plugin_codes=$8, color=$9, dashboard_config=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [name, description||'', business_unit, business_model, entity_type,
       entity_label||'Entity', warroom_type_code||null,
       JSON.stringify(plugin_codes||[]), color||'#1D9E75',
       JSON.stringify(dashboard_config||{}), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /warrooms/:id
router.delete('/warrooms/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM wb_warrooms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /warrooms/:id/sheet/preview — fetch CSV, detect header, return preview
router.post('/warrooms/:id/sheet/preview', async (req, res) => {
  const { sheet_url } = req.body;
  if (!sheet_url) return res.status(400).json({ error: 'sheet_url required' });

  const sheetId = extractSheetId(sheet_url);
  if (!sheetId) return res.status(400).json({ error: 'URL Google Sheet tidak valid' });

  const gid = extractGid(sheet_url);
  const t0  = Date.now();

  try {
    const { data: csvText, csvUrl } = await fetchSheet(sheetId, gid);
    const allRows    = parseCSV(csvText);
    const { headerRows, dataStartRow } = detectHeaderRows(allRows);
    const flatCols   = flattenMultiHeader(allRows.slice(0, headerRows), headerRows);
    const dataRows   = allRows.slice(dataStartRow);
    const periodInfo = detectPeriod(flatCols, allRows.slice(0, 3));

    // Build preview: max 20 rows as array of objects
    const previewRows = dataRows.slice(0, 20).map(row => {
      const obj = {};
      flatCols.forEach((col, i) => { obj[col] = row[i] || ''; });
      return obj;
    });

    // Auto-detect field mappings
    const autoMappings = flatCols.map(col => {
      const { field, confidence } = autoDetectField(col);
      return {
        original_col: col,
        standard_field: field,
        confidence,
        data_type: field && ['entity_id','entity_name','category','province','city','pic','no_hp','registration_date','first_trx_date','last_trx_date','growth_status'].includes(field) ? 'text' : 'number',
      };
    });

    await pool.query('DELETE FROM wb_sheet_sources WHERE warroom_id=$1', [req.params.id]);
    await pool.query(`
      INSERT INTO wb_sheet_sources
        (warroom_id, sheet_url, sheet_id, gid, csv_url, header_rows,
         detected_day, detected_period, raw_preview, detected_cols)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.params.id, sheet_url, sheetId, gid, csvUrl, headerRows,
       periodInfo.cutoff_day ? `Day ${periodInfo.cutoff_day}` : null,
       periodInfo.period_type,
       JSON.stringify(previewRows),
       JSON.stringify(flatCols)]
    );

    await pool.query(`
      INSERT INTO wb_import_logs (warroom_id, action, status, rows_processed, duration_ms)
      VALUES ($1,'preview','success',$2,$3)`,
      [req.params.id, dataRows.length, Date.now() - t0]);

    res.json({
      sheet_id: sheetId,
      gid,
      csv_url: csvUrl,
      header_rows: headerRows,
      total_rows: dataRows.length,
      columns: flatCols,
      preview: previewRows,
      period_info: periodInfo,
      auto_mappings: autoMappings,
    });
  } catch (e) {
    console.error('[WB preview]', e.message);
    await pool.query(`
      INSERT INTO wb_import_logs (warroom_id, action, status, error_message, duration_ms)
      VALUES ($1,'preview','failed',$2,$3)`,
      [req.params.id, e.message, Date.now() - t0]).catch(() => {});
    res.status(500).json({ error: `Gagal fetch sheet: ${e.message}` });
  }
});

// POST /warrooms/:id/sheet/save — simpan column mappings
router.post('/warrooms/:id/sheet/save', async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings[] required' });
  try {
    await pool.query('DELETE FROM wb_column_mappings WHERE warroom_id=$1', [req.params.id]);
    for (const m of mappings) {
      await pool.query(
        `INSERT INTO wb_column_mappings
          (warroom_id, original_col, standard_field, confidence, data_type, period_tag)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, m.original_col, m.standard_field||null,
         m.confidence||0, m.data_type||'text', m.period_tag||null]
      );
    }
    await pool.query('UPDATE wb_warrooms SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true, saved: mappings.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /warrooms/:id/generate — main generate engine
router.post('/warrooms/:id/generate', async (req, res) => {
  const t0 = Date.now();
  try {
    // Load warroom config
    const [wrRes, sheetRes, mapRes] = await Promise.all([
      pool.query('SELECT * FROM wb_warrooms WHERE id=$1', [req.params.id]),
      pool.query('SELECT * FROM wb_sheet_sources WHERE warroom_id=$1', [req.params.id]),
      pool.query('SELECT * FROM wb_column_mappings WHERE warroom_id=$1', [req.params.id]),
    ]);
    if (!wrRes.rows.length) return res.status(404).json({ error: 'Warroom not found' });
    if (!sheetRes.rows.length) return res.status(400).json({ error: 'Sheet source belum dikonfigurasi' });

    const warroom = wrRes.rows[0];
    const sheet   = sheetRes.rows[0];
    const mappings = mapRes.rows;

    // Ambil data: push mode (csv_url null) pakai raw_preview yg sudah disimpan
    let rawObjects, flatCols, periodInfo;

    const isPushMode = !sheet.sheet_id && sheet.sheet_url === 'apps-script-push';

    if (isPushMode) {
      // raw_preview JSONB — pg sudah deserialize ke JS array
      const storedRows = Array.isArray(sheet.raw_preview) ? sheet.raw_preview : [];
      const storedCols = Array.isArray(sheet.detected_cols) ? sheet.detected_cols : [];
      if (!storedRows.length || !storedCols.length) {
        return res.status(400).json({ error: 'Push data kosong. Jalankan ulang Apps Script.' });
      }
      flatCols   = storedCols;
      rawObjects = storedRows;
      periodInfo = { period_type: sheet.detected_period || 'full_month', cutoff_day: null };
    } else {
      // Fetch dari Google Sheet
      const sheetIdGen = sheet.sheet_id || extractSheetId(sheet.sheet_url || '');
      const gidGen     = sheet.gid || '0';
      const { data: csvText } = sheetIdGen
        ? await fetchSheet(sheetIdGen, gidGen)
        : await fetchRaw(sheet.csv_url, 0).then(data => ({ data }));
      const allRows               = parseCSV(csvText);
      const { headerRows: hr, dataStartRow } = detectHeaderRows(allRows);
      flatCols   = flattenMultiHeader(allRows.slice(0, hr), hr);
      const dataRows              = allRows.slice(dataStartRow);
      rawObjects = dataRows.map(row => {
        const obj = {};
        flatCols.forEach((col, i) => { obj[col] = row[i] !== undefined ? row[i] : ''; });
        return obj;
      });
      periodInfo = detectPeriod(flatCols, allRows.slice(0, 3));
    }

    // Apply mappings + compute metrics
    const parsedData = computeRowMetrics(rawObjects, mappings);
    const summary    = computeSummary(parsedData);
    const insights   = generateInsights(parsedData, summary, warroom);
    const alertsArr  = generateAlerts(summary, warroom);
    const actionsArr = generateActions(parsedData, insights, warroom);
    const { score, score_status } = calcScore(summary, alertsArr);

    // Period label
    const now = new Date();
    const periodLabel = sheet.detected_period === 'mtd'
      ? `MTD ${sheet.detected_day || ''} ${now.toLocaleDateString('id-ID',{month:'long',year:'numeric'})}`
      : `Full ${now.toLocaleDateString('id-ID',{month:'long',year:'numeric'})}`;

    // Save snapshot
    const snapRes = await pool.query(
      `INSERT INTO wb_snapshots
        (warroom_id, snapshot_date, snapshot_type, period_label, cutoff_date,
         day_counter, month_total_days, raw_data, parsed_data, summary, insights,
         alerts_json, row_count)
       VALUES ($1,$2,'daily',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [warroom.id, now.toISOString().slice(0,10), periodLabel,
       periodInfo.cutoff_day ? `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(periodInfo.cutoff_day).padStart(2,'0')}` : null,
       periodInfo.cutoff_day || null,
       new Date(now.getFullYear(), now.getMonth()+1, 0).getDate(),
       JSON.stringify(rawObjects.slice(0, 200)),
       JSON.stringify(parsedData.slice(0, 500)),
       JSON.stringify(summary),
       JSON.stringify(insights),
       JSON.stringify(alertsArr),
       parsedData.length]
    );
    const snapshotId = snapRes.rows[0].id;

    // Save alerts
    for (const al of alertsArr) {
      await pool.query(
        `INSERT INTO wb_alerts
          (warroom_id, snapshot_id, alert_type, level, title, message, metric_value, threshold_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [warroom.id, snapshotId, al.alert_type, al.level, al.title,
         al.message||'', al.metric_value||null, al.threshold_value||null]
      );
    }

    // Save actions
    for (const ac of actionsArr) {
      await pool.query(
        `INSERT INTO wb_actions
          (warroom_id, snapshot_id, action_type, priority, entity_id, entity_name, issue, recommendation, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')`,
        [warroom.id, snapshotId, ac.action_type, ac.priority||3,
         ac.entity_id||'', ac.entity_name||'', ac.issue||'', ac.recommendation||'']
      );
    }

    // Update warroom
    await pool.query(
      `UPDATE wb_warrooms SET score=$1, score_status=$2, last_generated_at=NOW(), last_synced_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [score, score_status, warroom.id]
    );

    // Log
    await pool.query(
      `INSERT INTO wb_import_logs (warroom_id, action, status, rows_processed, duration_ms)
       VALUES ($1,'generate','success',$2,$3)`,
      [warroom.id, parsedData.length, Date.now() - t0]
    );

    res.json({
      snapshot_id: snapshotId,
      rows_processed: parsedData.length,
      score,
      score_status,
      summary,
      alert_count: alertsArr.length,
      action_count: actionsArr.length,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[WB generate]', e.message);
    await pool.query(
      `INSERT INTO wb_import_logs (warroom_id, action, status, error_message, duration_ms)
       VALUES ($1,'generate','failed',$2,$3)`,
      [req.params.id, e.message, Date.now() - t0]
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id/dashboard — return last snapshot data
router.get('/warrooms/:id/dashboard', async (req, res) => {
  try {
    const [wrRes, snapRes, alertRes, actionRes] = await Promise.all([
      pool.query('SELECT * FROM wb_warrooms WHERE id=$1', [req.params.id]),
      pool.query('SELECT * FROM wb_snapshots WHERE warroom_id=$1 ORDER BY snapshot_date DESC, id DESC LIMIT 1', [req.params.id]),
      pool.query("SELECT * FROM wb_alerts WHERE warroom_id=$1 AND is_resolved=FALSE ORDER BY level DESC, created_at DESC LIMIT 20", [req.params.id]),
      pool.query("SELECT * FROM wb_actions WHERE warroom_id=$1 AND status='open' ORDER BY priority, created_at DESC LIMIT 50", [req.params.id]),
    ]);
    if (!wrRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const snap = snapRes.rows[0] || null;
    res.json({
      warroom: wrRes.rows[0],
      snapshot: snap ? {
        id: snap.id,
        snapshot_date: snap.snapshot_date,
        period_label: snap.period_label,
        cutoff_date: snap.cutoff_date,
        day_counter: snap.day_counter,
        month_total_days: snap.month_total_days,
        summary: snap.summary,
        insights: snap.insights,
        row_count: snap.row_count,
        parsed_data: snap.parsed_data,
      } : null,
      alerts: alertRes.rows,
      actions: actionRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id/snapshots
router.get('/warrooms/:id/snapshots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, snapshot_date, snapshot_type, period_label, cutoff_date, day_counter, row_count, created_at
       FROM wb_snapshots WHERE warroom_id=$1 ORDER BY snapshot_date DESC, id DESC LIMIT 90`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id/snapshots/:sid
router.get('/warrooms/:id/snapshots/:sid', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wb_snapshots WHERE id=$1 AND warroom_id=$2',
      [req.params.sid, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id/alerts
router.get('/warrooms/:id/alerts', async (req, res) => {
  const resolved = req.query.resolved === 'true';
  try {
    const result = await pool.query(
      `SELECT * FROM wb_alerts WHERE warroom_id=$1 AND is_resolved=$2 ORDER BY level DESC, created_at DESC`,
      [req.params.id, resolved]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /warrooms/:id/alerts/:aid — resolve alert
router.patch('/warrooms/:id/alerts/:aid', async (req, res) => {
  try {
    await pool.query(
      `UPDATE wb_alerts SET is_resolved=TRUE, resolved_at=NOW() WHERE id=$1 AND warroom_id=$2`,
      [req.params.aid, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /warrooms/:id/actions
router.get('/warrooms/:id/actions', async (req, res) => {
  const status = req.query.status;
  try {
    const result = await pool.query(
      `SELECT * FROM wb_actions WHERE warroom_id=$1 ${status ? 'AND status=$2' : ''}
       ORDER BY priority, created_at DESC`,
      status ? [req.params.id, status] : [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /warrooms/:id/actions/:aid
router.put('/warrooms/:id/actions/:aid', async (req, res) => {
  const { status, pic, due_date, note } = req.body;
  try {
    const result = await pool.query(
      `UPDATE wb_actions SET status=COALESCE($1,status), pic=COALESCE($2,pic),
       due_date=COALESCE($3,due_date), note=COALESCE($4,note), updated_at=NOW()
       WHERE id=$5 AND warroom_id=$6 RETURNING *`,
      [status||null, pic||null, due_date||null, note||null, req.params.aid, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /actions — semua action lintas warroom
router.get('/actions', async (req, res) => {
  const { status, action_type } = req.query;
  const conditions = [];
  const vals = [];
  if (status) { conditions.push(`ac.status=$${vals.length+1}`); vals.push(status); }
  if (action_type) { conditions.push(`ac.action_type=$${vals.length+1}`); vals.push(action_type); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  try {
    const result = await pool.query(
      `SELECT ac.*, w.name AS warroom_name, w.business_unit, w.color
       FROM wb_actions ac
       JOIN wb_warrooms w ON w.id=ac.warroom_id
       ${where}
       ORDER BY ac.priority, ac.created_at DESC
       LIMIT 200`,
      vals
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /alerts — semua alert lintas warroom
router.get('/alerts', async (req, res) => {
  const resolved = req.query.resolved === 'true';
  try {
    const result = await pool.query(
      `SELECT al.*, w.name AS warroom_name, w.business_unit, w.color
       FROM wb_alerts al
       JOIN wb_warrooms w ON w.id=al.warroom_id
       WHERE al.is_resolved=$1
       ORDER BY al.level DESC, al.created_at DESC
       LIMIT 100`,
      [resolved]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /health
router.get('/health', (req, res) => res.json({ status: 'ok', module: 'warroom-builder' }));

// ── Push handler (token auth, no JWT) — dipanggil dari Apps Script ──
// POST /api/warroom-builder/push/:id  (didaftarkan di app.js sebelum requireAuth)
const WB_PUSH_TOKEN = 'bric2026bimasaktisecret';

async function pushHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== WB_PUSH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { csv, columns, rows } = req.body;

  // Terima format CSV string (baru, lebih cepat) atau columns+rows (lama)
  let csvText;
  if (csv && typeof csv === 'string') {
    csvText = csv;
  } else if (Array.isArray(columns) && Array.isArray(rows)) {
    const csvLines = [columns.join(',')];
    for (const row of rows) {
      const vals = columns.map(c => {
        const v = row[c] !== undefined ? String(row[c]) : '';
        return v.includes(',') || v.includes('"') || v.includes('\n')
          ? '"' + v.replace(/"/g, '""') + '"' : v;
      });
      csvLines.push(vals.join(','));
    }
    csvText = csvLines.join('\n');
  } else {
    return res.status(400).json({ error: 'csv string atau columns[]+rows[] wajib ada' });
  }

  const t0 = Date.now();
  try {

    const allRows     = parseCSV(csvText);
    const { headerRows, dataStartRow } = detectHeaderRows(allRows);
    const flatCols    = flattenMultiHeader(allRows.slice(0, headerRows), headerRows);
    const dataRows    = allRows.slice(dataStartRow);
    const periodInfo  = detectPeriod(flatCols, allRows.slice(0, 3));

    // Semua baris sebagai objek (untuk generate), preview UI cukup 20
    const allDataObjs = dataRows.map(row => {
      const obj = {};
      flatCols.forEach((col, i) => { obj[col] = row[i] !== undefined ? row[i] : ''; });
      return obj;
    });
    const previewRows = allDataObjs.slice(0, 20);

    const autoMappings = flatCols.map(col => {
      const { field, confidence } = autoDetectField(col);
      return {
        original_col: col,
        standard_field: field,
        confidence,
        data_type: field && ['entity_id','entity_name','category','province','city','pic','no_hp',
          'registration_date','first_trx_date','last_trx_date','growth_status'].includes(field)
          ? 'text' : 'number',
      };
    });

    await pool.query('DELETE FROM wb_sheet_sources WHERE warroom_id=$1', [id]);
    await pool.query(`
      INSERT INTO wb_sheet_sources
        (warroom_id, sheet_url, sheet_id, gid, csv_url, header_rows,
         detected_day, detected_period, raw_preview, detected_cols)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, 'apps-script-push', null, null, null, headerRows,
       periodInfo.cutoff_day ? `Day ${periodInfo.cutoff_day}` : null,
       periodInfo.period_type,
       allDataObjs,   // simpan SEMUA baris — generate akan pakai ini
       flatCols]      // JSONB: pass array langsung, pg handle serialize
    );

    // Simpan auto_mappings ke wb_column_mappings agar wizard bisa lanjut
    await pool.query('DELETE FROM wb_column_mappings WHERE warroom_id=$1', [id]);
    for (const m of autoMappings) {
      await pool.query(
        `INSERT INTO wb_column_mappings
           (warroom_id, original_col, standard_field, confidence, data_type)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, m.original_col, m.standard_field || null, m.confidence || 0, m.data_type || 'text']
      );
    }

    await pool.query(`
      INSERT INTO wb_import_logs (warroom_id, action, status, rows_processed, duration_ms)
      VALUES ($1,'push','success',$2,$3)`,
      [id, dataRows.length, Date.now() - t0]);

    res.json({
      ok: true,
      rows_received: rows.length,
      rows_parsed: dataRows.length,
      columns: flatCols,
      period_info: periodInfo,
      auto_mappings: autoMappings,
      preview: previewRows,
    });
  } catch (e) {
    console.error('[WB push]', e.message);
    await pool.query(`
      INSERT INTO wb_import_logs (warroom_id, action, status, error_message, duration_ms)
      VALUES ($1,'push','failed',$2,$3)`,
      [id, e.message, Date.now() - t0]).catch(() => {});
    res.status(500).json({ error: e.message });
  }
}

module.exports = router;
module.exports.pushHandler = pushHandler;
