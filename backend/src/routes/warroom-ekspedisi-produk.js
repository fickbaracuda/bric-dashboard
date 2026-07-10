/**
 * WAR-ROOM Ekspedisi > Produk Ekspedisi
 *
 * Sumber: 2 sheet Google Sheet ("Rev per produk", "Rev produk per outlet") dari
 * spreadsheet Ekspedisi (1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo) — domain
 * TERPISAH dari ekspedisi_monthly (warroom-ekspedisi.js), jangan disatukan.
 *
 * Sync menerima payload SUDAH-TERSTRUKTUR dari Apps Script (bukan raw sheet
 * row) — lihat docs/EKSPEDISI_PRODUK.md §Payload Contract.
 */

const pool = require('../db');

// Sengaja TIDAK ADA fallback hardcoded — kalau env belum diset di server,
// semua sync request ditolak 401 sampai admin set EKSPEDISI_PRODUK_SYNC_TOKEN.
const SYNC_TOKEN = process.env.EKSPEDISI_PRODUK_SYNC_TOKEN;
const SYNC_KEY = 'ekspedisi_produk';

const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];
const FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];

// ─────────────────────────────────────────────────────────────────────────
// Helpers dasar
// ─────────────────────────────────────────────────────────────────────────
function extractToken(req) {
  return (
    req.headers['x-sync-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.body?.token ||
    null
  );
}

function nullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function isFormulaError(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toUpperCase();
  return FORMULA_ERRORS.includes(s);
}

/**
 * Parser angka aman. Sama aturan dengan pola BRIC yang sudah ada (lihat
 * insiden Speedcash 100x): typeof number langsung dipakai, TIDAK diproses
 * string. Untuk sheet ini titik DAN koma berarti pemisah ribuan (bukan
 * desimal) — contoh: "1,000" -> 1000, "1.000" -> 1000, "23.902.300" -> 23902300.
 */
function safeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  if (isFormulaError(raw)) return null;
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function isValidBulan(bulan) {
  return typeof bulan === 'string' && /^\d{4}-\d{2}$/.test(bulan);
}

function monthLabel(bulan) {
  if (!isValidBulan(bulan)) return bulan || '-';
  const idx = parseInt(bulan.split('-')[1], 10) - 1;
  const monthName = MONTHS_ID[idx] || bulan;
  return `${monthName} ${bulan.split('-')[0]}`;
}

function toIsoDate(value) {
  const s = nullIfEmpty(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/ekspedisi-produk/months
// ─────────────────────────────────────────────────────────────────────────
async function monthsHandler(req, res) {
  try {
    const configRes = await pool.query(
      'SELECT month_list FROM ekspedisi_produk_config WHERE sync_key = $1',
      [SYNC_KEY]
    );
    const monthList = configRes.rows[0]?.month_list;
    if (Array.isArray(monthList) && monthList.length) {
      return res.json(monthList.map(m => ({ bulan: m.bulan, label: m.label || monthLabel(m.bulan) })));
    }

    // Fallback: derive dari data yang sudah tersimpan kalau config belum ada
    const distinctRes = await pool.query(`
      SELECT bulan, MIN(bulan_label) AS bulan_label FROM (
        SELECT bulan, bulan_label FROM ekspedisi_produk_summary
        UNION ALL
        SELECT bulan, bulan_label FROM ekspedisi_produk_outlet
      ) t
      GROUP BY bulan ORDER BY bulan ASC
    `);
    res.json(distinctRes.rows.map(r => ({ bulan: r.bulan, label: r.bulan_label || monthLabel(r.bulan) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/ekspedisi-produk/sync
// ─────────────────────────────────────────────────────────────────────────
async function syncHandler(req, res) {
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  if (nullIfEmpty(body.sync_key) !== SYNC_KEY) {
    return res.status(400).json({ error: `sync_key wajib "${SYNC_KEY}"` });
  }
  const months = Array.isArray(body.months) ? body.months.filter(m => isValidBulan(m?.bulan)) : [];
  if (!months.length) {
    return res.status(400).json({ error: 'months[] wajib berisi minimal 1 bulan valid (format YYYY-MM)' });
  }
  const bulanSet = months.map(m => m.bulan);
  const summaryRows = Array.isArray(body.summary) ? body.summary : [];
  const outletRows = Array.isArray(body.outlets) ? body.outlets : [];

  // Dedup by unique key SEBELUM insert (jejak duplikat hilang setelah upsert)
  const summaryMap = new Map();
  let summaryDup = 0;
  let summaryMissingId = 0;
  const summaryEntries = [];
  for (const row of summaryRows) {
    const bulan = nullIfEmpty(row?.bulan);
    const idProduk = nullIfEmpty(row?.id_produk);
    if (!isValidBulan(bulan) || !bulanSet.includes(bulan)) continue;
    if (!idProduk) { summaryMissingId++; continue; }
    const key = `${bulan}|${idProduk}`;
    if (summaryMap.has(key)) summaryDup++;
    summaryMap.set(key, row);
  }
  summaryEntries.push(...summaryMap.values());

  const outletMap = new Map();
  let outletDup = 0;
  let outletMissingId = 0;
  for (const row of outletRows) {
    const bulan = nullIfEmpty(row?.bulan);
    const idProduk = nullIfEmpty(row?.id_produk);
    const idOutlet = nullIfEmpty(row?.id_outlet);
    if (!isValidBulan(bulan) || !bulanSet.includes(bulan)) continue;
    if (!idProduk || !idOutlet) { outletMissingId++; continue; }
    const key = `${bulan}|${row?.tanggal || ''}|${idOutlet}|${idProduk}|${row?.source_row ?? ''}`;
    if (outletMap.has(key)) outletDup++;
    outletMap.set(key, row);
  }
  const outletEntries = [...outletMap.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Upsert config
    await client.query(
      `INSERT INTO ekspedisi_produk_config (sync_key, source_url, as_of_date, day_number, month_list, source_meta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (sync_key) DO UPDATE SET
         source_url = EXCLUDED.source_url, as_of_date = EXCLUDED.as_of_date, day_number = EXCLUDED.day_number,
         month_list = EXCLUDED.month_list, source_meta = EXCLUDED.source_meta, updated_at = NOW()`,
      [
        SYNC_KEY, nullIfEmpty(body.source_url), nullIfEmpty(body.as_of_date),
        Number.isFinite(Number(body.day_number)) ? Number(body.day_number) : null,
        JSON.stringify(months), JSON.stringify(body.meta || {}),
      ]
    );

    // 2) Delete data lama HANYA untuk bulan di payload
    await client.query('DELETE FROM ekspedisi_produk_summary WHERE bulan = ANY($1)', [bulanSet]);
    await client.query('DELETE FROM ekspedisi_produk_outlet WHERE bulan = ANY($1)', [bulanSet]);

    // 3) Insert summary
    let summaryInserted = 0;
    for (const row of summaryEntries) {
      const mat = safeNumber(row.mat);
      const jmlBill = safeNumber(row.jml_bill);
      const marginFp = safeNumber(row.margin_fp);
      await client.query(
        `INSERT INTO ekspedisi_produk_summary
           (bulan, bulan_label, id_produk, produk, mat, jml_bill, margin_fp, vs_mei, vs_jun,
            source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (bulan, id_produk) DO UPDATE SET
           bulan_label = EXCLUDED.bulan_label, produk = EXCLUDED.produk, mat = EXCLUDED.mat,
           jml_bill = EXCLUDED.jml_bill, margin_fp = EXCLUDED.margin_fp,
           vs_mei = EXCLUDED.vs_mei, vs_jun = EXCLUDED.vs_jun,
           source_sheet = EXCLUDED.source_sheet, source_row = EXCLUDED.source_row,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          row.bulan, nullIfEmpty(row.bulan_label) || monthLabel(row.bulan), row.id_produk, nullIfEmpty(row.produk),
          mat, jmlBill, marginFp, safeNumber(row.vs_mei), safeNumber(row.vs_jun),
          nullIfEmpty(row.source_sheet), Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      summaryInserted++;
    }

    // 4) Insert outlets
    let outletInserted = 0;
    for (const row of outletEntries) {
      await client.query(
        `INSERT INTO ekspedisi_produk_outlet
           (bulan, bulan_label, tanggal, id_outlet, id_produk, jml_bill, margin_fp,
            source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (bulan, tanggal, id_outlet, id_produk, source_row) DO UPDATE SET
           bulan_label = EXCLUDED.bulan_label, jml_bill = EXCLUDED.jml_bill, margin_fp = EXCLUDED.margin_fp,
           source_sheet = EXCLUDED.source_sheet, raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          row.bulan, nullIfEmpty(row.bulan_label) || monthLabel(row.bulan), toIsoDate(row.tanggal),
          row.id_outlet, row.id_produk, safeNumber(row.jml_bill), safeNumber(row.margin_fp),
          nullIfEmpty(row.source_sheet), Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      outletInserted++;
    }

    // 5) Sync log sukses
    await client.query(
      `INSERT INTO ekspedisi_produk_sync_log
         (sync_key, summary_rows_received, summary_rows_inserted, outlet_rows_received, outlet_rows_inserted,
          bulan_list, status, error_message, payload_meta, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,'success',NULL,$7,NOW())`,
      [
        SYNC_KEY, summaryRows.length, summaryInserted, outletRows.length, outletInserted,
        JSON.stringify(bulanSet),
        JSON.stringify({
          duplicate_summary_count: summaryDup,
          duplicate_outlet_count: outletDup,
          missing_id_produk_summary: summaryMissingId,
          missing_id_outlet_or_produk: outletMissingId,
          sheet_names: body.meta?.sheet_names || [],
          synced_by: body.meta?.synced_by || null,
          formula_error_count: Number(body.meta?.formula_error_count || 0),
          parse_warnings: body.meta?.parse_warnings || [],
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      bulan_list: bulanSet,
      summary_rows_inserted: summaryInserted,
      outlet_rows_inserted: outletInserted,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    try {
      await pool.query(
        `INSERT INTO ekspedisi_produk_sync_log
           (sync_key, summary_rows_received, summary_rows_inserted, outlet_rows_received, outlet_rows_inserted,
            bulan_list, status, error_message, payload_meta, synced_at)
         VALUES ($1,$2,0,$3,0,$4,'failed',$5,'{}',NOW())`,
        [SYNC_KEY, summaryRows.length, outletRows.length, JSON.stringify(bulanSet), String(err.message || 'unknown error').slice(0, 500)]
      );
    } catch (_) { /* jangan sampai gagal logging menutupi error asli */ }
    console.error('ekspedisi-produk sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/ekspedisi-produk/analytics?bulan=2026-07
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const configRes = await pool.query('SELECT * FROM ekspedisi_produk_config WHERE sync_key = $1', [SYNC_KEY]);
    const config = configRes.rows[0] || null;

    const monthList = Array.isArray(config?.month_list) ? config.month_list : [];
    const availableMonths = monthList.map(m => m.bulan).filter(isValidBulan).sort();

    let bulan = isValidBulan(req.query.bulan) ? req.query.bulan : null;
    if (!bulan || !availableMonths.includes(bulan)) {
      bulan = availableMonths[availableMonths.length - 1] || null;
    }

    if (!bulan) {
      return res.json({
        empty: true,
        message: 'Data Produk Ekspedisi belum tersedia. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { available_months: availableMonths.map(b => ({ bulan: b, label: monthLabel(b) })) },
      });
    }

    const idx = availableMonths.indexOf(bulan);
    const previousBulan = idx > 0 ? availableMonths[idx - 1] : null;

    const [summaryRes, prevSummaryRes, outletRes, lastSyncRes] = await Promise.all([
      pool.query('SELECT * FROM ekspedisi_produk_summary WHERE bulan = $1 ORDER BY id_produk', [bulan]),
      previousBulan
        ? pool.query('SELECT * FROM ekspedisi_produk_summary WHERE bulan = $1', [previousBulan])
        : Promise.resolve({ rows: [] }),
      pool.query('SELECT * FROM ekspedisi_produk_outlet WHERE bulan = $1', [bulan]),
      pool.query(`SELECT MAX(synced_at) AS t FROM ekspedisi_produk_sync_log WHERE sync_key = $1 AND status = 'success'`, [SYNC_KEY]),
    ]);

    const rows = summaryRes.rows;
    const prevByProduk = new Map(prevSummaryRes.rows.map(r => [r.id_produk, r]));

    if (!rows.length) {
      return res.json({
        empty: true,
        message: 'Bulan belum tersedia.',
        meta: { bulan, bulan_label: monthLabel(bulan), available_months: availableMonths.map(b => ({ bulan: b, label: monthLabel(b) })) },
      });
    }

    // ── Cari bulan Mei/Juni (dalam tahun yang sama dengan bulan aktif) untuk perbandingan tetap ──
    const [curYear] = bulan.split('-');
    const meiBulan = availableMonths.find(b => b === `${curYear}-05`);
    const junBulan = availableMonths.find(b => b === `${curYear}-06`);
    const totalMarginFor = async (b) => {
      if (!b) return null;
      const r = await pool.query('SELECT COALESCE(SUM(margin_fp),0) AS t FROM ekspedisi_produk_summary WHERE bulan = $1', [b]);
      return Number(r.rows[0]?.t || 0);
    };
    const [totalMarginMei, totalMarginJun] = await Promise.all([totalMarginFor(meiBulan), totalMarginFor(junBulan)]);

    // ── Klasifikasi produk besar (untuk P0) — di atas median margin_fp bulan ini ──
    const marginArr = rows.map(r => Number(r.margin_fp) || 0).filter(v => v > 0).sort((a, b) => a - b);
    const medianMargin = marginArr.length
      ? (marginArr.length % 2 ? marginArr[(marginArr.length - 1) / 2]
        : (marginArr[marginArr.length / 2 - 1] + marginArr[marginArr.length / 2]) / 2)
      : 0;

    const RECO_BY_STATUS = {
      P0: 'Perlu perhatian segera — produk besar mengalami penurunan margin tajam.',
      P1: 'Margin menurun, masih aktif — cek penyebab dan lakukan follow-up.',
      P2: 'Performa stabil — pertahankan momentum saat ini.',
      P3: 'Pertumbuhan signifikan — jadikan benchmark, cari faktor pendorong untuk direplikasi.',
      P4: 'Data tidak lengkap / tidak ada aktivitas — cek sinkronisasi sheet.',
    };

    const products = rows.map(r => {
      const prev = prevByProduk.get(r.id_produk) || null;
      const mat = r.mat !== null ? Number(r.mat) : null;
      const jmlBill = r.jml_bill !== null ? Number(r.jml_bill) : null;
      const marginFp = r.margin_fp !== null ? Number(r.margin_fp) : null;
      const prevMat = prev?.mat !== null && prev?.mat !== undefined ? Number(prev.mat) : null;
      const prevJmlBill = prev?.jml_bill !== null && prev?.jml_bill !== undefined ? Number(prev.jml_bill) : null;
      const prevMarginFp = prev?.margin_fp !== null && prev?.margin_fp !== undefined ? Number(prev.margin_fp) : null;

      const marginGrowthValue = (marginFp !== null && prevMarginFp !== null) ? (marginFp - prevMarginFp) : null;
      const marginGrowthPct = safeDiv(marginGrowthValue, prevMarginFp);
      const billGrowthPct = (jmlBill !== null && prevJmlBill) ? safeDiv(jmlBill - prevJmlBill, prevJmlBill) : null;
      const matGrowthPct = (mat !== null && prevMat) ? safeDiv(mat - prevMat, prevMat) : null;

      let status;
      if (!prev) status = 'no_data';
      else if ((marginFp || 0) === 0) status = 'zero_activity';
      else if (marginGrowthPct !== null && marginGrowthPct > 0.05) status = 'naik';
      else if (marginGrowthPct !== null && marginGrowthPct < -0.05) status = 'turun';
      else status = 'stabil';

      const isBigProduk = (marginFp || 0) >= medianMargin && medianMargin > 0;
      let priority;
      if (status === 'no_data' || status === 'zero_activity') priority = 'P4';
      else if (status === 'turun' && isBigProduk && marginGrowthPct <= -0.2) priority = 'P0';
      else if (status === 'turun') priority = 'P1';
      else if (status === 'naik' && marginGrowthPct > 0.2) priority = 'P3';
      else priority = 'P2';

      return {
        id_produk: r.id_produk,
        produk: r.produk,
        mat, jml_bill: jmlBill, margin_fp: marginFp,
        avg_margin_per_bill: safeDiv(marginFp, jmlBill),
        avg_bill_per_mat: safeDiv(jmlBill, mat),
        previous_margin_fp: prevMarginFp,
        previous_jml_bill: prevJmlBill,
        previous_mat: prevMat,
        margin_growth_value: marginGrowthValue,
        margin_growth_pct: marginGrowthPct,
        bill_growth_pct: billGrowthPct,
        mat_growth_pct: matGrowthPct,
        vs_mei: r.vs_mei !== null ? Number(r.vs_mei) : null,
        vs_jun: r.vs_jun !== null ? Number(r.vs_jun) : null,
        status, priority,
        recommendation: RECO_BY_STATUS[priority],
      };
    });

    // ── Summary / KPI ──
    const totalMat = products.reduce((s, p) => s + (p.mat || 0), 0);
    const totalJmlBill = products.reduce((s, p) => s + (p.jml_bill || 0), 0);
    const totalMarginFp = products.reduce((s, p) => s + (p.margin_fp || 0), 0);
    const totalMarginFpPrev = previousBulan ? prevSummaryRes.rows.reduce((s, r) => s + (Number(r.margin_fp) || 0), 0) : null;

    const summary = {
      total_produk: products.length,
      total_mat: totalMat,
      total_jml_bill: totalJmlBill,
      total_margin_fp: totalMarginFp,
      avg_margin_per_bill: safeDiv(totalMarginFp, totalJmlBill),
      avg_bill_per_mat: safeDiv(totalJmlBill, totalMat),
      produk_naik_vs_previous_count: products.filter(p => p.status === 'naik').length,
      produk_turun_vs_previous_count: products.filter(p => p.status === 'turun').length,
      produk_margin_0_count: products.filter(p => p.status === 'zero_activity').length,
      margin_growth_vs_previous_pct: previousBulan ? safeDiv(totalMarginFp - totalMarginFpPrev, totalMarginFpPrev) : null,
      bill_growth_vs_previous_pct: previousBulan
        ? safeDiv(totalJmlBill - prevSummaryRes.rows.reduce((s, r) => s + (Number(r.jml_bill) || 0), 0), prevSummaryRes.rows.reduce((s, r) => s + (Number(r.jml_bill) || 0), 0))
        : null,
      mat_growth_vs_previous_pct: previousBulan
        ? safeDiv(totalMat - prevSummaryRes.rows.reduce((s, r) => s + (Number(r.mat) || 0), 0), prevSummaryRes.rows.reduce((s, r) => s + (Number(r.mat) || 0), 0))
        : null,
      margin_growth_vs_may_pct: (meiBulan && meiBulan !== bulan) ? safeDiv(totalMarginFp - totalMarginMei, totalMarginMei) : null,
      margin_growth_vs_june_pct: (junBulan && junBulan !== bulan) ? safeDiv(totalMarginFp - totalMarginJun, totalMarginJun) : null,
    };

    // ── Top Products ──
    const sortedByMargin = [...products].sort((a, b) => (b.margin_fp || 0) - (a.margin_fp || 0));
    const sortedByBill = [...products].sort((a, b) => (b.jml_bill || 0) - (a.jml_bill || 0));
    const sortedByMat = [...products].sort((a, b) => (b.mat || 0) - (a.mat || 0));
    const growthCandidates = products.filter(p => p.margin_growth_pct !== null).sort((a, b) => b.margin_growth_pct - a.margin_growth_pct);
    const declineCandidates = products.filter(p => p.margin_growth_pct !== null).sort((a, b) => a.margin_growth_pct - b.margin_growth_pct);

    const topProducts = {
      top_by_margin: sortedByMargin.slice(0, 10),
      top_by_bill: sortedByBill.slice(0, 10),
      top_by_mat: sortedByMat.slice(0, 10),
      top_growth: growthCandidates.filter(p => p.margin_growth_pct > 0).slice(0, 10),
      top_decline: declineCandidates.filter(p => p.margin_growth_pct < 0).slice(0, 10),
    };

    // ── Outlet Summary ──
    const outletRows = outletRes.rows;
    const outletSet = new Set(outletRows.map(r => r.id_outlet));
    const outletAggMargin = new Map();
    const outletAggBill = new Map();
    const outletByProduk = new Map(); // id_outlet -> Set(id_produk)
    const produkByOutletCount = new Map(); // id_produk -> Set(id_outlet)
    for (const r of outletRows) {
      const margin = Number(r.margin_fp) || 0;
      const bill = Number(r.jml_bill) || 0;
      outletAggMargin.set(r.id_outlet, (outletAggMargin.get(r.id_outlet) || 0) + margin);
      outletAggBill.set(r.id_outlet, (outletAggBill.get(r.id_outlet) || 0) + bill);
      if (!outletByProduk.has(r.id_outlet)) outletByProduk.set(r.id_outlet, new Set());
      outletByProduk.get(r.id_outlet).add(r.id_produk);
      if (!produkByOutletCount.has(r.id_produk)) produkByOutletCount.set(r.id_produk, new Set());
      produkByOutletCount.get(r.id_produk).add(r.id_outlet);
    }

    const outletSummary = {
      active_outlet_count: outletSet.size,
      outlet_rows: outletRows.length,
      outlet_total_bill: outletRows.reduce((s, r) => s + (Number(r.jml_bill) || 0), 0),
      outlet_total_margin: outletRows.reduce((s, r) => s + (Number(r.margin_fp) || 0), 0),
      top_outlets_by_margin: [...outletAggMargin.entries()]
        .map(([id_outlet, margin_fp]) => ({ id_outlet, margin_fp, jml_bill: outletAggBill.get(id_outlet) || 0 }))
        .sort((a, b) => b.margin_fp - a.margin_fp).slice(0, 20),
      top_outlets_by_bill: [...outletAggBill.entries()]
        .map(([id_outlet, jml_bill]) => ({ id_outlet, jml_bill, margin_fp: outletAggMargin.get(id_outlet) || 0 }))
        .sort((a, b) => b.jml_bill - a.jml_bill).slice(0, 20),
      outlet_by_product_count: [...produkByOutletCount.entries()]
        .map(([id_produk, set]) => ({ id_produk, outlet_count: set.size }))
        .sort((a, b) => b.outlet_count - a.outlet_count),
    };

    // ── Matrix Summary ──
    const produkWithOutletIds = new Set(outletRows.map(r => r.id_produk));
    const produkIdsSummary = new Set(products.map(p => p.id_produk));
    const produkTanpaOutletDetail = [...produkIdsSummary].filter(id => !produkWithOutletIds.has(id));
    const outletDenganMultiProduk = [...outletByProduk.values()].filter(set => set.size > 1).length;
    const produkTerbanyakOutlet = outletSummary.outlet_by_product_count[0] || null;

    const matrixSummary = {
      produk_dengan_outlet_aktif_count: produkWithOutletIds.size,
      produk_tanpa_outlet_detail: produkTanpaOutletDetail,
      produk_tanpa_outlet_detail_count: produkTanpaOutletDetail.length,
      outlet_dengan_multi_produk_count: outletDenganMultiProduk,
      produk_dengan_outlet_terbanyak: produkTerbanyakOutlet,
    };

    // ── Data Quality ──
    const lastSyncLogRes = await pool.query(
      `SELECT payload_meta FROM ekspedisi_produk_sync_log WHERE sync_key = $1 AND status = 'success' ORDER BY synced_at DESC LIMIT 1`,
      [SYNC_KEY]
    );
    const lastMeta = lastSyncLogRes.rows[0]?.payload_meta || {};

    const outletProdukIdsForBulan = new Set(outletRows.map(r => r.id_produk));
    const outletWithoutSummaryProduct = [...outletProdukIdsForBulan].filter(id => !produkIdsSummary.has(id));

    // total mismatch summary vs outlet (bandingkan jml_bill per produk, >20% dianggap perlu dicek)
    const outletBillByProduk = new Map();
    for (const r of outletRows) {
      outletBillByProduk.set(r.id_produk, (outletBillByProduk.get(r.id_produk) || 0) + (Number(r.jml_bill) || 0));
    }
    let mismatchCount = 0;
    for (const p of products) {
      const outletBill = outletBillByProduk.get(p.id_produk) || 0;
      if ((p.jml_bill || 0) > 0 || outletBill > 0) {
        const base = Math.max(p.jml_bill || 0, outletBill, 1);
        if (Math.abs((p.jml_bill || 0) - outletBill) / base > 0.2) mismatchCount++;
      }
    }

    const dqChecks = [
      { key: 'formula_error_count', label: 'Formula error dari Google Sheet (#NAME?, #DIV/0!, dst)', count: Number(lastMeta.formula_error_count || 0), recommendation: 'Cek cell terkait di Google Sheet, perbaiki formula sumber.' },
      { key: 'missing_id_produk', label: 'Baris "Rev per produk" tanpa ID Produk (dilewati saat sync)', count: Number(lastMeta.missing_id_produk_summary || 0), recommendation: 'Lengkapi ID Produk di sheet "Rev per produk".' },
      { key: 'missing_produk_name', label: 'Produk tanpa nama', count: products.filter(p => !p.produk).length, recommendation: 'Lengkapi kolom nama produk di sheet.' },
      { key: 'invalid_mat', label: 'MAT tidak terbaca', count: products.filter(p => p.mat === null).length, recommendation: 'Cek format angka/formula di kolom MAT.' },
      { key: 'invalid_jml_bill', label: 'Jml Bill tidak terbaca', count: products.filter(p => p.jml_bill === null).length, recommendation: 'Cek format angka/formula di kolom Jml Bill.' },
      { key: 'invalid_margin_fp', label: 'Margin FP tidak terbaca', count: products.filter(p => p.margin_fp === null).length, recommendation: 'Cek format angka/formula di kolom Margin FP.' },
      { key: 'summary_without_outlet_detail', label: 'Produk di summary tanpa detail outlet', count: produkTanpaOutletDetail.length, recommendation: 'Cek sheet "Rev produk per outlet" untuk produk ini.' },
      { key: 'outlet_without_summary_product', label: 'ID Produk di outlet tapi tidak ada di summary', count: outletWithoutSummaryProduct.length, recommendation: 'Cek konsistensi ID Produk antara 2 sheet sumber.' },
      { key: 'duplicate_summary_product', label: 'Baris produk duplikat di sync terakhir', count: Number(lastMeta.duplicate_summary_count || 0), recommendation: 'Cek sheet "Rev per produk" untuk baris duplikat.' },
      { key: 'month_data_missing', label: 'Bulan terdeteksi kurang dari 3', count: availableMonths.length < 3 ? 1 : 0, recommendation: 'Pastikan minimal 3 bulan (Mei/Jun/Jul) sudah tersinkron.' },
      { key: 'total_mismatch_summary_vs_outlet', label: 'Selisih Jml Bill Summary vs Outlet per produk >20%', count: mismatchCount, recommendation: 'Bandingkan angka "Rev per produk" dengan total "Rev produk per outlet" per produk.' },
    ].map(c => ({ ...c, severity: c.count === 0 ? 'low' : (c.count >= 3 ? 'high' : 'medium') }));

    // ── Insights (maks 5) ──
    const insights = [];
    if (summary.margin_growth_vs_previous_pct !== null) {
      insights.push({
        id: 'margin_growth_previous',
        severity: summary.margin_growth_vs_previous_pct < 0 ? 'high' : 'low',
        text: `Margin ${monthLabel(bulan)} ${summary.margin_growth_vs_previous_pct >= 0 ? 'naik' : 'turun'} ${Math.abs(summary.margin_growth_vs_previous_pct * 100).toFixed(1)}% dibanding ${monthLabel(previousBulan)}.`,
      });
    }
    const bigDeclines = products.filter(p => p.priority === 'P0');
    if (bigDeclines.length) {
      insights.push({ id: 'big_decline', severity: 'high', text: `${bigDeclines.length} produk utama (margin besar) turun tajam: ${bigDeclines.slice(0, 3).map(p => p.produk || p.id_produk).join(', ')}.` });
    }
    const zeroActivity = products.filter(p => p.status === 'zero_activity');
    if (zeroActivity.length) {
      insights.push({ id: 'zero_activity', severity: 'medium', text: `${zeroActivity.length} produk tanpa margin sama sekali bulan ini.` });
    }
    if (outletSummary.active_outlet_count > 0 && outletSummary.top_outlets_by_margin.length) {
      const top10Margin = outletSummary.top_outlets_by_margin.slice(0, 10).reduce((s, o) => s + o.margin_fp, 0);
      const risk = safeDiv(top10Margin, outletSummary.outlet_total_margin);
      if (risk !== null && risk > 0.5) {
        insights.push({ id: 'outlet_concentration', severity: 'medium', text: `Top 10 outlet menyumbang ${(risk * 100).toFixed(1)}% margin — cek risiko ketergantungan outlet.` });
      }
    }
    const topGrowth = topProducts.top_growth[0];
    if (topGrowth) {
      insights.push({ id: 'top_growth', severity: 'low', text: `Pertumbuhan margin tertinggi: ${topGrowth.produk || topGrowth.id_produk} (+${(topGrowth.margin_growth_pct * 100).toFixed(1)}%).` });
    }
    const dqIssueTotal = dqChecks.reduce((s, c) => s + c.count, 0);
    if (dqIssueTotal > 0 && insights.length < 5) {
      insights.push({ id: 'data_quality', severity: dqIssueTotal >= 5 ? 'high' : 'medium', text: `${dqIssueTotal} isu data quality ditemukan — lihat panel Data Quality untuk detail.` });
    }

    // ── Action Summary (maks 20) ──
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
    const actionSummary = [];
    for (const p of products.filter(p => p.priority !== 'P2').sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])) {
      actionSummary.push({
        priority: p.priority,
        title: p.produk || p.id_produk,
        id_produk: p.id_produk,
        count: 1,
        recommendation: p.recommendation,
      });
    }
    for (const c of dqChecks) {
      if (c.count > 0 && actionSummary.length < 20) {
        actionSummary.push({ priority: 'P4', title: c.label, id_produk: null, count: c.count, recommendation: c.recommendation });
      }
    }

    res.json({
      meta: {
        bulan,
        bulan_label: monthLabel(bulan),
        previous_bulan: previousBulan,
        previous_bulan_label: previousBulan ? monthLabel(previousBulan) : null,
        source_url: config?.source_url || null,
        as_of_date: config?.as_of_date || null,
        day_number: config?.day_number ?? null,
        last_sync: lastSyncRes.rows[0]?.t || null,
        available_months: availableMonths.map(b => ({ bulan: b, label: monthLabel(b) })),
      },
      summary,
      products,
      top_products: topProducts,
      outlet_summary: outletSummary,
      matrix_summary: matrixSummary,
      insights: insights.slice(0, 5),
      action_summary: actionSummary.slice(0, 20),
      data_quality: dqChecks,
    });
  } catch (e) {
    console.error('ekspedisi-produk analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/ekspedisi-produk/outlets?bulan=&id_produk=&page=&limit=&search=
// ─────────────────────────────────────────────────────────────────────────
async function outletsHandler(req, res) {
  try {
    const bulan = isValidBulan(req.query.bulan) ? req.query.bulan : null;
    if (!bulan) return res.status(400).json({ error: 'bulan wajib diisi, format YYYY-MM' });

    const idProduk = nullIfEmpty(req.query.id_produk);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const search = nullIfEmpty(req.query.search);
    const offset = (page - 1) * limit;

    const conditions = ['bulan = $1'];
    const params = [bulan];
    if (idProduk) { params.push(idProduk); conditions.push(`id_produk = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(id_outlet ILIKE $${params.length} OR id_produk ILIKE $${params.length})`);
    }
    const whereClause = conditions.join(' AND ');

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM ekspedisi_produk_outlet WHERE ${whereClause}`, params);
    const total = Number(countRes.rows[0]?.total || 0);

    params.push(limit, offset);
    const rowsRes = await pool.query(
      `SELECT tanggal, id_outlet, id_produk, jml_bill, margin_fp
       FROM ekspedisi_produk_outlet WHERE ${whereClause}
       ORDER BY tanggal DESC, id_outlet ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Nama produk (lookup ringan ke summary bulan yang sama)
    const produkIds = [...new Set(rowsRes.rows.map(r => r.id_produk))];
    let produkNameMap = new Map();
    if (produkIds.length) {
      const nameRes = await pool.query(
        'SELECT id_produk, produk FROM ekspedisi_produk_summary WHERE bulan = $1 AND id_produk = ANY($2)',
        [bulan, produkIds]
      );
      produkNameMap = new Map(nameRes.rows.map(r => [r.id_produk, r.produk]));
    }

    res.json({
      meta: { bulan, id_produk: idProduk, page, limit, total },
      rows: rowsRes.rows.map(r => {
        const jmlBill = r.jml_bill !== null ? Number(r.jml_bill) : null;
        const marginFp = r.margin_fp !== null ? Number(r.margin_fp) : null;
        return {
          tanggal: r.tanggal,
          id_outlet: r.id_outlet,
          id_produk: r.id_produk,
          produk: produkNameMap.get(r.id_produk) || null,
          jml_bill: jmlBill,
          margin_fp: marginFp,
          avg_margin_per_bill: safeDiv(marginFp, jmlBill),
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  monthsHandler,
  syncHandler,
  analyticsHandler,
  outletsHandler,
  _internal: { safeNumber, safeDiv, isFormulaError, monthLabel, toIsoDate },
};
