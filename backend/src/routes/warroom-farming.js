/**
 * WAR-ROOM Payment Agent > Farming — Farming Fastpay Command Center
 *
 * UPGRADE dari implementasi lama (data hardcode Mei/Jun). Route/URL/menu
 * TIDAK berubah (/war-room/farming, badge "Nizar"), tapi model data & payload
 * sync SEPENUHNYA baru — lihat docs/FARMING_COMMAND_CENTER.md.
 *
 * Tabel LAMA `farming_snapshot` TIDAK disentuh (histori lama tetap ada).
 * Tabel BARU: farming_outlet_snapshot, farming_sync_log, farming_outlet_followup
 * (backend/src/migrations/create_farming_command_center.sql).
 *
 * PENTING: payload sync Apps Script LAMA (format `{tanggal, data:[...]}` dgn
 * field bernama trx_mei_full dst) TIDAK LAGI KOMPATIBEL — sync sekarang
 * menerima headers[] + rows[] mentah (lihat §11 spec / apps-script-farming.js).
 */

const pool = require('../db');
const { safeNumber } = require('../farming/numberParser');
const { parseFarmingHeaders } = require('../farming/headerParser');
const { computeRowMetrics, finalizePriorities } = require('../farming/businessLogic');

// Sengaja TIDAK ADA fallback hardcoded — kalau env belum diset di server,
// semua sync request ditolak 401 sampai admin set FARMING_SYNC_TOKEN.
const SYNC_TOKEN = process.env.FARMING_SYNC_TOKEN;

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

function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/farming/sync
// ─────────────────────────────────────────────────────────────────────────
async function syncHandler(req, res) {
  const startedAt = Date.now();
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const snapshotDate = isValidDate(body.snapshot_date) ? body.snapshot_date : null;
  if (!snapshotDate) {
    return res.status(400).json({ error: 'snapshot_date wajib diisi, format YYYY-MM-DD' });
  }
  const headers = Array.isArray(body.headers) ? body.headers : null;
  const rawRows = Array.isArray(body.rows) ? body.rows : null;
  if (!headers || !rawRows) {
    return res.status(400).json({ error: 'headers[] dan rows[] wajib diisi (array)' });
  }

  const sourceSheet = nullIfEmpty(body.sheet_name) || 'Farming';
  const sourceSpreadsheetId = nullIfEmpty(body.spreadsheet_id);
  const syncBatchId = `${snapshotDate}-${Date.now()}`;

  const parsed = parseFarmingHeaders(headers, snapshotDate);
  if (!parsed.ok) {
    await logSyncAttempt({
      syncBatchId, snapshotDate, sourceSheet,
      rowsReceived: rawRows.length, rowsValid: 0, rowsSkipped: 0, rowsInserted: 0, rowsUpdated: 0, rowsError: rawRows.length,
      labels: null, originalHeaders: headers, errorSummary: { errors: parsed.errors, diagnostics: parsed.diagnostics },
      durationMs: Date.now() - startedAt, status: 'failed',
    });
    return res.status(400).json({
      error: 'Header sheet tidak dikenali / tidak lengkap — sync dibatalkan.',
      details: parsed.errors,
      diagnostics: parsed.diagnostics,
      found_headers: parsed.foundHeaders,
    });
  }

  const { columnMap, labels, warnings } = parsed;
  const outletMap = new Map(); // id_outlet -> row terakhir (dedup last-occurrence-wins)
  let duplicateCount = 0;
  let missingIdCount = 0;
  let malformedNumericCount = 0;

  for (const raw of rawRows) {
    if (!Array.isArray(raw)) continue;
    const idOutlet = nullIfEmpty(raw[columnMap.idOutletIdx]);
    if (!idOutlet) { missingIdCount++; continue; }
    if (outletMap.has(idOutlet)) duplicateCount++;

    const baselineFullTrx = safeNumber(raw[columnMap.baselineFullTrxIdx]);
    const baselineFullRevenue = safeNumber(raw[columnMap.baselineFullRevIdx]);
    const previousTrxRaw = safeNumber(raw[columnMap.previousTrxIdx]);
    const previousRevenueRaw = safeNumber(raw[columnMap.previousRevIdx]);
    const currentTrxRaw = safeNumber(raw[columnMap.currentTrxIdx]);
    const currentRevenueRaw = safeNumber(raw[columnMap.currentRevIdx]);
    const sheetDevTrx = columnMap.devTrxIdx !== null ? safeNumber(raw[columnMap.devTrxIdx]) : null;
    const sheetDevRevenue = columnMap.devRevIdx !== null ? safeNumber(raw[columnMap.devRevIdx]) : null;
    const layerArpu = columnMap.layerArpuIdx !== null ? nullIfEmpty(raw[columnMap.layerArpuIdx]) : null;

    // Malformed = sel punya isi tapi gagal di-parse jadi angka (beda dengan sel yang memang kosong).
    const numericCells = [
      [columnMap.baselineFullTrxIdx, baselineFullTrx], [columnMap.baselineFullRevIdx, baselineFullRevenue],
      [columnMap.previousTrxIdx, previousTrxRaw], [columnMap.previousRevIdx, previousRevenueRaw],
      [columnMap.currentTrxIdx, currentTrxRaw], [columnMap.currentRevIdx, currentRevenueRaw],
    ];
    if (numericCells.some(([colIdx, parsed]) => parsed === null && nullIfEmpty(raw[colIdx]) !== null)) {
      malformedNumericCount++;
    }

    // Blank angka trx/rev dianggap nol aktivitas (bukan "tidak diketahui") —
    // konsisten dengan semantik sheet snapshot harian.
    const previousTrx = previousTrxRaw ?? 0;
    const previousRevenue = previousRevenueRaw ?? 0;
    const currentTrx = currentTrxRaw ?? 0;
    const currentRevenue = currentRevenueRaw ?? 0;

    const calculatedDevTrx = currentTrx - previousTrx;
    const calculatedDevRevenue = currentRevenue - previousRevenue;
    const devTrxVariance = sheetDevTrx !== null ? sheetDevTrx - calculatedDevTrx : null;
    const devRevenueVariance = sheetDevRevenue !== null ? sheetDevRevenue - calculatedDevRevenue : null;

    const metrics = computeRowMetrics({
      previousTrx, previousRevenue, currentTrx, currentRevenue,
      calculatedDevTrx, calculatedDevRevenue, layerArpu,
    });

    outletMap.set(idOutlet, {
      id_outlet: idOutlet,
      baselineFullTrx, baselineFullRevenue,
      previousTrx, previousRevenue, currentTrx, currentRevenue,
      sheetDevTrx, sheetDevRevenue, calculatedDevTrx, calculatedDevRevenue,
      devTrxVariance, devRevenueVariance,
      layerArpu,
      raw_row: raw,
      ...metrics,
    });
  }

  const rows = finalizePriorities([...outletMap.values()]);
  if (!rows.length) {
    await logSyncAttempt({
      syncBatchId, snapshotDate, sourceSheet,
      rowsReceived: rawRows.length, rowsValid: 0, rowsSkipped: missingIdCount, rowsInserted: 0, rowsUpdated: 0, rowsError: 0,
      labels, originalHeaders: headers,
      errorSummary: { warnings, missing_id_count: missingIdCount },
      durationMs: Date.now() - startedAt, status: 'failed',
    });
    return res.status(400).json({ error: 'Tidak ada baris valid (ID Outlet kosong di semua baris?)' });
  }

  const client = await pool.connect();
  let insertedCount = 0;
  let updatedCount = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const upsertRes = await client.query(
        `INSERT INTO farming_outlet_snapshot
           (snapshot_date, source_sheet, source_spreadsheet_id, id_outlet,
            baseline_month_key, baseline_month_label, baseline_full_trx, baseline_full_revenue,
            previous_month_key, previous_month_label, previous_period_start_day, previous_period_end_day,
            previous_period_trx, previous_period_revenue,
            current_month_key, current_month_label, current_period_start_day, current_period_end_day,
            current_period_trx, current_period_revenue,
            sheet_dev_trx, sheet_dev_revenue, calculated_dev_trx, calculated_dev_revenue,
            dev_trx_variance, dev_revenue_variance,
            previous_arpt, current_arpt, arpt_change, arpt_change_pct,
            layer_arpu, status, priority, segment, priority_score, reason_codes,
            raw_row, raw_headers, sync_batch_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,NOW())
         ON CONFLICT (snapshot_date, id_outlet) DO UPDATE SET
           source_sheet = EXCLUDED.source_sheet, source_spreadsheet_id = EXCLUDED.source_spreadsheet_id,
           baseline_month_key = EXCLUDED.baseline_month_key, baseline_month_label = EXCLUDED.baseline_month_label,
           baseline_full_trx = EXCLUDED.baseline_full_trx, baseline_full_revenue = EXCLUDED.baseline_full_revenue,
           previous_month_key = EXCLUDED.previous_month_key, previous_month_label = EXCLUDED.previous_month_label,
           previous_period_start_day = EXCLUDED.previous_period_start_day, previous_period_end_day = EXCLUDED.previous_period_end_day,
           previous_period_trx = EXCLUDED.previous_period_trx, previous_period_revenue = EXCLUDED.previous_period_revenue,
           current_month_key = EXCLUDED.current_month_key, current_month_label = EXCLUDED.current_month_label,
           current_period_start_day = EXCLUDED.current_period_start_day, current_period_end_day = EXCLUDED.current_period_end_day,
           current_period_trx = EXCLUDED.current_period_trx, current_period_revenue = EXCLUDED.current_period_revenue,
           sheet_dev_trx = EXCLUDED.sheet_dev_trx, sheet_dev_revenue = EXCLUDED.sheet_dev_revenue,
           calculated_dev_trx = EXCLUDED.calculated_dev_trx, calculated_dev_revenue = EXCLUDED.calculated_dev_revenue,
           dev_trx_variance = EXCLUDED.dev_trx_variance, dev_revenue_variance = EXCLUDED.dev_revenue_variance,
           previous_arpt = EXCLUDED.previous_arpt, current_arpt = EXCLUDED.current_arpt,
           arpt_change = EXCLUDED.arpt_change, arpt_change_pct = EXCLUDED.arpt_change_pct,
           layer_arpu = EXCLUDED.layer_arpu, status = EXCLUDED.status, priority = EXCLUDED.priority,
           segment = EXCLUDED.segment, priority_score = EXCLUDED.priority_score, reason_codes = EXCLUDED.reason_codes,
           raw_row = EXCLUDED.raw_row, raw_headers = EXCLUDED.raw_headers, sync_batch_id = EXCLUDED.sync_batch_id,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          snapshotDate, sourceSheet, sourceSpreadsheetId, r.id_outlet,
          labels.baseline_month_key, labels.baseline_month_label, r.baselineFullTrx, r.baselineFullRevenue,
          labels.previous_month_key, labels.previous_period_month_label, labels.period_start_day, labels.period_end_day,
          r.previousTrx, r.previousRevenue,
          labels.current_month_key, labels.current_period_month_label, labels.period_start_day, labels.period_end_day,
          r.currentTrx, r.currentRevenue,
          r.sheetDevTrx, r.sheetDevRevenue, r.calculatedDevTrx, r.calculatedDevRevenue,
          r.devTrxVariance, r.devRevenueVariance,
          r.previous_arpt, r.current_arpt, r.arpt_change, r.arpt_change_pct,
          r.layerArpu, r.status, r.priority, r.segment, r.priority_score, JSON.stringify(r.reason_codes),
          JSON.stringify(r.raw_row), JSON.stringify(headers), syncBatchId,
        ]
      );
      if (upsertRes.rows[0]?.inserted) insertedCount++; else updatedCount++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    await logSyncAttempt({
      syncBatchId, snapshotDate, sourceSheet,
      rowsReceived: rawRows.length, rowsValid: rows.length, rowsSkipped: missingIdCount, rowsInserted: 0, rowsUpdated: 0, rowsError: rows.length,
      labels, originalHeaders: headers, errorSummary: { error: err.message },
      durationMs: Date.now() - startedAt, status: 'failed',
    });
    console.error('farming sync error:', err.message);
    return res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }

  const dqIssues = missingIdCount + duplicateCount + malformedNumericCount;
  await logSyncAttempt({
    syncBatchId, snapshotDate, sourceSheet,
    rowsReceived: rawRows.length, rowsValid: rows.length, rowsSkipped: missingIdCount,
    rowsInserted: insertedCount, rowsUpdated: updatedCount, rowsError: 0,
    labels, originalHeaders: headers,
    errorSummary: { warnings, duplicate_count: duplicateCount, missing_id_count: missingIdCount, malformed_numeric_count: malformedNumericCount },
    durationMs: Date.now() - startedAt, status: dqIssues > 0 ? 'partial' : 'success',
  });

  res.json({
    success: true,
    snapshot_date: snapshotDate,
    rows_received: rawRows.length,
    rows_valid: rows.length,
    rows_skipped: missingIdCount,
    rows_inserted: insertedCount,
    rows_updated: updatedCount,
    duplicate_count: duplicateCount,
    labels,
    warnings,
    synced_at: new Date().toISOString(),
  });
}

async function logSyncAttempt({ syncBatchId, snapshotDate, sourceSheet, rowsReceived, rowsValid, rowsSkipped, rowsInserted, rowsUpdated, rowsError, labels, originalHeaders, errorSummary, durationMs, status }) {
  try {
    await pool.query(
      `INSERT INTO farming_sync_log
         (sync_batch_id, snapshot_date, rows_received, rows_valid, rows_skipped, rows_inserted, rows_updated, rows_error,
          labels, original_headers, error_summary, duration_ms, source_sheet, status, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
      [
        syncBatchId, snapshotDate, rowsReceived, rowsValid, rowsSkipped, rowsInserted, rowsUpdated, rowsError,
        JSON.stringify(labels || {}), JSON.stringify(originalHeaders || []), JSON.stringify(errorSummary || {}),
        durationMs, sourceSheet, status,
      ]
    );
  } catch (e) {
    console.error('farming sync_log insert failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper bersama — resolve snapshot_date query param ke tanggal aktual
// ─────────────────────────────────────────────────────────────────────────
async function resolveSnapshotDate(requested) {
  const { rows } = await pool.query(
    'SELECT DISTINCT snapshot_date FROM farming_outlet_snapshot ORDER BY snapshot_date DESC'
  );
  if (!rows.length) return { snapshotDate: null, available: [] };
  const available = rows.map(r => r.snapshot_date);
  if (requested && requested !== 'latest') {
    const match = available.find(d => String(d).slice(0, 10) === requested);
    if (match) return { snapshotDate: match, available };
  }
  return { snapshotDate: available[0], available };
}

function buildLabelsMeta(snapshotRow) {
  return {
    baseline_full: `${snapshotRow.baseline_month_label} Full`,
    previous_period: `${snapshotRow.previous_period_start_day}–${snapshotRow.previous_period_end_day} ${snapshotRow.previous_month_label}`,
    current_period: `${snapshotRow.current_period_start_day}–${snapshotRow.current_period_end_day} ${snapshotRow.current_month_label}`,
    comparison: `${snapshotRow.current_period_start_day}–${snapshotRow.current_period_end_day} ${snapshotRow.current_month_label} vs ${snapshotRow.previous_period_start_day}–${snapshotRow.previous_period_end_day} ${snapshotRow.previous_month_label}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/snapshots
// ─────────────────────────────────────────────────────────────────────────
async function snapshotsHandler(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT s.snapshot_date, MAX(s.synced_at) AS last_sync, COUNT(*) AS outlet_count,
             MAX(l.status) AS sync_status
      FROM farming_outlet_snapshot s
      LEFT JOIN farming_sync_log l ON l.snapshot_date = s.snapshot_date
      GROUP BY s.snapshot_date ORDER BY s.snapshot_date DESC
    `);
    res.json(rows.map(r => ({
      snapshot_date: r.snapshot_date,
      last_sync: r.last_sync,
      outlet_count: Number(r.outlet_count),
      label: String(r.snapshot_date).slice(0, 10),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/analytics?snapshot_date=latest
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const { snapshotDate, available } = await resolveSnapshotDate(nullIfEmpty(req.query.snapshot_date));
    if (!snapshotDate) {
      return res.json({ empty: true, message: 'Data Farming belum tersedia. Jalankan sync Google Sheet terlebih dahulu.' });
    }

    const [rowsRes, lastSyncRes] = await Promise.all([
      pool.query('SELECT * FROM farming_outlet_snapshot WHERE snapshot_date = $1', [snapshotDate]),
      pool.query(`SELECT * FROM farming_sync_log WHERE snapshot_date = $1 ORDER BY synced_at DESC LIMIT 1`, [snapshotDate]),
    ]);
    const rows = rowsRes.rows;
    if (!rows.length) return res.json({ empty: true, message: 'Snapshot belum tersedia.' });

    const labelsMeta = buildLabelsMeta(rows[0]);
    const sum = (key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
    const totalCurrentTrx = sum('current_period_trx');
    const totalCurrentRevenue = sum('current_period_revenue');
    const totalPreviousTrx = sum('previous_period_trx');
    const totalPreviousRevenue = sum('previous_period_revenue');
    const totalRevenueAtRisk = rows.reduce((s, r) => {
      const isRisk = ['declining', 'critical_decline', 'churned'].includes(r.status);
      return s + (isRisk ? Math.max((Number(r.previous_period_revenue) || 0) - (Number(r.current_period_revenue) || 0), 0) : 0);
    }, 0);

    const priorityCounts = {};
    const statusCounts = {};
    const segmentCounts = {};
    const arpuLayerAgg = new Map();
    for (const r of rows) {
      priorityCounts[r.priority] = (priorityCounts[r.priority] || 0) + 1;
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      segmentCounts[r.segment] = (segmentCounts[r.segment] || 0) + 1;
      const layer = r.layer_arpu || 'Tidak Diketahui';
      if (!arpuLayerAgg.has(layer)) arpuLayerAgg.set(layer, { layer_arpu: layer, outlet_count: 0, current_trx: 0, current_revenue: 0, at_risk_count: 0 });
      const agg = arpuLayerAgg.get(layer);
      agg.outlet_count++;
      agg.current_trx += Number(r.current_period_trx) || 0;
      agg.current_revenue += Number(r.current_period_revenue) || 0;
      if (['declining', 'critical_decline', 'churned'].includes(r.status)) agg.at_risk_count++;
    }

    const highTopArpuAtRisk = rows.filter(r => ['High ARPU', 'Top ARPU'].includes(r.layer_arpu) && ['declining', 'critical_decline', 'churned'].includes(r.status));
    const volumeNoRevenue = rows.filter(r => (Number(r.current_period_trx) || 0) > 0 && (Number(r.current_period_revenue) || 0) === 0);

    const topDecline = [...rows].filter(r => (Number(r.calculated_dev_revenue) || 0) < 0)
      .sort((a, b) => Number(a.calculated_dev_revenue) - Number(b.calculated_dev_revenue)).slice(0, 15);
    const topGrowth = [...rows].filter(r => (Number(r.calculated_dev_revenue) || 0) > 0)
      .sort((a, b) => Number(b.calculated_dev_revenue) - Number(a.calculated_dev_revenue)).slice(0, 15);

    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const actionQueuePreview = [...rows]
      .sort((a, b) => (priorityOrder[a.priority] - priorityOrder[b.priority]) || (Number(b.priority_score) - Number(a.priority_score)))
      .slice(0, 10);

    const insights = buildInsights({ rows, labelsMeta, totalRevenueAtRisk, highTopArpuAtRisk, volumeNoRevenue, topGrowth });
    const dataQuality = buildDataQualitySummary({ lastSyncLog: lastSyncRes.rows[0], rows });

    res.json({
      meta: {
        snapshot_date: snapshotDate,
        synced_at: lastSyncRes.rows[0]?.synced_at || rows[0].synced_at,
        source_sheet: rows[0].source_sheet,
        labels: labelsMeta,
        period: { start_day: rows[0].current_period_start_day, end_day: rows[0].current_period_end_day },
        available_snapshots: available.map(d => String(d).slice(0, 10)),
      },
      summary: {
        total_outlet_farming: rows.length,
        outlet_aktif_current: rows.filter(r => (Number(r.current_period_trx) || 0) > 0).length,
        total_trx_current: totalCurrentTrx,
        total_revenue_current: totalCurrentRevenue,
        total_trx_previous: totalPreviousTrx,
        total_revenue_previous: totalPreviousRevenue,
        dev_trx: totalCurrentTrx - totalPreviousTrx,
        dev_revenue: totalCurrentRevenue - totalPreviousRevenue,
        dev_trx_pct: totalPreviousTrx > 0 ? (totalCurrentTrx - totalPreviousTrx) / totalPreviousTrx : null,
        dev_revenue_pct: totalPreviousRevenue > 0 ? (totalCurrentRevenue - totalPreviousRevenue) / totalPreviousRevenue : null,
        revenue_at_risk: totalRevenueAtRisk,
        outlet_p0_count: priorityCounts.P0 || 0,
        high_top_arpu_at_risk_count: highTopArpuAtRisk.length,
        volume_no_revenue_count: volumeNoRevenue.length,
      },
      priority_counts: priorityCounts,
      status_counts: statusCounts,
      segment_counts: segmentCounts,
      arpu_distribution: [...arpuLayerAgg.values()],
      top_decline: topDecline,
      top_growth: topGrowth,
      anomalies: rows.filter(r => {
        const devTrx = Number(r.calculated_dev_trx);
        const devRev = Number(r.calculated_dev_revenue);
        const volNoRev = (Number(r.current_period_trx) || 0) > 0 && (Number(r.current_period_revenue) || 0) === 0;
        const trxUpRevDown = devTrx > 0 && devRev < 0;
        const trxDownRevUp = devTrx < 0 && devRev > 0;
        return volNoRev || trxUpRevDown || trxDownRevUp;
      }).slice(0, 50),
      action_queue_preview: actionQueuePreview,
      insights,
      data_quality: dataQuality,
    });
  } catch (e) {
    console.error('farming analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

function buildInsights({ rows, labelsMeta, totalRevenueAtRisk, highTopArpuAtRisk, volumeNoRevenue, topGrowth }) {
  const insights = [];
  if (highTopArpuAtRisk.length > 0) {
    insights.push(`${highTopArpuAtRisk.length} outlet High dan Top ARPU mengalami penurunan revenue dan perlu diprioritaskan.`);
  }
  if (volumeNoRevenue.length > 0) {
    const names = volumeNoRevenue.slice(0, 3).map(r => r.id_outlet).join(', ');
    insights.push(`${names}${volumeNoRevenue.length > 3 ? ', dan lainnya' : ''} tetap bertransaksi tetapi menghasilkan revenue Rp0.`);
  }
  if (topGrowth[0] && Number(topGrowth[0].calculated_dev_trx) > 0) {
    const revGrowthPct = topGrowth[0].dev_revenue_pct !== null ? Number(topGrowth[0].dev_revenue_pct) : null;
    const trxGrowthPct = topGrowth[0].dev_trx_pct !== null ? Number(topGrowth[0].dev_trx_pct) : null;
    if (revGrowthPct !== null && trxGrowthPct !== null && revGrowthPct > trxGrowthPct + 0.1) {
      insights.push(`${topGrowth[0].id_outlet} mencatat kenaikan revenue yang jauh lebih tinggi daripada pertumbuhan transaksi.`);
    }
  }
  if (totalRevenueAtRisk > 0) {
    const top10Risk = [...rows].sort((a, b) => {
      const riskA = ['declining', 'critical_decline', 'churned'].includes(a.status) ? Math.max((Number(a.previous_period_revenue) || 0) - (Number(a.current_period_revenue) || 0), 0) : 0;
      const riskB = ['declining', 'critical_decline', 'churned'].includes(b.status) ? Math.max((Number(b.previous_period_revenue) || 0) - (Number(b.current_period_revenue) || 0), 0) : 0;
      return riskB - riskA;
    }).slice(0, 10);
    const top10Sum = top10Risk.reduce((s, r) => {
      const risk = ['declining', 'critical_decline', 'churned'].includes(r.status) ? Math.max((Number(r.previous_period_revenue) || 0) - (Number(r.current_period_revenue) || 0), 0) : 0;
      return s + risk;
    }, 0);
    const pct = totalRevenueAtRisk > 0 ? (top10Sum / totalRevenueAtRisk) * 100 : 0;
    if (pct >= 40) insights.push(`Sebagian besar revenue loss (${pct.toFixed(0)}%) terkonsentrasi pada 10 outlet.`);
  }
  if (!insights.length) insights.push('Belum ada insight signifikan untuk periode ini — data terlihat stabil.');
  return insights.slice(0, 8);
}

function buildDataQualitySummary({ lastSyncLog, rows }) {
  const errorSummary = lastSyncLog?.error_summary || {};
  return {
    last_sync: lastSyncLog?.synced_at || null,
    rows_received: lastSyncLog?.rows_received ?? null,
    rows_valid: lastSyncLog?.rows_valid ?? null,
    rows_skipped: lastSyncLog?.rows_skipped ?? null,
    duplicate_outlet_count: errorSummary.duplicate_count ?? 0,
    missing_id_outlet_count: errorSummary.missing_id_count ?? 0,
    malformed_numeric_count: errorSummary.malformed_numeric_count ?? 0,
    unknown_layer_arpu_count: rows.filter(r => !r.layer_arpu).length,
    dev_trx_mismatch_count: rows.filter(r => r.dev_trx_variance !== null && Number(r.dev_trx_variance) !== 0).length,
    dev_revenue_mismatch_count: rows.filter(r => r.dev_revenue_variance !== null && Number(r.dev_revenue_variance) !== 0).length,
    parse_warnings: errorSummary.warnings || [],
    sync_status: lastSyncLog?.status || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/data-quality?snapshot_date=latest
// ─────────────────────────────────────────────────────────────────────────
async function dataQualityHandler(req, res) {
  try {
    const { snapshotDate } = await resolveSnapshotDate(nullIfEmpty(req.query.snapshot_date));
    if (!snapshotDate) return res.json({ empty: true, message: 'Data Farming belum tersedia.' });

    const [rowsRes, lastSyncRes, historyRes] = await Promise.all([
      pool.query('SELECT layer_arpu, dev_trx_variance, dev_revenue_variance, raw_headers FROM farming_outlet_snapshot WHERE snapshot_date = $1', [snapshotDate]),
      pool.query('SELECT * FROM farming_sync_log WHERE snapshot_date = $1 ORDER BY synced_at DESC LIMIT 1', [snapshotDate]),
      pool.query('SELECT sync_batch_id, synced_at, status, rows_received, rows_valid, rows_skipped, rows_inserted, rows_updated FROM farming_sync_log ORDER BY synced_at DESC LIMIT 20'),
    ]);
    const dq = buildDataQualitySummary({ lastSyncLog: lastSyncRes.rows[0], rows: rowsRes.rows });
    res.json({
      empty: false,
      snapshot_date: snapshotDate,
      ...dq,
      original_headers: lastSyncRes.rows[0]?.original_headers || rowsRes.rows[0]?.raw_headers || [],
      sync_history: historyRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Query builder bersama untuk outlets / action-queue (filter+sort+paginate)
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  current_period_trx: 'current_period_trx', current_period_revenue: 'current_period_revenue',
  calculated_dev_trx: 'calculated_dev_trx', calculated_dev_revenue: 'calculated_dev_revenue',
  priority_score: 'priority_score', current_arpt: 'current_arpt', id_outlet: 'id_outlet',
};

async function queryOutlets(req, { forceOrderByPriority = false } = {}) {
  const { snapshotDate } = await resolveSnapshotDate(nullIfEmpty(req.query.snapshot_date));
  if (!snapshotDate) return { empty: true };

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['s.snapshot_date = $1'];
  const params = [snapshotDate];
  const addFilter = (col, val) => { if (val && val !== 'semua') { params.push(val); conditions.push(`s.${col} = $${params.length}`); } };
  addFilter('priority', nullIfEmpty(req.query.priority));
  addFilter('status', nullIfEmpty(req.query.status));
  addFilter('segment', nullIfEmpty(req.query.segment));
  addFilter('layer_arpu', nullIfEmpty(req.query.layer_arpu));
  const search = nullIfEmpty(req.query.search);
  if (search) { params.push(`%${search}%`); conditions.push(`s.id_outlet ILIKE $${params.length}`); }
  if (nullIfEmpty(req.query.anomaly) === 'volume_no_revenue') {
    conditions.push(`s.current_period_trx > 0 AND s.current_period_revenue = 0`);
  }

  const whereClause = conditions.join(' AND ');
  const sortKey = forceOrderByPriority ? null : (SORT_COLUMNS[req.query.sort] || null);
  const sortDir = String(req.query.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderClause = forceOrderByPriority
    ? `CASE s.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END ASC, s.priority_score DESC`
    : (sortKey ? `s.${sortKey} ${sortDir} NULLS LAST` : `s.current_period_revenue DESC`);

  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM farming_outlet_snapshot s WHERE ${whereClause}`, params);
  const total = Number(countRes.rows[0]?.total || 0);

  params.push(limit, offset);
  const rowsRes = await pool.query(
    `SELECT s.*, f.pic, f.is_contacted, f.followup_status, f.followup_date, f.notes AS followup_notes
     FROM farming_outlet_snapshot s
     LEFT JOIN farming_outlet_followup f ON f.id_outlet = s.id_outlet
     WHERE ${whereClause}
     ORDER BY ${orderClause}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { empty: false, snapshotDate, page, limit, total, rows: rowsRes.rows };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/outlets
// ─────────────────────────────────────────────────────────────────────────
async function outletsHandler(req, res) {
  try {
    const result = await queryOutlets(req);
    if (result.empty) return res.json({ rows: [], total: 0, message: 'Data Farming belum tersedia.' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/action-queue
// ─────────────────────────────────────────────────────────────────────────
async function actionQueueHandler(req, res) {
  try {
    const result = await queryOutlets(req, { forceOrderByPriority: true });
    if (result.empty) return res.json({ rows: [], total: 0, message: 'Data Farming belum tersedia.' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/outlets/:id
// ─────────────────────────────────────────────────────────────────────────
async function outletDetailHandler(req, res) {
  try {
    const idOutlet = nullIfEmpty(req.params.id);
    if (!idOutlet) return res.status(400).json({ error: 'id_outlet wajib diisi' });

    const [historyRes, followupRes] = await Promise.all([
      pool.query('SELECT * FROM farming_outlet_snapshot WHERE id_outlet = $1 ORDER BY snapshot_date ASC', [idOutlet]),
      pool.query('SELECT * FROM farming_outlet_followup WHERE id_outlet = $1', [idOutlet]),
    ]);
    if (!historyRes.rows.length) return res.json({ empty: true, message: 'Outlet tidak ditemukan.' });

    const latest = historyRes.rows[historyRes.rows.length - 1];
    res.json({
      empty: false,
      outlet: {
        id_outlet: idOutlet,
        layer_arpu: latest.layer_arpu,
        status: latest.status,
        priority: latest.priority,
        segment: latest.segment,
        reason_codes: latest.reason_codes,
      },
      latest_snapshot: latest,
      history: historyRes.rows,
      followup: followupRes.rows[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/trendline?days=30
// ─────────────────────────────────────────────────────────────────────────
async function trendlineHandler(req, res) {
  try {
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
    const { rows } = await pool.query(
      `SELECT snapshot_date,
              SUM(current_period_trx) AS total_current_trx,
              SUM(current_period_revenue) AS total_current_revenue,
              SUM(CASE WHEN status IN ('declining','critical_decline','churned')
                       THEN GREATEST(previous_period_revenue - current_period_revenue, 0) ELSE 0 END) AS revenue_at_risk,
              COUNT(*) FILTER (WHERE priority = 'P0') AS p0_count,
              COUNT(*) FILTER (WHERE status IN ('declining','critical_decline')) AS declining_count,
              COUNT(*) FILTER (WHERE current_period_trx > 0 AND current_period_revenue = 0) AS anomaly_count,
              layer_arpu
       FROM farming_outlet_snapshot
       WHERE snapshot_date >= (CURRENT_DATE - $1::int)
       GROUP BY snapshot_date, layer_arpu
       ORDER BY snapshot_date ASC`,
      [days]
    );

    const byDate = new Map();
    const layerByDate = new Map();
    for (const r of rows) {
      const key = String(r.snapshot_date).slice(0, 10);
      if (!byDate.has(key)) {
        byDate.set(key, {
          snapshot_date: key, total_current_trx: 0, total_current_revenue: 0,
          revenue_at_risk: 0, p0_count: 0, declining_count: 0, anomaly_count: 0,
        });
      }
      const agg = byDate.get(key);
      agg.total_current_trx += Number(r.total_current_trx) || 0;
      agg.total_current_revenue += Number(r.total_current_revenue) || 0;
      agg.revenue_at_risk += Number(r.revenue_at_risk) || 0;
      agg.p0_count += Number(r.p0_count) || 0;
      agg.declining_count += Number(r.declining_count) || 0;
      agg.anomaly_count += Number(r.anomaly_count) || 0;

      if (!layerByDate.has(key)) layerByDate.set(key, {});
      layerByDate.get(key)[r.layer_arpu || 'Tidak Diketahui'] = Number(r.total_current_trx) || 0;
    }

    res.json({
      daily: [...byDate.values()],
      layer_breakdown_by_date: Object.fromEntries(layerByDate),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/farming/export?scope=all|action_queue|p0|high_top_arpu_at_risk|volume_no_revenue|growth_opportunity|data_quality_mismatch
// ─────────────────────────────────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportHandler(req, res) {
  try {
    const { snapshotDate } = await resolveSnapshotDate(nullIfEmpty(req.query.snapshot_date));
    if (!snapshotDate) return res.status(400).json({ error: 'Data Farming belum tersedia.' });

    const { rows } = await pool.query('SELECT * FROM farming_outlet_snapshot WHERE snapshot_date = $1', [snapshotDate]);
    if (!rows.length) return res.status(400).json({ error: 'Snapshot kosong.' });

    const scope = nullIfEmpty(req.query.scope) || 'all';
    let filtered = rows;
    if (scope === 'action_queue') filtered = rows.filter(r => r.priority !== 'P3');
    else if (scope === 'p0') filtered = rows.filter(r => r.priority === 'P0');
    else if (scope === 'high_top_arpu_at_risk') filtered = rows.filter(r => ['High ARPU', 'Top ARPU'].includes(r.layer_arpu) && ['declining', 'critical_decline', 'churned'].includes(r.status));
    else if (scope === 'volume_no_revenue') filtered = rows.filter(r => (Number(r.current_period_trx) || 0) > 0 && (Number(r.current_period_revenue) || 0) === 0);
    else if (scope === 'growth_opportunity') filtered = rows.filter(r => ['rocket_growth', 'growing'].includes(r.status));
    else if (scope === 'data_quality_mismatch') filtered = rows.filter(r => (r.dev_trx_variance !== null && Number(r.dev_trx_variance) !== 0) || (r.dev_revenue_variance !== null && Number(r.dev_revenue_variance) !== 0));

    const baselineLabel = `${rows[0].baseline_month_label} Full`;
    const previousLabel = `${rows[0].previous_period_start_day}-${rows[0].previous_period_end_day} ${rows[0].previous_month_label}`;
    const currentLabel = `${rows[0].current_period_start_day}-${rows[0].current_period_end_day} ${rows[0].current_month_label}`;

    const headers = [
      'ID Outlet', 'Layer ARPU',
      `TRX ${baselineLabel}`, `Revenue ${baselineLabel}`,
      `TRX ${previousLabel}`, `Revenue ${previousLabel}`,
      `TRX ${currentLabel}`, `Revenue ${currentLabel}`,
      'Dev TRX', 'Dev Revenue', 'ARPT Previous', 'ARPT Current',
      'Status', 'Priority', 'Segment', 'Recommended Action',
    ];
    const lines = [headers.join(',')];
    for (const r of filtered) {
      lines.push([
        r.id_outlet, r.layer_arpu,
        r.baseline_full_trx, r.baseline_full_revenue,
        r.previous_period_trx, r.previous_period_revenue,
        r.current_period_trx, r.current_period_revenue,
        r.calculated_dev_trx, r.calculated_dev_revenue,
        r.previous_arpt, r.current_arpt,
        r.status, r.priority, r.segment, '',
      ].map(csvEscape).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="farming-${scope}-${snapshotDate}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Follow-up operasional (state mutable, TIDAK terhapus saat sync ulang)
// ─────────────────────────────────────────────────────────────────────────
async function followupGetHandler(req, res) {
  try {
    const idOutlet = nullIfEmpty(req.query.id_outlet);
    if (!idOutlet) return res.status(400).json({ error: 'id_outlet wajib diisi' });
    const { rows } = await pool.query('SELECT * FROM farming_outlet_followup WHERE id_outlet = $1', [idOutlet]);
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const FOLLOWUP_STATUSES = ['OPEN', 'CONTACTED', 'WAITING_RESPONSE', 'ACTION_PLANNED', 'RECOVERED', 'CLOSED'];

async function followupUpsertHandler(req, res) {
  try {
    const body = req.body || {};
    const idOutlet = nullIfEmpty(body.id_outlet);
    if (!idOutlet) return res.status(400).json({ error: 'id_outlet wajib diisi' });
    const followupStatus = FOLLOWUP_STATUSES.includes(body.followup_status) ? body.followup_status : 'OPEN';
    const updatedBy = req.user?.username || 'system';

    const { rows } = await pool.query(
      `INSERT INTO farming_outlet_followup (id_outlet, pic, is_contacted, contacted_at, followup_status, followup_date, notes, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (id_outlet) DO UPDATE SET
         pic = EXCLUDED.pic, is_contacted = EXCLUDED.is_contacted,
         contacted_at = COALESCE(EXCLUDED.contacted_at, farming_outlet_followup.contacted_at),
         followup_status = EXCLUDED.followup_status, followup_date = EXCLUDED.followup_date,
         notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`,
      [
        idOutlet, nullIfEmpty(body.pic), !!body.is_contacted,
        body.is_contacted ? new Date() : null,
        followupStatus, nullIfEmpty(body.followup_date), nullIfEmpty(body.notes), updatedBy,
      ]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  snapshotsHandler,
  actionQueueHandler,
  outletsHandler,
  outletDetailHandler,
  trendlineHandler,
  dataQualityHandler,
  exportHandler,
  followupGetHandler,
  followupUpsertHandler,
  _internal: { extractToken, resolveSnapshotDate },
};
