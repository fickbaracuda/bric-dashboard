/**
 * WAR-ROOM Payment Agent > Produk — Marketing Decision Dashboard
 *
 * Sumber: 1 sheet Google Sheet "Produk" (spreadsheet
 * 1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw). Domain TERPISAH dari
 * pa_produk_snapshot/pa_produk_totals (warroom.js, legacy Apr/Mei/Jun
 * hardcode) dan dari warroom_pa_produk_periode (rolling m2/m1/curr window)
 * — jangan disatukan, jangan disentuh.
 *
 * BULAN 100% DINAMIS — tidak ada Mei/Juni/Juli hardcode di file ini.
 * Setiap snapshot_date membawa persis 3 bulan (baseline, previous, current
 * = bulan terakhir) dan 2 deviasi POSISIONAL:
 *   - baseline_vs_current  (kolom deviasi PERTAMA di sheet)
 *   - previous_vs_current  (kolom deviasi KEDUA di sheet)
 * compare_key WAJIB salah satu dari 2 nilai generik di atas (bukan nama
 * bulan) — lihat docs/PAYMENT_AGENT_PRODUK.md §Payload Contract.
 */

const pool = require('../db');

// Sengaja TIDAK ADA fallback hardcoded — kalau env belum diset di server,
// semua sync request ditolak 401 sampai admin set PAYMENT_AGENT_PRODUK_SYNC_TOKEN.
const SYNC_TOKEN = process.env.PAYMENT_AGENT_PRODUK_SYNC_TOKEN;
const SYNC_KEY = 'payment_agent_produk';

const FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];
const COMPARE_KEYS = ['baseline_vs_current', 'previous_vs_current'];

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
 * Parser angka aman — WAJIB cek typeof number dulu (lihat insiden Speedcash
 * 100x, CLAUDE.md §5). Titik/koma dianggap pemisah ribuan. Angka dalam
 * tanda kurung "(883,120,723)" dianggap NEGATIF.
 */
function safeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  if (isFormulaError(raw)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  let n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (negative) n = -Math.abs(n);
  return n;
}

function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function isValidMonthKey(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
}

function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/payment-agent/produk/snapshots
// ─────────────────────────────────────────────────────────────────────────
async function snapshotsHandler(req, res) {
  try {
    const rowsRes = await pool.query(`
      SELECT m.snapshot_date, m.day_number, MAX(l.synced_at) AS last_sync
      FROM (SELECT DISTINCT snapshot_date, day_number FROM payment_agent_produk_metrics) m
      LEFT JOIN payment_agent_produk_sync_log l
        ON l.snapshot_date = m.snapshot_date AND l.status = 'success'
      GROUP BY m.snapshot_date, m.day_number
      ORDER BY m.snapshot_date DESC
    `);
    res.json(rowsRes.rows.map(r => ({
      snapshot_date: r.snapshot_date,
      day_number: r.day_number,
      label: `Day ${r.day_number ?? '?'} - ${r.snapshot_date}`,
      last_sync: r.last_sync,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/payment-agent/produk/sync
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
  const snapshotDate = isValidDate(body.snapshot_date) ? body.snapshot_date : null;
  if (!snapshotDate) {
    return res.status(400).json({ error: 'snapshot_date wajib diisi, format YYYY-MM-DD' });
  }
  const dayNumber = Number.isFinite(Number(body.day_number)) ? Number(body.day_number) : null;

  const months = Array.isArray(body.months) ? body.months.filter(m => isValidMonthKey(m?.month_key)) : [];
  if (months.length < 2) {
    return res.status(400).json({ error: 'months[] wajib berisi minimal 2 bulan valid (format YYYY-MM)' });
  }

  const metricRows = Array.isArray(body.metrics) ? body.metrics : [];
  const deviationRows = Array.isArray(body.deviations) ? body.deviations : [];

  // Dedup by unique key SEBELUM insert
  const metricMap = new Map();
  let metricDup = 0;
  let metricMissingLabel = 0;
  for (const row of metricRows) {
    const monthKey = nullIfEmpty(row?.month_key);
    const label = nullIfEmpty(row?.product_label) || nullIfEmpty(row?.product_name);
    if (!isValidMonthKey(monthKey)) continue;
    if (!label) { metricMissingLabel++; continue; }
    const key = `${monthKey}|${label}`;
    if (metricMap.has(key)) metricDup++;
    metricMap.set(key, row);
  }
  const metricEntries = [...metricMap.values()];

  const deviationMap = new Map();
  let deviationDup = 0;
  let deviationMissingLabel = 0;
  for (const row of deviationRows) {
    const compareKey = nullIfEmpty(row?.compare_key);
    const label = nullIfEmpty(row?.product_label) || nullIfEmpty(row?.product_name);
    if (!COMPARE_KEYS.includes(compareKey)) continue;
    if (!label) { deviationMissingLabel++; continue; }
    const key = `${compareKey}|${label}`;
    if (deviationMap.has(key)) deviationDup++;
    deviationMap.set(key, row);
  }
  const deviationEntries = [...deviationMap.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO payment_agent_produk_config
         (sync_key, source_url, sheet_name, latest_snapshot_date, latest_day_number, month_list, source_meta, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (sync_key) DO UPDATE SET
         source_url = EXCLUDED.source_url, sheet_name = EXCLUDED.sheet_name,
         latest_snapshot_date = EXCLUDED.latest_snapshot_date, latest_day_number = EXCLUDED.latest_day_number,
         month_list = EXCLUDED.month_list, source_meta = EXCLUDED.source_meta, updated_at = NOW()`,
      [
        SYNC_KEY, nullIfEmpty(body.source_url), nullIfEmpty(body.sheet_name) || 'Produk',
        snapshotDate, dayNumber, JSON.stringify(months), JSON.stringify(body.meta || {}),
      ]
    );

    // Delete data lama HANYA untuk snapshot_date ini (bukan seluruh histori)
    await client.query('DELETE FROM payment_agent_produk_metrics WHERE snapshot_date = $1', [snapshotDate]);
    await client.query('DELETE FROM payment_agent_produk_deviation WHERE snapshot_date = $1', [snapshotDate]);

    let metricInserted = 0;
    for (const row of metricEntries) {
      await client.query(
        `INSERT INTO payment_agent_produk_metrics
           (snapshot_date, day_number, month_key, month_label, product_code, product_name, product_label,
            mat, trx, rev, arpt, atpu, arpu, source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (snapshot_date, month_key, product_label) DO UPDATE SET
           day_number = EXCLUDED.day_number, month_label = EXCLUDED.month_label,
           product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name,
           mat = EXCLUDED.mat, trx = EXCLUDED.trx, rev = EXCLUDED.rev,
           arpt = EXCLUDED.arpt, atpu = EXCLUDED.atpu, arpu = EXCLUDED.arpu,
           source_sheet = EXCLUDED.source_sheet, source_row = EXCLUDED.source_row,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          snapshotDate, dayNumber, row.month_key, nullIfEmpty(row.month_label),
          nullIfEmpty(row.product_code), nullIfEmpty(row.product_name) || nullIfEmpty(row.product_label),
          nullIfEmpty(row.product_label) || nullIfEmpty(row.product_name),
          safeNumber(row.mat), safeNumber(row.trx), safeNumber(row.rev),
          safeNumber(row.arpt), safeNumber(row.atpu), safeNumber(row.arpu),
          nullIfEmpty(row.source_sheet) || 'Produk',
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      metricInserted++;
    }

    let deviationInserted = 0;
    for (const row of deviationEntries) {
      await client.query(
        `INSERT INTO payment_agent_produk_deviation
           (snapshot_date, day_number, compare_key, compare_label, product_code, product_name, product_label,
            dev_mat, dev_trx, dev_rev, dev_arpt, dev_atpu, dev_arpu, source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (snapshot_date, compare_key, product_label) DO UPDATE SET
           day_number = EXCLUDED.day_number, compare_label = EXCLUDED.compare_label,
           product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name,
           dev_mat = EXCLUDED.dev_mat, dev_trx = EXCLUDED.dev_trx, dev_rev = EXCLUDED.dev_rev,
           dev_arpt = EXCLUDED.dev_arpt, dev_atpu = EXCLUDED.dev_atpu, dev_arpu = EXCLUDED.dev_arpu,
           source_sheet = EXCLUDED.source_sheet, source_row = EXCLUDED.source_row,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          snapshotDate, dayNumber, row.compare_key, nullIfEmpty(row.compare_label),
          nullIfEmpty(row.product_code), nullIfEmpty(row.product_name) || nullIfEmpty(row.product_label),
          nullIfEmpty(row.product_label) || nullIfEmpty(row.product_name),
          safeNumber(row.dev_mat), safeNumber(row.dev_trx), safeNumber(row.dev_rev),
          safeNumber(row.dev_arpt), safeNumber(row.dev_atpu), safeNumber(row.dev_arpu),
          nullIfEmpty(row.source_sheet) || 'Produk',
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      deviationInserted++;
    }

    await client.query(
      `INSERT INTO payment_agent_produk_sync_log
         (sync_key, snapshot_date, day_number, metric_rows_received, metric_rows_inserted,
          deviation_rows_received, deviation_rows_inserted, status, error_message, payload_meta, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'success',NULL,$8,NOW())`,
      [
        SYNC_KEY, snapshotDate, dayNumber, metricRows.length, metricInserted,
        deviationRows.length, deviationInserted,
        JSON.stringify({
          duplicate_metric_count: metricDup,
          duplicate_deviation_count: deviationDup,
          missing_label_metric: metricMissingLabel,
          missing_label_deviation: deviationMissingLabel,
          months,
          synced_by: body.meta?.synced_by || null,
          formula_error_count: Number(body.meta?.formula_error_count || 0),
          parse_warnings: body.meta?.parse_warnings || [],
          total_row: body.meta?.total_row || {},
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      snapshot_date: snapshotDate,
      day_number: dayNumber,
      metric_rows_inserted: metricInserted,
      deviation_rows_inserted: deviationInserted,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    try {
      await pool.query(
        `INSERT INTO payment_agent_produk_sync_log
           (sync_key, snapshot_date, day_number, metric_rows_received, metric_rows_inserted,
            deviation_rows_received, deviation_rows_inserted, status, error_message, payload_meta, synced_at)
         VALUES ($1,$2,$3,$4,0,$5,0,'failed',$6,'{}',NOW())`,
        [SYNC_KEY, snapshotDate, dayNumber, metricRows.length, deviationRows.length, String(err.message || 'unknown error').slice(0, 500)]
      );
    } catch (_) { /* jangan sampai gagal logging menutupi error asli */ }
    console.error('payment-agent-produk sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Klasifikasi produk (status / priority / segment / diagnosis / rekomendasi)
// ─────────────────────────────────────────────────────────────────────────
const RECO_BY_PRIORITY = {
  P0: 'Selamatkan revenue — jalankan win-back campaign / WA blast / promo cashback terbatas segera.',
  P1: 'Layak di-scale — tambah exposure campaign, jadikan andalan promosi bulan ini.',
  P2: 'Perbaiki frequency — jalankan repeat-transaction campaign / reminder rutin.',
  P3: 'Jaga momentum — pertahankan strategi berjalan, monitor rutin.',
  P4: 'Cek data quality / prioritas rendah — pastikan sinkronisasi sheet benar.',
};

function classifyProduct(p) {
  const { revCurr, revContribPct, matContribPct, arpuTop, matBelowMedian, devPrevRevPct, devPrevMatPct, devPrevTrxPct, devPrevAtpuPct, devPrevArpuPct, hasCurrentData } = p;

  let status;
  if (!hasCurrentData) status = 'no_data';
  else if ((revCurr || 0) <= 0) status = 'kritis';
  else if (devPrevRevPct !== null && devPrevRevPct <= -0.05) status = 'turun';
  else if (devPrevRevPct !== null && devPrevRevPct >= 0.05) status = 'naik';
  else status = 'stabil';

  let priority;
  if (status === 'no_data') priority = 'P4';
  else if (status === 'kritis') priority = 'P0';
  else if (status === 'turun' && p.isTopRevenue) priority = 'P0';
  else if (status === 'turun') priority = 'P1'; // turun tapi bukan top revenue -> tetap perlu follow-up cepat
  else if (status === 'naik' && devPrevRevPct !== null && devPrevRevPct >= 0.10) priority = 'P1';
  else if (devPrevMatPct !== null && devPrevMatPct >= -0.03 && ((devPrevTrxPct !== null && devPrevTrxPct < -0.05) || (devPrevAtpuPct !== null && devPrevAtpuPct < -0.05))) priority = 'P2';
  else if (status === 'stabil') priority = 'P3';
  else priority = 'P2';

  let segment;
  if (status === 'no_data' || status === 'kritis') segment = 'Low Priority';
  else if (matBelowMedian && arpuTop) segment = 'Low MAT High ARPU';
  else if (matContribPct !== null && revContribPct !== null && matContribPct > revContribPct * 1.5 && revContribPct < 0.02) segment = 'High MAT Low Revenue';
  else if (devPrevMatPct !== null && devPrevMatPct >= -0.03 && ((devPrevTrxPct !== null && devPrevTrxPct < -0.05) || (devPrevAtpuPct !== null && devPrevAtpuPct < -0.05))) segment = 'Frequency Problem';
  else if (devPrevArpuPct !== null && devPrevArpuPct < -0.05 && (devPrevTrxPct === null || devPrevTrxPct >= -0.02)) segment = 'Monetization Problem';
  else if (status === 'turun' && p.isTopRevenue) segment = 'Declining Product';
  else if (status === 'naik') segment = 'Growth Product';
  else if (p.isTopRevenue) segment = 'Core Revenue Driver';
  else segment = 'Core Revenue Driver';

  let diagnosis;
  if (status === 'no_data') diagnosis = 'Produk tidak memiliki data pada bulan berjalan.';
  else if (status === 'kritis') diagnosis = 'Revenue bulan berjalan nihil/negatif — indikasi produk berhenti total.';
  else if (segment === 'Frequency Problem') diagnosis = 'MAT stabil tapi TRX/ATPU turun, artinya frequency problem.';
  else if (segment === 'Monetization Problem') diagnosis = 'ARPU turun, artinya monetization problem.';
  else if (devPrevTrxPct !== null && devPrevTrxPct < -0.05 && status === 'turun') diagnosis = 'Revenue turun karena TRX turun.';
  else if (status === 'naik') diagnosis = 'Produk naik dan layak scale campaign.';
  else diagnosis = 'Performa relatif stabil dibanding bulan sebelumnya.';

  return { status, priority, segment, diagnosis, recommendation: RECO_BY_PRIORITY[priority] };
}

function safeSum(arr, key) {
  return arr.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/payment-agent/produk/analytics?snapshot_date=latest
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const configRes = await pool.query('SELECT * FROM payment_agent_produk_config WHERE sync_key = $1', [SYNC_KEY]);
    const config = configRes.rows[0] || null;

    const snapshotsRes = await pool.query(
      'SELECT DISTINCT snapshot_date, day_number FROM payment_agent_produk_metrics ORDER BY snapshot_date DESC'
    );
    const availableSnapshots = snapshotsRes.rows;

    if (!availableSnapshots.length) {
      return res.json({
        empty: true,
        message: 'Data Produk belum tersedia. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { available_snapshots: [] },
      });
    }

    const requested = nullIfEmpty(req.query.snapshot_date);
    let snapshot = (requested && requested !== 'latest' && isValidDate(requested))
      ? availableSnapshots.find(s => String(s.snapshot_date).slice(0, 10) === requested)
      : null;
    if (!snapshot) snapshot = availableSnapshots[0];
    const snapshotDate = snapshot.snapshot_date;
    const dayNumber = snapshot.day_number;

    // ── Bulan untuk snapshot ini (derive dari data, bukan config — robust
    //    terhadap pergeseran jendela bulan antar snapshot) ──
    const monthsRes = await pool.query(
      `SELECT DISTINCT month_key, month_label FROM payment_agent_produk_metrics
       WHERE snapshot_date = $1 ORDER BY month_key ASC`,
      [snapshotDate]
    );
    const monthRows = monthsRes.rows;
    if (monthRows.length < 2) {
      return res.json({
        empty: true,
        message: 'Snapshot belum tersedia.',
        meta: { snapshot_date: snapshotDate, day_number: dayNumber, available_snapshots: availableSnapshots },
      });
    }
    const currentMonth = monthRows[monthRows.length - 1];
    const baselineMonth = monthRows[0];
    const previousMonth = monthRows.length >= 3 ? monthRows[monthRows.length - 2] : null;

    const [metricsRes, deviationRes, lastSyncRes] = await Promise.all([
      pool.query('SELECT * FROM payment_agent_produk_metrics WHERE snapshot_date = $1', [snapshotDate]),
      pool.query('SELECT * FROM payment_agent_produk_deviation WHERE snapshot_date = $1', [snapshotDate]),
      pool.query(`SELECT payload_meta, synced_at FROM payment_agent_produk_sync_log WHERE sync_key = $1 AND status = 'success' ORDER BY synced_at DESC LIMIT 1`, [SYNC_KEY]),
    ]);

    // ── Pivot metrics: product_label -> { month_key: row } ──
    const byLabel = new Map();
    for (const r of metricsRes.rows) {
      const label = r.product_label || r.product_name;
      if (!byLabel.has(label)) byLabel.set(label, { product_code: r.product_code, product_name: r.product_name, product_label: label, months: {} });
      byLabel.get(label).months[r.month_key] = r;
    }
    // ── Pivot deviations: product_label -> { compare_key: row } ──
    const devByLabel = new Map();
    for (const r of deviationRes.rows) {
      const label = r.product_label || r.product_name;
      if (!devByLabel.has(label)) devByLabel.set(label, {});
      devByLabel.get(label)[r.compare_key] = r;
    }

    const num = (v) => (v === null || v === undefined ? null : Number(v));

    // ── Pass 1: bangun data mentah per produk ──
    const rawProducts = [...byLabel.values()].map(entry => {
      const cur = entry.months[currentMonth.month_key] || null;
      const prev = previousMonth ? (entry.months[previousMonth.month_key] || null) : null;
      const base = entry.months[baselineMonth.month_key] || null;
      const dev = devByLabel.get(entry.product_label) || {};
      const devBaseVsCurr = dev.baseline_vs_current || null;
      const devPrevVsCurr = dev.previous_vs_current || null;

      return {
        product_code: entry.product_code,
        product_name: entry.product_name,
        product_label: entry.product_label,
        current_month: currentMonth.month_key,
        mat: num(cur?.mat), trx: num(cur?.trx), rev: num(cur?.rev),
        arpt: num(cur?.arpt), atpu: num(cur?.atpu), arpu: num(cur?.arpu),
        baseline_mat: num(base?.mat), baseline_trx: num(base?.trx), baseline_rev: num(base?.rev),
        baseline_arpt: num(base?.arpt), baseline_atpu: num(base?.atpu), baseline_arpu: num(base?.arpu),
        previous_mat: num(prev?.mat), previous_trx: num(prev?.trx), previous_rev: num(prev?.rev),
        previous_arpt: num(prev?.arpt), previous_atpu: num(prev?.atpu), previous_arpu: num(prev?.arpu),
        dev_baseline_mat: num(devBaseVsCurr?.dev_mat), dev_baseline_trx: num(devBaseVsCurr?.dev_trx), dev_baseline_rev: num(devBaseVsCurr?.dev_rev),
        dev_baseline_arpt: num(devBaseVsCurr?.dev_arpt), dev_baseline_atpu: num(devBaseVsCurr?.dev_atpu), dev_baseline_arpu: num(devBaseVsCurr?.dev_arpu),
        dev_previous_mat: num(devPrevVsCurr?.dev_mat), dev_previous_trx: num(devPrevVsCurr?.dev_trx), dev_previous_rev: num(devPrevVsCurr?.dev_rev),
        dev_previous_arpt: num(devPrevVsCurr?.dev_arpt), dev_previous_atpu: num(devPrevVsCurr?.dev_atpu), dev_previous_arpu: num(devPrevVsCurr?.dev_arpu),
        has_current_data: !!cur,
      };
    });

    const totalRevCurr = safeSum(rawProducts, 'rev');
    const totalMatCurr = safeSum(rawProducts, 'mat');
    const revValues = rawProducts.map(p => p.rev || 0).filter(v => v > 0).sort((a, b) => a - b);
    const matValues = rawProducts.map(p => p.mat || 0).filter(v => v > 0).sort((a, b) => a - b);
    const arpuValues = rawProducts.map(p => p.arpu || 0).filter(v => v > 0).sort((a, b) => a - b);
    const revP70 = percentile(revValues, 0.70);
    const matMedian = percentile(matValues, 0.50);
    const arpuP75 = percentile(arpuValues, 0.75);

    const products = rawProducts.map(p => {
      const revContribPct = safeDiv(p.rev, totalRevCurr);
      const matContribPct = safeDiv(p.mat, totalMatCurr);
      const devPrevRevPct = safeDiv(p.dev_previous_rev, p.previous_rev);
      const devPrevMatPct = safeDiv(p.dev_previous_mat, p.previous_mat);
      const devPrevTrxPct = safeDiv(p.dev_previous_trx, p.previous_trx);
      const devPrevAtpuPct = safeDiv(p.dev_previous_atpu, p.previous_atpu);
      const devPrevArpuPct = safeDiv(p.dev_previous_arpu, p.previous_arpu);
      const devBaseRevPct = safeDiv(p.dev_baseline_rev, p.baseline_rev);

      const classification = classifyProduct({
        revCurr: p.rev, revContribPct, matContribPct,
        arpuTop: (p.arpu || 0) >= arpuP75 && arpuP75 > 0,
        matBelowMedian: (p.mat || 0) < matMedian,
        devPrevRevPct, devPrevMatPct, devPrevTrxPct, devPrevAtpuPct, devPrevArpuPct,
        hasCurrentData: p.has_current_data,
        isTopRevenue: (p.rev || 0) >= revP70 && revP70 > 0,
      });

      return {
        product_code: p.product_code,
        product_name: p.product_name,
        product_label: p.product_label,
        current_month: p.current_month,
        mat: p.mat, trx: p.trx, rev: p.rev, arpt: p.arpt, atpu: p.atpu, arpu: p.arpu,
        mei_mat: p.baseline_mat, mei_trx: p.baseline_trx, mei_rev: p.baseline_rev,
        mei_arpt: p.baseline_arpt, mei_atpu: p.baseline_atpu, mei_arpu: p.baseline_arpu,
        jun_mat: p.previous_mat, jun_trx: p.previous_trx, jun_rev: p.previous_rev,
        jun_arpt: p.previous_arpt, jun_atpu: p.previous_atpu, jun_arpu: p.previous_arpu,
        dev_mei_mat: p.dev_baseline_mat, dev_mei_trx: p.dev_baseline_trx, dev_mei_rev: p.dev_baseline_rev,
        dev_mei_arpt: p.dev_baseline_arpt, dev_mei_atpu: p.dev_baseline_atpu, dev_mei_arpu: p.dev_baseline_arpu,
        dev_jun_mat: p.dev_previous_mat, dev_jun_trx: p.dev_previous_trx, dev_jun_rev: p.dev_previous_rev,
        dev_jun_arpt: p.dev_previous_arpt, dev_jun_atpu: p.dev_previous_atpu, dev_jun_arpu: p.dev_previous_arpu,
        revenue_growth_vs_previous_pct: devPrevRevPct,
        revenue_growth_vs_baseline_pct: devBaseRevPct,
        revenue_contribution_pct: revContribPct,
        trx_contribution_pct: safeDiv(p.trx, safeSum(rawProducts, 'trx')),
        mat_contribution_pct: matContribPct,
        ...classification,
      };
    });

    // ── Summary / KPI ──
    const totalTrxCurr = safeSum(products, 'trx');
    const totalMatPrev = previousMonth ? safeSum(rawProducts, 'previous_mat') : null;
    const totalTrxPrev = previousMonth ? safeSum(rawProducts, 'previous_trx') : null;
    const totalRevPrev = previousMonth ? safeSum(rawProducts, 'previous_rev') : null;
    const totalMatBase = safeSum(rawProducts, 'baseline_mat');
    const totalTrxBase = safeSum(rawProducts, 'baseline_trx');
    const totalRevBase = safeSum(rawProducts, 'baseline_rev');

    const summary = {
      total_revenue_current: totalRevCurr,
      total_trx_current: totalTrxCurr,
      total_mat_current: totalMatCurr,
      arpt_current: safeDiv(totalRevCurr, totalTrxCurr),
      atpu_current: safeDiv(totalTrxCurr, totalMatCurr),
      arpu_current: safeDiv(totalRevCurr, totalMatCurr),
      revenue_vs_jun: previousMonth ? totalRevCurr - totalRevPrev : null,
      revenue_vs_mei: totalRevCurr - totalRevBase,
      trx_vs_jun: previousMonth ? totalTrxCurr - totalTrxPrev : null,
      trx_vs_mei: totalTrxCurr - totalTrxBase,
      mat_vs_jun: previousMonth ? totalMatCurr - totalMatPrev : null,
      mat_vs_mei: totalMatCurr - totalMatBase,
      revenue_growth_vs_jun_pct: previousMonth ? safeDiv(totalRevCurr - totalRevPrev, totalRevPrev) : null,
      revenue_growth_vs_mei_pct: safeDiv(totalRevCurr - totalRevBase, totalRevBase),
      trx_growth_vs_jun_pct: previousMonth ? safeDiv(totalTrxCurr - totalTrxPrev, totalTrxPrev) : null,
      mat_growth_vs_jun_pct: previousMonth ? safeDiv(totalMatCurr - totalMatPrev, totalMatPrev) : null,
      total_products: products.length,
      products_up_count: products.filter(p => p.status === 'naik').length,
      products_down_count: products.filter(p => p.status === 'turun').length,
      products_stable_count: products.filter(p => p.status === 'stabil').length,
      products_critical_count: products.filter(p => p.status === 'kritis').length,
    };

    // ── Top Products ──
    const sortByDesc = (key) => [...products].sort((a, b) => (b[key] || -Infinity) - (a[key] || -Infinity));
    const growthVsJun = products.filter(p => p.dev_jun_rev !== null).sort((a, b) => b.dev_jun_rev - a.dev_jun_rev);
    const growthVsMei = products.filter(p => p.dev_mei_rev !== null).sort((a, b) => b.dev_mei_rev - a.dev_mei_rev);

    const topProducts = {
      top_by_revenue: sortByDesc('rev').slice(0, 10),
      top_by_trx: sortByDesc('trx').slice(0, 10),
      top_by_mat: sortByDesc('mat').slice(0, 10),
      top_growth_vs_jun: growthVsJun.filter(p => p.dev_jun_rev > 0).slice(0, 10),
      top_decline_vs_jun: [...growthVsJun].reverse().filter(p => p.dev_jun_rev < 0).slice(0, 10),
      top_growth_vs_mei: growthVsMei.filter(p => p.dev_mei_rev > 0).slice(0, 10),
      top_decline_vs_mei: [...growthVsMei].reverse().filter(p => p.dev_mei_rev < 0).slice(0, 10),
    };

    // ── Campaign Priority ──
    const campaignPriority = { P0: [], P1: [], P2: [], P3: [], P4: [] };
    for (const p of products) campaignPriority[p.priority].push(p);
    for (const k of Object.keys(campaignPriority)) {
      campaignPriority[k] = campaignPriority[k].sort((a, b) => (b.rev || 0) - (a.rev || 0));
    }

    // ── Matrix 2x2 (high/low revenue x growing/declining) ──
    const revMedian = percentile(revValues, 0.50);
    const matrix = { high_revenue_growing: [], high_revenue_declining: [], low_revenue_growing: [], low_revenue_declining: [] };
    for (const p of products) {
      const isHigh = (p.rev || 0) >= revMedian && revMedian > 0;
      const isGrowing = (p.dev_jun_rev || 0) >= 0;
      if (isHigh && isGrowing) matrix.high_revenue_growing.push(p);
      else if (isHigh && !isGrowing) matrix.high_revenue_declining.push(p);
      else if (!isHigh && isGrowing) matrix.low_revenue_growing.push(p);
      else matrix.low_revenue_declining.push(p);
    }

    // ── Insights (maks 5) ──
    const insights = [];
    if (summary.revenue_growth_vs_jun_pct !== null) {
      insights.push({
        id: 'revenue_growth_previous',
        severity: summary.revenue_growth_vs_jun_pct < 0 ? 'high' : 'low',
        text: `Revenue ${currentMonth.month_label} ${summary.revenue_growth_vs_jun_pct >= 0 ? 'naik' : 'turun'} ${Math.abs(summary.revenue_growth_vs_jun_pct * 100).toFixed(1)}% dibanding ${previousMonth?.month_label}.`,
      });
    }
    const p0List = campaignPriority.P0.filter(p => p.status !== 'no_data');
    if (p0List.length) {
      insights.push({ id: 'p0_decline', severity: 'high', text: `Penurunan terbesar disumbang produk: ${p0List.slice(0, 3).map(p => p.product_name).join(', ')}.` });
    }
    const freqProblem = products.filter(p => p.segment === 'Frequency Problem');
    if (freqProblem.length) {
      insights.push({ id: 'frequency_problem', severity: 'medium', text: `${freqProblem.length} produk MAT stabil tapi TRX turun (frequency problem): ${freqProblem.slice(0, 3).map(p => p.product_name).join(', ')}.` });
    }
    const growthList = products.filter(p => p.status === 'naik').sort((a, b) => (b.dev_jun_rev || 0) - (a.dev_jun_rev || 0));
    if (growthList.length) {
      insights.push({ id: 'growth_positive', severity: 'low', text: `Produk growth positif layak di-scale: ${growthList.slice(0, 3).map(p => p.product_name).join(', ')}.` });
    }
    const highRevDeclining = matrix.high_revenue_declining.filter(p => p.status !== 'no_data');
    if (highRevDeclining.length && insights.length < 5) {
      insights.push({ id: 'high_revenue_declining', severity: 'high', text: `${highRevDeclining.length} produk high-revenue sedang declining — perlu perhatian segera.` });
    }

    // ── Data Quality ──
    const lastMeta = lastSyncRes.rows[0]?.payload_meta || {};
    const dqChecks = [
      { key: 'formula_error_count', label: 'Formula error dari Google Sheet (#NAME?, #DIV/0!, dst)', count: Number(lastMeta.formula_error_count || 0), recommendation: 'Cek cell terkait di Google Sheet, perbaiki formula sumber.' },
      { key: 'missing_product_name', label: 'Baris tanpa nama produk (dilewati saat sync)', count: Number(lastMeta.missing_label_metric || 0) + Number(lastMeta.missing_label_deviation || 0), recommendation: 'Lengkapi kolom Produk di sheet.' },
      { key: 'invalid_mat', label: 'MAT tidak terbaca', count: products.filter(p => p.mat === null).length, recommendation: 'Cek format angka/formula di kolom MAT.' },
      { key: 'invalid_trx', label: 'TRX tidak terbaca', count: products.filter(p => p.trx === null).length, recommendation: 'Cek format angka/formula di kolom TRX.' },
      { key: 'invalid_rev', label: 'REV tidak terbaca', count: products.filter(p => p.rev === null).length, recommendation: 'Cek format angka/formula di kolom REV.' },
      { key: 'invalid_arpt', label: 'ARPT tidak terbaca', count: products.filter(p => p.arpt === null).length, recommendation: 'Cek format angka/formula di kolom ARPT.' },
      { key: 'invalid_atpu', label: 'ATPU tidak terbaca', count: products.filter(p => p.atpu === null).length, recommendation: 'Cek format angka/formula di kolom ATPU.' },
      { key: 'invalid_arpu', label: 'ARPU tidak terbaca', count: products.filter(p => p.arpu === null).length, recommendation: 'Cek format angka/formula di kolom ARPU.' },
      { key: 'duplicate_product', label: 'Baris produk duplikat di sync terakhir', count: Number(lastMeta.duplicate_metric_count || 0) + Number(lastMeta.duplicate_deviation_count || 0), recommendation: 'Cek sheet Produk untuk baris duplikat.' },
      { key: 'total_row_mismatch', label: 'Baris TOTAL sheet tidak cocok dengan agregat sinkron', count: 0, recommendation: 'Bandingkan baris TOTAL sheet dengan total dashboard.' },
      { key: 'negative_values_count', label: 'Nilai negatif ditemukan (dari tanda kurung di sheet)', count: products.filter(p => (p.rev || 0) < 0 || (p.mat || 0) < 0 || (p.trx || 0) < 0).length, recommendation: 'Wajar bila memang deviasi turun; cek ulang bila terjadi pada metrik absolut (MAT/TRX/REV bulanan).' },
      { key: 'month_data_missing', label: 'Bulan terdeteksi kurang dari 3', count: monthRows.length < 3 ? 1 : 0, recommendation: 'Pastikan minimal 3 bulan (baseline/previous/current) sudah tersinkron.' },
      { key: 'deviation_mismatch', label: 'Produk tanpa data deviasi', count: products.filter(p => p.dev_jun_rev === null && p.dev_mei_rev === null).length, recommendation: 'Cek sheet kolom DEV untuk produk ini.' },
    ].map(c => ({ ...c, severity: c.count === 0 ? 'low' : (c.count >= 3 ? 'high' : 'medium') }));

    if (dqChecks.some(c => c.count > 0) && insights.length < 5) {
      const dqIssueTotal = dqChecks.reduce((s, c) => s + c.count, 0);
      insights.push({ id: 'data_quality', severity: dqIssueTotal >= 5 ? 'high' : 'medium', text: `${dqIssueTotal} isu data quality ditemukan — lihat tab Data Quality untuk detail.` });
    }

    // ── Action Summary (maks 20) ──
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
    const actionSummary = [];
    for (const p of products.filter(p => p.priority !== 'P3').sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || (b.rev || 0) - (a.rev || 0))) {
      if (actionSummary.length >= 20) break;
      actionSummary.push({ priority: p.priority, title: p.product_name, product_label: p.product_label, rev: p.rev, recommendation: p.recommendation });
    }

    res.json({
      meta: {
        snapshot_date: snapshotDate,
        day_number: dayNumber,
        source_url: config?.source_url || null,
        sheet_name: config?.sheet_name || 'Produk',
        last_sync: lastSyncRes.rows[0]?.synced_at || null,
        available_snapshots: availableSnapshots.map(s => ({ snapshot_date: s.snapshot_date, day_number: s.day_number, label: `Day ${s.day_number ?? '?'} - ${s.snapshot_date}` })),
        months: monthRows,
        current_month: currentMonth.month_key,
        current_month_label: currentMonth.month_label || currentMonth.month_key,
        previous_month: previousMonth?.month_key || null,
        previous_month_label: previousMonth?.month_label || null,
        baseline_month: baselineMonth.month_key,
        baseline_month_label: baselineMonth.month_label || baselineMonth.month_key,
        fair_mtd_comparison: true,
      },
      summary,
      products,
      top_products: topProducts,
      campaign_priority: campaignPriority,
      matrix,
      insights: insights.slice(0, 5),
      action_summary: actionSummary,
      data_quality: dqChecks,
    });
  } catch (e) {
    console.error('payment-agent-produk analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/payment-agent/produk/detail?snapshot_date=latest&product_name=
// ─────────────────────────────────────────────────────────────────────────
async function detailHandler(req, res) {
  try {
    const snapshotsRes = await pool.query(
      'SELECT DISTINCT snapshot_date FROM payment_agent_produk_metrics ORDER BY snapshot_date DESC'
    );
    if (!snapshotsRes.rows.length) {
      return res.json({ empty: true, message: 'Data Produk belum tersedia.', product: null, monthly: [], deviation: {}, diagnosis: [], campaign_recommendation: [], content_angle: [] });
    }
    const requested = nullIfEmpty(req.query.snapshot_date);
    const snapshotDate = (requested && requested !== 'latest')
      ? (snapshotsRes.rows.find(s => String(s.snapshot_date).slice(0, 10) === requested)?.snapshot_date || snapshotsRes.rows[0].snapshot_date)
      : snapshotsRes.rows[0].snapshot_date;

    const productName = nullIfEmpty(req.query.product_name);
    if (!productName) return res.status(400).json({ error: 'product_name wajib diisi' });

    const [metricsRes, deviationRes] = await Promise.all([
      pool.query(
        `SELECT * FROM payment_agent_produk_metrics WHERE snapshot_date = $1
         AND (product_name ILIKE $2 OR product_label ILIKE $2) ORDER BY month_key ASC`,
        [snapshotDate, productName]
      ),
      pool.query(
        `SELECT * FROM payment_agent_produk_deviation WHERE snapshot_date = $1
         AND (product_name ILIKE $2 OR product_label ILIKE $2)`,
        [snapshotDate, productName]
      ),
    ]);

    if (!metricsRes.rows.length) {
      return res.json({ empty: true, message: 'Produk tidak ditemukan untuk snapshot ini.', product: null, monthly: [], deviation: {}, diagnosis: [], campaign_recommendation: [], content_angle: [] });
    }

    const monthly = metricsRes.rows.map(r => ({
      month_key: r.month_key, month_label: r.month_label,
      mat: r.mat !== null ? Number(r.mat) : null, trx: r.trx !== null ? Number(r.trx) : null, rev: r.rev !== null ? Number(r.rev) : null,
      arpt: r.arpt !== null ? Number(r.arpt) : null, atpu: r.atpu !== null ? Number(r.atpu) : null, arpu: r.arpu !== null ? Number(r.arpu) : null,
    }));
    const last = metricsRes.rows[metricsRes.rows.length - 1];
    const first = metricsRes.rows[0];
    const prev = metricsRes.rows.length >= 2 ? metricsRes.rows[metricsRes.rows.length - 2] : null;

    const deviation = {};
    for (const r of deviationRes.rows) {
      deviation[r.compare_key] = {
        compare_label: r.compare_label,
        dev_mat: r.dev_mat !== null ? Number(r.dev_mat) : null, dev_trx: r.dev_trx !== null ? Number(r.dev_trx) : null,
        dev_rev: r.dev_rev !== null ? Number(r.dev_rev) : null, dev_arpt: r.dev_arpt !== null ? Number(r.dev_arpt) : null,
        dev_atpu: r.dev_atpu !== null ? Number(r.dev_atpu) : null, dev_arpu: r.dev_arpu !== null ? Number(r.dev_arpu) : null,
      };
    }

    const product = {
      product_code: last.product_code, product_name: last.product_name, product_label: last.product_label,
      current_month: last.month_key, current_month_label: last.month_label,
    };

    const devPrev = deviation.previous_vs_current || null;
    const devBase = deviation.baseline_vs_current || null;
    const devPrevTrxPct = safeDiv(devPrev?.dev_trx, prev?.trx !== null && prev?.trx !== undefined ? Number(prev.trx) : null);
    const devPrevMatPct = safeDiv(devPrev?.dev_mat, prev?.mat !== null && prev?.mat !== undefined ? Number(prev.mat) : null);
    const devPrevArpuPct = safeDiv(devPrev?.dev_arpu, prev?.arpu !== null && prev?.arpu !== undefined ? Number(prev.arpu) : null);

    const diagnosis = [];
    if (devPrev && devPrev.dev_rev !== null && devPrev.dev_rev < 0) {
      if (devPrevTrxPct !== null && devPrevTrxPct < -0.05) diagnosis.push('Revenue turun karena TRX turun.');
      if (devPrevMatPct !== null && devPrevMatPct >= -0.03 && devPrevTrxPct !== null && devPrevTrxPct < -0.05) diagnosis.push('MAT stabil tapi TRX/ATPU turun, artinya frequency problem.');
      if (devPrevArpuPct !== null && devPrevArpuPct < -0.05) diagnosis.push('ARPU turun, artinya monetization problem.');
      if (!diagnosis.length) diagnosis.push('Revenue turun dibanding bulan sebelumnya — perlu investigasi lebih lanjut.');
    } else if (devPrev && devPrev.dev_rev !== null && devPrev.dev_rev > 0) {
      diagnosis.push('Produk naik dan layak scale campaign.');
    } else {
      diagnosis.push('Performa relatif stabil dibanding bulan sebelumnya.');
    }

    const campaignRecommendation = [];
    const contentAngle = [];
    if (devPrev && devPrev.dev_rev !== null && devPrev.dev_rev < 0) {
      campaignRecommendation.push('Win-back campaign untuk user aktif bulan lalu.', 'Push notification / WA blast.', 'Cashback terbatas.');
      contentAngle.push('"Produk yang sering dipakai tapi mulai turun"', '"Reminder transaksi bulanan"');
    } else if (devPrev && devPrev.dev_rev !== null && devPrev.dev_rev > 0) {
      campaignRecommendation.push('Tambah exposure campaign — jadikan andalan promosi.', 'Bundling produk.', 'Campaign tanggal gajian.');
      contentAngle.push('"Produk lagi rame, buruan pakai"', '"Bayar lebih cepat lewat produk ini"');
    } else {
      campaignRecommendation.push('Edukasi produk.', 'Campaign tanggal gajian.');
      contentAngle.push('"Promo repeat order"');
    }

    res.json({
      empty: false,
      product,
      monthly,
      deviation,
      diagnosis,
      campaign_recommendation: campaignRecommendation,
      content_angle: contentAngle,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/payment-agent/produk/table?snapshot_date=&page=&limit=&search=&status=&priority=&segment=&sort_by=&sort_dir=
// Dibangun di atas analyticsHandler in-memory (dataset kecil per snapshot,
// puluhan produk) — sort/filter/pagination di aplikasi supaya konsisten
// persis dengan angka yang tampil di tab lain.
// ─────────────────────────────────────────────────────────────────────────
const TABLE_SORT_KEYS = ['rev', 'trx', 'mat', 'arpt', 'atpu', 'arpu', 'dev_jun_rev', 'dev_mei_rev', 'revenue_contribution_pct'];

async function computeAnalytics(snapshotDateParam) {
  // Re-derive minimal analytics tanpa HTTP round-trip — panggil handler internal via mock res
  let captured = null;
  const fakeRes = { json: (payload) => { captured = payload; }, status: () => fakeRes };
  await analyticsHandler({ query: { snapshot_date: snapshotDateParam } }, fakeRes);
  return captured;
}

async function tableHandler(req, res) {
  try {
    const analytics = await computeAnalytics(nullIfEmpty(req.query.snapshot_date) || 'latest');
    if (!analytics || analytics.empty) return res.json(analytics || { empty: true, products: [] });

    let rows = analytics.products;
    const search = nullIfEmpty(req.query.search);
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(p => (p.product_name || '').toLowerCase().includes(s) || (p.product_label || '').toLowerCase().includes(s));
    }
    const status = nullIfEmpty(req.query.status);
    if (status && status !== 'semua') rows = rows.filter(p => p.status === status);
    const priority = nullIfEmpty(req.query.priority);
    if (priority && priority !== 'semua') rows = rows.filter(p => p.priority === priority);
    const segment = nullIfEmpty(req.query.segment);
    if (segment && segment !== 'semua') rows = rows.filter(p => p.segment === segment);

    const sortBy = TABLE_SORT_KEYS.includes(req.query.sort_by) ? req.query.sort_by : 'rev';
    const sortDir = String(req.query.sort_dir || '').toLowerCase() === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => sortDir * ((a[sortBy] ?? -Infinity) - (b[sortBy] ?? -Infinity)));

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
    const total = rows.length;
    const offset = (page - 1) * limit;
    const paged = rows.slice(offset, offset + limit);

    res.json({ meta: { ...analytics.meta, page, limit, total, sort_by: sortBy, sort_dir: sortDir === 1 ? 'asc' : 'desc' }, rows: paged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  snapshotsHandler,
  syncHandler,
  analyticsHandler,
  detailHandler,
  tableHandler,
  _internal: { safeNumber, safeDiv, isFormulaError, classifyProduct, percentile },
};
