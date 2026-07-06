/**
 * WAR-ROOM Quick Win Q3 IQWM (Winme & InstaQRIS) — Prompt 1 (backend only)
 *
 * Sumber: 3 sheet Google Sheet ("Resume IQWM", "Breakdown Target Instaqris",
 * "Breakdown Target Winme"). Breakdown SEKARANG tersedia untuk Winme DAN
 * InstaQRIS — kolom `product` di kedua tabel utama sengaja generik (bukan
 * enum/kolom terpisah per produk) supaya produk baru di masa depan tidak
 * butuh migration/ALTER TABLE.
 *
 * TIDAK ADA logic Apps Script atau frontend di file ini (Prompt 2/3).
 * Sync menerima payload SUDAH-TERSTRUKTUR dari Apps Script (bukan raw sheet
 * row seperti data-raw.js) — lihat docs/QUICK_WIN_Q3_IQWM.md §Payload Contract.
 */

const pool = require('../db');

// Sengaja TIDAK ADA fallback hardcoded (beda dari beberapa route lama yang
// masih punya `|| 'bric2026...'`) — kalau env belum diset di server, semua
// sync request akan ditolak 401 sampai admin set QUICK_WIN_Q3_SYNC_TOKEN.
const SYNC_TOKEN = process.env.QUICK_WIN_Q3_SYNC_TOKEN;

const FORMULA_ERRORS = ['#NAME?', '#DIV/0!', '#VALUE!', '#N/A', '#REF!', '#NULL!', '#NUM!'];
const VALID_STATUSES = ['aman', 'waspada', 'kritis', 'overperform', 'no_data'];
const STATUS_ORDER = ['kritis', 'waspada', 'aman', 'overperform'];
const PRIORITY_BY_STATUS = { kritis: 'P0', waspada: 'P1', aman: 'P2', overperform: 'P3', no_data: 'P4' };

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

function isValidPeriode(periode) {
  return typeof periode === 'string' && /^\d{4}-Q[1-4]$/.test(periode);
}

function nullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Deteksi nilai formula error Google Sheet ("#NAME?", "#DIV/0!", dst). */
function isFormulaError(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toUpperCase();
  return FORMULA_ERRORS.includes(s);
}

/**
 * Parser angka aman. Urutan aturan (SAMA dengan aturan cleanNum() historis
 * di seluruh BRIC — insiden Speedcash 100x karena titik desimal number asli
 * ikut terhapus saat diperlakukan sebagai string):
 *   1. typeof number -> langsung pakai (kalau finite), JANGAN diproses string.
 *   2. string kosong/"-"/formula error -> null (bukan 0 — supaya data quality
 *      bisa membedakan "benar-benar nol" vs "tidak bisa dibaca").
 *   3. string angka: contoh di sheet ini SELALU berformat ribuan tanpa
 *      desimal ("1.000", "1,000", "Rp 1.000.000") — titik DAN koma di sini
 *      berarti pemisah ribuan (bukan desimal), jadi keduanya dibuang.
 * Tidak pernah mengembalikan NaN/Infinity — selalu number valid atau null.
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

/**
 * Parser persentase aman -> selalu decimal 0..1 (bukan 0..100), sama seperti
 * contoh payload ("realization_target_pct": 0.0136). Beda dari safeNumber:
 * di sini KOMA berarti pemisah DESIMAL ("55,18%" gaya Indonesia), bukan
 * pemisah ribuan — karena persentase tidak butuh pemisah ribuan.
 */
function safePercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  if (isFormulaError(raw)) return null;
  const hasPercentSign = raw.includes('%');
  let cleaned = raw.replace('%', '').trim().replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return hasPercentSign ? n / 100 : n;
}

/** Pembagian aman -> null (bukan NaN/Infinity) kalau penyebut 0/null/tidak valid. */
function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function normalizeStatus(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (VALID_STATUSES.includes(s)) return s;
  if (s.includes('over') || s.includes('lampau')) return 'overperform';
  if (s.includes('aman') || s.includes('safe')) return 'aman';
  if (s.includes('waspada') || s.includes('warning')) return 'waspada';
  if (s.includes('kritis') || s.includes('critical')) return 'kritis';
  return null;
}

/**
 * Status utama: bandingkan realizationPct terhadap progressTimePct (pace).
 * estimatedPct (opsional, rasio estimasi akhir Q3 / target) dipakai sebagai
 * indikator leading — bisa menaikkan/menurunkan status MAKSIMAL 1 tingkat
 * saja (supaya tidak melompat drastis dari 1 sinyal tambahan).
 * Threshold didokumentasikan di docs/QUICK_WIN_Q3_IQWM.md.
 */
function calculateStatus(realizationPct, progressTimePct, estimatedPct = null) {
  if (realizationPct === null || realizationPct === undefined) return 'no_data';
  if (realizationPct >= 1) return 'overperform';
  const pace = (progressTimePct === null || progressTimePct === undefined || progressTimePct <= 0) ? 1 : progressTimePct;
  let status;
  if (realizationPct >= pace * 0.9) status = 'aman';
  else if (realizationPct >= pace * 0.6) status = 'waspada';
  else status = 'kritis';
  if (typeof estimatedPct === 'number' && Number.isFinite(estimatedPct)) {
    let idx = STATUS_ORDER.indexOf(status);
    if (estimatedPct >= 1 && idx < STATUS_ORDER.length - 1) idx += 1;
    else if (estimatedPct < 0.7 && idx > 0) idx -= 1;
    status = STATUS_ORDER[idx];
  }
  return status;
}

/** Progress waktu dalam 1 bulan tertentu (untuk status per-bulan breakdown). */
function monthProgressPct(monthKey, asOfDate) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey) || !asOfDate) return null;
  const [y, m] = monthKey.split('-').map(Number);
  const asOf = new Date(asOfDate);
  if (Number.isNaN(asOf.getTime())) return null;
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m, 0)); // hari terakhir bulan itu
  if (asOf < monthStart) return 0; // bulan depan, belum bisa dinilai
  if (asOf > monthEnd) return 1; // bulan sudah lewat penuh
  const daysInMonth = monthEnd.getUTCDate();
  const dayOfMonth = asOf.getUTCDate();
  return dayOfMonth / daysInMonth;
}

/** Progress waktu dalam 1 minggu (kalau week_start/week_end tersedia). */
function weekProgressPct(weekStart, weekEnd, asOfDate) {
  if (!weekStart || !weekEnd || !asOfDate) return null;
  const start = new Date(weekStart), end = new Date(weekEnd), asOf = new Date(asOfDate);
  if ([start, end, asOf].some(d => Number.isNaN(d.getTime()))) return null;
  if (asOf < start) return 0;
  if (asOf > end) return 1;
  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) return 1;
  return (asOf.getTime() - start.getTime()) / totalMs;
}

/** Turunkan 3 bulan (YYYY-MM) dari periode "YYYY-QN" — general, bukan hardcode Q3. */
function expectedMonthsForPeriode(periode) {
  const m = /^(\d{4})-Q([1-4])$/.exec(periode || '');
  if (!m) return [];
  const year = Number(m[1]);
  const startMonth = (Number(m[2]) - 1) * 3 + 1;
  return [0, 1, 2].map(i => `${year}-${String(startMonth + i).padStart(2, '0')}`);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/quick-win-q3/periods
// ─────────────────────────────────────────────────────────────────────────
async function periodsHandler(req, res) {
  try {
    const r = await pool.query(`
      SELECT periode, label, period_start, period_end,
        (SELECT MAX(synced_at) FROM iqwm_qw_sync_log s WHERE s.periode = p.periode) AS last_sync
      FROM iqwm_qw_period_config p
      ORDER BY periode DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/quick-win-q3/sync
// ─────────────────────────────────────────────────────────────────────────
async function syncHandler(req, res) {
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const periode = body.periode;
  if (!isValidPeriode(periode)) {
    return res.status(400).json({ error: 'periode wajib format YYYY-QN, contoh 2026-Q3' });
  }
  const resumeRows = Array.isArray(body.resume) ? body.resume : [];
  const breakdownRows = Array.isArray(body.breakdown) ? body.breakdown : [];

  // Dedup by unique key SEBELUM insert — upsert (ON CONFLICT) tetap dipakai
  // sebagai jaring pengaman kedua, tapi duplikat di DALAM 1 payload perlu
  // dihitung di sini dulu (setelah upsert, jejak duplikatnya hilang).
  const resumeMap = new Map();
  let resumeDup = 0;
  for (const row of resumeRows) {
    const key = `${row?.product ?? ''}|${row?.quickwin_no ?? ''}`;
    if (resumeMap.has(key)) resumeDup++;
    resumeMap.set(key, row);
  }
  const breakdownMap = new Map();
  let breakdownDup = 0;
  for (const row of breakdownRows) {
    const key = `${row?.product ?? ''}|${row?.quickwin_no ?? ''}|${row?.metric_label ?? ''}|${row?.month_key ?? ''}|${row?.week_label ?? ''}`;
    if (breakdownMap.has(key)) breakdownDup++;
    breakdownMap.set(key, row);
  }
  const resumeEntries = [...resumeMap.values()];
  const breakdownEntries = [...breakdownMap.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Upsert period config (kalau info periode dikirim)
    if (body.label || body.period_start || body.period_end || body.as_of_date) {
      await client.query(
        `INSERT INTO iqwm_qw_period_config
           (periode, label, period_start, period_end, as_of_date, total_days, days_elapsed, source_url, source_meta, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (periode) DO UPDATE SET
           label = EXCLUDED.label, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
           as_of_date = EXCLUDED.as_of_date, total_days = EXCLUDED.total_days, days_elapsed = EXCLUDED.days_elapsed,
           source_url = EXCLUDED.source_url, source_meta = EXCLUDED.source_meta, updated_at = NOW()`,
        [
          periode, nullIfEmpty(body.label), nullIfEmpty(body.period_start), nullIfEmpty(body.period_end),
          nullIfEmpty(body.as_of_date), safeNumber(body.total_days), safeNumber(body.days_elapsed),
          nullIfEmpty(body.source_url), JSON.stringify(body.meta || {}),
        ]
      );
    }

    // 2) Replace per periode (BUKAN append, BUKAN hapus periode lain)
    await client.query('DELETE FROM iqwm_qw_resume WHERE periode = $1', [periode]);
    await client.query('DELETE FROM iqwm_qw_breakdown WHERE periode = $1', [periode]);

    // 3) Insert resume
    let resumeInserted = 0;
    for (const row of resumeEntries) {
      const targetValue = safeNumber(row.target_value);
      const targetRevenue = safeNumber(row.target_revenue);
      const realizationTarget = safeNumber(row.realization_target);
      const realizationRevenue = safeNumber(row.realization_revenue);
      await client.query(
        `INSERT INTO iqwm_qw_resume
           (periode, product, quickwin_no, point_quickwin, target_label, target_value, target_revenue,
            realization_target, realization_target_pct, realization_revenue, realization_revenue_pct,
            pic, estimated_end_q3, estimated_target_value_end_q3, source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (periode, product, quickwin_no) DO UPDATE SET
           point_quickwin = EXCLUDED.point_quickwin, target_label = EXCLUDED.target_label,
           target_value = EXCLUDED.target_value, target_revenue = EXCLUDED.target_revenue,
           realization_target = EXCLUDED.realization_target, realization_target_pct = EXCLUDED.realization_target_pct,
           realization_revenue = EXCLUDED.realization_revenue, realization_revenue_pct = EXCLUDED.realization_revenue_pct,
           pic = EXCLUDED.pic, estimated_end_q3 = EXCLUDED.estimated_end_q3,
           estimated_target_value_end_q3 = EXCLUDED.estimated_target_value_end_q3,
           source_sheet = EXCLUDED.source_sheet, source_row = EXCLUDED.source_row,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          periode, nullIfEmpty(row.product), Number.isFinite(Number(row.quickwin_no)) ? Number(row.quickwin_no) : null,
          nullIfEmpty(row.point_quickwin), nullIfEmpty(row.target_label), targetValue, targetRevenue,
          realizationTarget, safePercent(row.realization_target_pct) ?? safeDiv(realizationTarget, targetValue),
          realizationRevenue, safePercent(row.realization_revenue_pct) ?? safeDiv(realizationRevenue, targetRevenue),
          nullIfEmpty(row.pic), safeNumber(row.estimated_end_q3), safeNumber(row.estimated_target_value_end_q3),
          nullIfEmpty(row.source_sheet), Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      resumeInserted++;
    }

    // 4) Insert breakdown
    let breakdownInserted = 0;
    for (const row of breakdownEntries) {
      const targetValue = safeNumber(row.target_value);
      const realizationValue = safeNumber(row.realization_value);
      const gapValue = (targetValue !== null && realizationValue !== null) ? (targetValue - realizationValue) : null;
      await client.query(
        `INSERT INTO iqwm_qw_breakdown
           (periode, product, quickwin_no, point_quickwin, metric_label, metric_type, month_key, month_label,
            week_label, week_start, week_end, target_value, realization_value, realization_pct, gap_value,
            source_sheet, source_row, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
         ON CONFLICT (periode, product, quickwin_no, metric_label, month_key, week_label) DO UPDATE SET
           point_quickwin = EXCLUDED.point_quickwin, metric_type = EXCLUDED.metric_type,
           month_label = EXCLUDED.month_label, week_start = EXCLUDED.week_start, week_end = EXCLUDED.week_end,
           target_value = EXCLUDED.target_value, realization_value = EXCLUDED.realization_value,
           realization_pct = EXCLUDED.realization_pct, gap_value = EXCLUDED.gap_value,
           source_sheet = EXCLUDED.source_sheet, source_row = EXCLUDED.source_row,
           raw_data = EXCLUDED.raw_data, synced_at = NOW()`,
        [
          periode, nullIfEmpty(row.product), Number.isFinite(Number(row.quickwin_no)) ? Number(row.quickwin_no) : null,
          nullIfEmpty(row.point_quickwin), nullIfEmpty(row.metric_label), nullIfEmpty(row.metric_type) || 'unknown',
          nullIfEmpty(row.month_key), nullIfEmpty(row.month_label), nullIfEmpty(row.week_label) || 'month_total',
          nullIfEmpty(row.week_start), nullIfEmpty(row.week_end), targetValue, realizationValue,
          safePercent(row.realization_pct) ?? safeDiv(realizationValue, targetValue), gapValue,
          nullIfEmpty(row.source_sheet), Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      breakdownInserted++;
    }

    // 5) Sync log sukses
    await client.query(
      `INSERT INTO iqwm_qw_sync_log
         (periode, source, resume_rows_received, resume_rows_inserted, breakdown_rows_received, breakdown_rows_inserted,
          status, error_message, payload_meta, synced_at)
       VALUES ($1,'quick_win_q3',$2,$3,$4,$5,'success',NULL,$6,NOW())`,
      [
        periode, resumeRows.length, resumeInserted, breakdownRows.length, breakdownInserted,
        JSON.stringify({
          duplicate_resume_count: resumeDup,
          duplicate_breakdown_count: breakdownDup,
          sheet_names: body.meta?.sheet_names || [],
          synced_by: body.meta?.synced_by || null,
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      periode,
      resume_rows_inserted: resumeInserted,
      breakdown_rows_inserted: breakdownInserted,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    try {
      await pool.query(
        `INSERT INTO iqwm_qw_sync_log
           (periode, source, resume_rows_received, resume_rows_inserted, breakdown_rows_received, breakdown_rows_inserted,
            status, error_message, payload_meta, synced_at)
         VALUES ($1,'quick_win_q3',$2,0,$3,0,'failed',$4,'{}',NOW())`,
        [periode, resumeRows.length, breakdownRows.length, String(err.message || 'unknown error').slice(0, 500)]
      );
    } catch (_) { /* jangan sampai gagal logging menutupi error asli */ }
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/quick-win-q3/analytics?periode=2026-Q3
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    let periode = req.query.periode;
    if (!isValidPeriode(periode)) {
      const latest = await pool.query('SELECT periode FROM iqwm_qw_period_config ORDER BY periode DESC LIMIT 1');
      periode = latest.rows[0]?.periode || null;
    }
    if (!periode) {
      return res.json({ empty: true, message: 'Belum ada data Quick Win Q3 yang tersinkron.' });
    }

    const [configRes, resumeRes, breakdownRes, lastSyncRes] = await Promise.all([
      pool.query('SELECT * FROM iqwm_qw_period_config WHERE periode = $1', [periode]),
      pool.query('SELECT * FROM iqwm_qw_resume WHERE periode = $1 ORDER BY product, quickwin_no', [periode]),
      pool.query('SELECT * FROM iqwm_qw_breakdown WHERE periode = $1 ORDER BY product, month_key, quickwin_no, metric_label, week_label', [periode]),
      pool.query('SELECT MAX(synced_at) AS t FROM iqwm_qw_sync_log WHERE periode = $1', [periode]),
    ]);

    const config = configRes.rows[0] || null;
    const resumeRows = resumeRes.rows;
    const breakdownRows = breakdownRes.rows;

    if (!config && resumeRows.length === 0 && breakdownRows.length === 0) {
      return res.json({ empty: true, message: 'Belum ada data Quick Win Q3 untuk periode ini.' });
    }

    // ── Meta & progress waktu ──────────────────────────────────────────
    let totalDays = config?.total_days ?? null;
    let daysElapsed = config?.days_elapsed ?? null;
    const asOfDate = config?.as_of_date || null;
    if ((totalDays === null || daysElapsed === null) && config?.period_start && config?.period_end && asOfDate) {
      const start = new Date(config.period_start), end = new Date(config.period_end), asOf = new Date(asOfDate);
      if (![start, end, asOf].some(d => Number.isNaN(d.getTime()))) {
        totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
        daysElapsed = Math.min(totalDays, Math.max(0, Math.round((asOf - start) / 86400000) + 1));
      }
    }
    const progressTimePct = safeDiv(daysElapsed, totalDays);

    const meta = {
      periode,
      label: config?.label || periode,
      period_start: config?.period_start || null,
      period_end: config?.period_end || null,
      as_of_date: asOfDate,
      total_days: totalDays,
      days_elapsed: daysElapsed,
      progress_time_pct: progressTimePct,
      last_sync: lastSyncRes.rows[0]?.t || null,
      source_url: config?.source_url || null,
    };

    // ── Quick Win List ──────────────────────────────────────────────────
    const quickwins = resumeRows.map(r => {
      const targetRevenue = r.target_revenue !== null ? Number(r.target_revenue) : null;
      const realizationRevenue = r.realization_revenue !== null ? Number(r.realization_revenue) : null;
      const targetValue = r.target_value !== null ? Number(r.target_value) : null;
      const realizationTarget = r.realization_target !== null ? Number(r.realization_target) : null;
      const estimatedEndQ3 = r.estimated_end_q3 !== null ? Number(r.estimated_end_q3) : null;

      const revenuePct = r.realization_revenue_pct !== null ? Number(r.realization_revenue_pct) : safeDiv(realizationRevenue, targetRevenue);
      const targetPct = r.realization_target_pct !== null ? Number(r.realization_target_pct) : safeDiv(realizationTarget, targetValue);
      const primaryPct = (targetRevenue && targetRevenue > 0) ? revenuePct : ((targetValue && targetValue > 0) ? targetPct : null);
      const estimatedPct = (targetRevenue && targetRevenue > 0) ? safeDiv(estimatedEndQ3, targetRevenue) : null;

      const status = calculateStatus(primaryPct, progressTimePct, estimatedPct);
      const revenueGap = (targetRevenue !== null && realizationRevenue !== null) ? (targetRevenue - realizationRevenue) : null;
      const paceGap = (targetRevenue !== null && realizationRevenue !== null && progressTimePct !== null)
        ? ((targetRevenue * progressTimePct) - realizationRevenue) : null;

      const RECO_BY_STATUS = {
        kritis: `Perlu perhatian segera dari PIC ${r.pic || '(belum ditentukan)'} — realisasi jauh di bawah pace waktu.`,
        waspada: `Pantau ketat, dorong akselerasi bersama PIC ${r.pic || '(belum ditentukan)'} sebelum makin tertinggal dari pace.`,
        aman: 'Jaga momentum, pastikan tidak melambat di sisa periode.',
        overperform: 'Jadikan benchmark — identifikasi faktor pendorong untuk direplikasi ke Quick Win lain.',
        no_data: 'Data target/realisasi belum lengkap — cek sinkronisasi sheet.',
      };

      return {
        product: r.product,
        quickwin_no: r.quickwin_no,
        point_quickwin: r.point_quickwin,
        target_label: r.target_label,
        target_value: targetValue,
        target_revenue: targetRevenue,
        realization_target: realizationTarget,
        realization_target_pct: targetPct,
        realization_revenue: realizationRevenue,
        realization_revenue_pct: revenuePct,
        pic: r.pic,
        estimated_end_q3: estimatedEndQ3,
        estimated_target_value_end_q3: r.estimated_target_value_end_q3 !== null ? Number(r.estimated_target_value_end_q3) : null,
        revenue_gap: revenueGap,
        pace_gap: paceGap,
        status,
        priority: PRIORITY_BY_STATUS[status] || 'P4',
        recommendation: RECO_BY_STATUS[status],
      };
    });

    // ── Executive Summary ───────────────────────────────────────────────
    const totalTargetRevenueQ3 = quickwins.reduce((s, q) => s + (q.target_revenue || 0), 0);
    const totalRealizationRevenue = quickwins.reduce((s, q) => s + (q.realization_revenue || 0), 0);
    const totalEstimatedEndQ3 = quickwins.reduce((s, q) => s + (q.estimated_end_q3 || 0), 0);
    const statusCounts = quickwins.reduce((acc, q) => { acc[q.status] = (acc[q.status] || 0) + 1; return acc; }, {});

    const summary = {
      total_target_revenue_q3: totalTargetRevenueQ3,
      total_realization_revenue: totalRealizationRevenue,
      revenue_achievement_pct: safeDiv(totalRealizationRevenue, totalTargetRevenueQ3),
      total_estimated_end_q3: totalEstimatedEndQ3,
      estimated_achievement_pct: safeDiv(totalEstimatedEndQ3, totalTargetRevenueQ3),
      total_gap_revenue: totalTargetRevenueQ3 - totalRealizationRevenue,
      quickwin_count: quickwins.length,
      quickwin_aman_count: statusCounts.aman || 0,
      quickwin_waspada_count: statusCounts.waspada || 0,
      quickwin_kritis_count: statusCounts.kritis || 0,
      quickwin_overperform_count: statusCounts.overperform || 0,
      products_count: new Set(quickwins.map(q => q.product)).size,
    };

    // ── Product Summary (fleksibel — bukan hardcode 2 produk) ──────────
    const productMap = new Map();
    for (const q of quickwins) {
      const key = q.product || '(tanpa produk)';
      if (!productMap.has(key)) {
        productMap.set(key, { product: key, quickwin_count: 0, target_revenue: 0, realization_revenue: 0, estimated_end_q3: 0, statuses: [], pic_set: new Set() });
      }
      const p = productMap.get(key);
      p.quickwin_count += 1;
      p.target_revenue += q.target_revenue || 0;
      p.realization_revenue += q.realization_revenue || 0;
      p.estimated_end_q3 += q.estimated_end_q3 || 0;
      p.statuses.push(q.status);
      if (q.pic) p.pic_set.add(q.pic);
    }
    const products = [...productMap.values()].map(p => {
      const revenueAchievementPct = safeDiv(p.realization_revenue, p.target_revenue);
      const estimatedAchievementPct = safeDiv(p.estimated_end_q3, p.target_revenue);
      const productStatus = calculateStatus(revenueAchievementPct, progressTimePct, estimatedAchievementPct);
      const worst = p.statuses.includes('kritis') ? 'kritis' : (p.statuses.includes('waspada') ? 'waspada' : productStatus);
      return {
        product: p.product,
        quickwin_count: p.quickwin_count,
        target_revenue: p.target_revenue,
        realization_revenue: p.realization_revenue,
        revenue_achievement_pct: revenueAchievementPct,
        estimated_end_q3: p.estimated_end_q3,
        estimated_achievement_pct: estimatedAchievementPct,
        gap_revenue: p.target_revenue - p.realization_revenue,
        status: productStatus,
        top_risk: worst,
        pic_list: [...p.pic_set],
      };
    });

    // ── Monthly Breakdown — jumlahkan baris mingguan (week_1..5) per bulan;
    // baris 'month_total'/'q3_total' TIDAK diikutkan supaya tidak double count ──
    const monthlyMap = new Map();
    for (const b of breakdownRows) {
      if (!/^week_\d+$/.test(b.week_label || '')) continue;
      const key = `${b.product}|${b.month_key}|${b.metric_label}`;
      if (!monthlyMap.has(key)) {
        monthlyMap.set(key, { product: b.product, month_key: b.month_key, month_label: b.month_label, metric_label: b.metric_label, target_value: 0, realization_value: 0 });
      }
      const m = monthlyMap.get(key);
      m.target_value += b.target_value !== null ? Number(b.target_value) : 0;
      m.realization_value += b.realization_value !== null ? Number(b.realization_value) : 0;
    }
    const monthlyBreakdown = [...monthlyMap.values()].map(m => {
      const pct = safeDiv(m.realization_value, m.target_value);
      const monthPace = monthProgressPct(m.month_key, asOfDate) ?? progressTimePct;
      return {
        product: m.product, month_key: m.month_key, month_label: m.month_label, metric_label: m.metric_label,
        target_value: m.target_value, realization_value: m.realization_value, realization_pct: pct,
        gap_value: m.target_value - m.realization_value,
        status: calculateStatus(pct, monthPace),
      };
    });

    // ── Weekly Breakdown — hanya baris week_1..5 (bukan agregat) ────────
    const weeklyBreakdown = breakdownRows
      .filter(b => /^week_\d+$/.test(b.week_label || ''))
      .map(b => {
        const targetValue = b.target_value !== null ? Number(b.target_value) : null;
        const realizationValue = b.realization_value !== null ? Number(b.realization_value) : null;
        const pct = b.realization_pct !== null ? Number(b.realization_pct) : safeDiv(realizationValue, targetValue);
        const weekPace = weekProgressPct(b.week_start, b.week_end, asOfDate) ?? progressTimePct;
        return {
          product: b.product, quickwin_no: b.quickwin_no, metric_label: b.metric_label, metric_type: b.metric_type,
          month_key: b.month_key, month_label: b.month_label, week_label: b.week_label,
          week_start: b.week_start, week_end: b.week_end,
          target_value: targetValue, realization_value: realizationValue, realization_pct: pct,
          gap_value: (targetValue !== null && realizationValue !== null) ? (targetValue - realizationValue) : null,
          status: calculateStatus(pct, weekPace),
        };
      });

    // ── Data Quality ─────────────────────────────────────────────────────
    const lastSyncLogRes = await pool.query(
      `SELECT payload_meta FROM iqwm_qw_sync_log WHERE periode = $1 AND status = 'success' ORDER BY synced_at DESC LIMIT 1`,
      [periode]
    );
    const lastMeta = lastSyncLogRes.rows[0]?.payload_meta || {};
    const duplicateQuickwin = Number(lastMeta.duplicate_resume_count || 0) + Number(lastMeta.duplicate_breakdown_count || 0);

    const formulaErrorCount = resumeRows.filter(r => JSON.stringify(r.raw_data || {}).match(/#NAME\?|#DIV\/0!|#VALUE!|#N\/A|#REF!/i)).length
      + breakdownRows.filter(b => JSON.stringify(b.raw_data || {}).match(/#NAME\?|#DIV\/0!|#VALUE!|#N\/A|#REF!/i)).length;

    const expectedMonths = expectedMonthsForPeriode(periode);
    const productsInResume = [...new Set(resumeRows.map(r => r.product).filter(Boolean))];
    let breakdownMissingMonth = 0;
    for (const prod of productsInResume) {
      const monthsPresent = new Set(breakdownRows.filter(b => b.product === prod).map(b => b.month_key));
      breakdownMissingMonth += expectedMonths.filter(mk => !monthsPresent.has(mk)).length;
    }
    const winmeMonths = new Set(breakdownRows.filter(b => b.product === 'Winme').map(b => b.month_key));
    const instaqrisMonths = new Set(breakdownRows.filter(b => b.product === 'InstaQRIS').map(b => b.month_key));
    const missingBreakdownWinme = expectedMonths.filter(mk => !winmeMonths.has(mk)).length;
    const missingBreakdownInstaqris = expectedMonths.filter(mk => !instaqrisMonths.has(mk)).length;

    // summary_breakdown_mismatch: bandingkan revenue resume vs breakdown per produk (>20% beda dianggap perlu dicek)
    let summaryBreakdownMismatch = 0;
    for (const p of products) {
      const breakdownRevenue = breakdownRows
        .filter(b => b.product === p.product && b.metric_type === 'revenue' && /^week_\d+$/.test(b.week_label || ''))
        .reduce((s, b) => s + (b.realization_value !== null ? Number(b.realization_value) : 0), 0);
      if (p.realization_revenue > 0 || breakdownRevenue > 0) {
        const base = Math.max(p.realization_revenue, breakdownRevenue, 1);
        if (Math.abs(p.realization_revenue - breakdownRevenue) / base > 0.2) summaryBreakdownMismatch++;
      }
    }

    const dqChecks = [
      { key: 'formula_error_count', label: 'Formula error dari Google Sheet (#NAME?, #DIV/0!, dst)', count: formulaErrorCount, recommendation: 'Cek cell terkait di Google Sheet, perbaiki formula sumber.' },
      { key: 'missing_product', label: 'Baris tanpa nama product', count: resumeRows.filter(r => !r.product).length + breakdownRows.filter(b => !b.product).length, recommendation: 'Pastikan kolom Product terisi di semua baris.' },
      { key: 'missing_point_quickwin', label: 'Baris tanpa Point Quick Win', count: resumeRows.filter(r => !r.point_quickwin).length, recommendation: 'Lengkapi kolom Point Quick Win di Resume IQWM.' },
      { key: 'missing_pic', label: 'Quick Win tanpa PIC', count: resumeRows.filter(r => !r.pic).length, recommendation: 'Tentukan PIC untuk setiap Quick Win.' },
      { key: 'invalid_target_revenue', label: 'Target Revenue tidak terbaca', count: resumeRows.filter(r => r.target_revenue === null).length, recommendation: 'Cek format angka/formula di kolom Target Revenue.' },
      { key: 'invalid_realization', label: 'Realisasi tidak terbaca', count: resumeRows.filter(r => r.realization_target === null && r.realization_revenue === null).length, recommendation: 'Cek format angka/formula di kolom Realisasi.' },
      { key: 'invalid_percentage', label: 'Persentase tidak terbaca', count: resumeRows.filter(r => r.realization_target_pct === null && r.realization_revenue_pct === null).length, recommendation: 'Cek formula % di sheet, kemungkinan #DIV/0! karena target masih 0.' },
      { key: 'breakdown_missing_month', label: 'Kombinasi produk+bulan yang belum ada breakdown', count: breakdownMissingMonth, recommendation: 'Pastikan ketiga bulan Q3 sudah disinkronkan untuk setiap produk.' },
      { key: 'duplicate_quickwin', label: 'Baris duplikat dalam sync terakhir', count: duplicateQuickwin, recommendation: 'Cek sheet sumber untuk baris Quick Win yang tertulis dobel.' },
      { key: 'missing_breakdown_winme', label: 'Bulan breakdown Winme yang belum ada', count: missingBreakdownWinme, recommendation: 'Cek sync sheet "Breakdown Target Winme".' },
      { key: 'missing_breakdown_instaqris', label: 'Bulan breakdown InstaQRIS yang belum ada', count: missingBreakdownInstaqris, recommendation: 'Cek sync sheet "Breakdown Target Instaqris".' },
      { key: 'summary_breakdown_mismatch', label: 'Selisih revenue Resume vs Breakdown per produk >20%', count: summaryBreakdownMismatch, recommendation: 'Bandingkan angka Resume IQWM dengan total breakdown mingguan per produk.' },
    ].map(c => ({ ...c, severity: c.count === 0 ? 'low' : (c.count >= 3 ? 'high' : 'medium') }));

    // ── Insights (maks 5) ────────────────────────────────────────────────
    const insights = [];
    if (summary.revenue_achievement_pct !== null && progressTimePct !== null && summary.revenue_achievement_pct < progressTimePct * 0.6) {
      insights.push({ severity: 'high', title: 'Revenue Q3 di bawah pace', description: `Realisasi revenue baru ${(summary.revenue_achievement_pct * 100).toFixed(1)}% dari target, padahal waktu sudah berjalan ${(progressTimePct * 100).toFixed(1)}%.`, recommendation: 'Evaluasi Quick Win dengan status kritis, fokuskan resource ke sana.' });
    }
    const zeroRealization = quickwins.filter(q => (q.realization_revenue || 0) === 0 && (q.realization_target || 0) === 0 && (q.target_revenue || 0) > 0);
    if (zeroRealization.length > 0) {
      insights.push({ severity: 'high', title: 'Quick Win tanpa realisasi sama sekali', description: `${zeroRealization.length} Quick Win (${zeroRealization.map(q => `${q.product} #${q.quickwin_no}`).join(', ')}) belum ada realisasi sama sekali.`, recommendation: 'Cek apakah eksekusi belum mulai atau ada masalah pencatatan data.' });
    }
    if (summary.estimated_achievement_pct !== null && summary.estimated_achievement_pct < 0.7) {
      insights.push({ severity: 'high', title: 'Estimasi akhir Q3 di bawah target', description: `Estimasi akhir Q3 hanya ${(summary.estimated_achievement_pct * 100).toFixed(1)}% dari target revenue.`, recommendation: 'Perlu akselerasi signifikan atau revisi target bersama manajemen.' });
    }
    if (products.length >= 2) {
      const sorted = [...products].sort((a, b) => (a.revenue_achievement_pct ?? 0) - (b.revenue_achievement_pct ?? 0));
      const worst = sorted[0], best = sorted[sorted.length - 1];
      if (worst && best && worst.revenue_achievement_pct !== null && best.revenue_achievement_pct !== null
        && (best.revenue_achievement_pct - worst.revenue_achievement_pct) > 0.3) {
        insights.push({ severity: 'medium', title: `${worst.product} tertinggal jauh dari ${best.product}`, description: `${worst.product} baru ${(worst.revenue_achievement_pct * 100).toFixed(1)}% vs ${best.product} ${(best.revenue_achievement_pct * 100).toFixed(1)}%.`, recommendation: `Pelajari faktor pendorong ${best.product} untuk direplikasi ke ${worst.product}.` });
      }
    }
    const kritisWeekly = weeklyBreakdown.filter(w => w.status === 'kritis').length;
    if (weeklyBreakdown.length > 0 && kritisWeekly / weeklyBreakdown.length > 0.3) {
      insights.push({ severity: 'medium', title: 'Banyak breakdown mingguan di bawah target', description: `${kritisWeekly} dari ${weeklyBreakdown.length} baris mingguan berstatus kritis.`, recommendation: 'Cek pola minggu mana yang paling sering tertinggal untuk setiap Quick Win.' });
    }
    const dqIssueTotal = dqChecks.reduce((s, c) => s + c.count, 0);
    if (dqIssueTotal > 0) {
      insights.push({ severity: dqIssueTotal >= 5 ? 'high' : 'medium', title: 'Kualitas data perlu dicek', description: `${dqIssueTotal} isu data quality ditemukan (formula error, data hilang, atau mismatch).`, recommendation: 'Lihat panel Data Quality untuk detail per kategori.' });
    }

    // ── Action Summary (maks 20) ─────────────────────────────────────────
    const actionSummary = [];
    for (const q of quickwins) {
      if (q.status === 'no_data') continue; // sudah tercermin di data quality
      actionSummary.push({
        priority: q.priority, product: q.product, quickwin_no: q.quickwin_no,
        title: q.point_quickwin || `Quick Win #${q.quickwin_no}`, count: 1, recommendation: q.recommendation,
      });
    }
    for (const c of dqChecks) {
      if (c.count > 0) actionSummary.push({ priority: 'P4', product: null, quickwin_no: null, title: c.label, count: c.count, recommendation: c.recommendation });
    }

    res.json({
      meta,
      summary,
      products,
      quickwins,
      monthly_breakdown: monthlyBreakdown,
      weekly_breakdown: weeklyBreakdown,
      insights: insights.slice(0, 5),
      action_summary: actionSummary.slice(0, 20),
      data_quality: dqChecks,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  periodsHandler,
  syncHandler,
  analyticsHandler,
  _internal: { safeNumber, safePercent, isFormulaError, normalizeStatus, calculateStatus, expectedMonthsForPeriode, monthProgressPct, weekProgressPct },
};
