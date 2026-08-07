'use strict';

const crypto = require('crypto');
const pool   = require('../db');
const {
  safeNumber, safeBoolean, safePct, dedupeLastWins, parsePeriod,
  previousPeriod, compareCutoffDate, maskPhone, buildCanonicalOutletIndex,
  buildPeriodAnalytics,
} = require('../lib/mgm-utils');

// Env-only — TIDAK ADA fallback literal (endpoint ini belum pernah live di
// production, jadi tidak butuh kompatibilitas zero-downtime seperti Part 2A
// di domain lain). MGM_PA_SYNC_TOKEN dipertahankan sebagai alias sementara
// karena itu yang sudah ter-set di server; MGM_SYNC_TOKEN adalah nama baru.
const MGM_SYNC_TOKEN =
  process.env.MGM_SYNC_TOKEN ||
  process.env.MGM_PA_SYNC_TOKEN;

if (!MGM_SYNC_TOKEN) {
  throw new Error(
    'MGM_SYNC_TOKEN or MGM_PA_SYNC_TOKEN must be configured'
  );
}

function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

function normStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

const MAX_ROWS = 100000;

// ─────────────────────────────────────────────────────────────────
// SYNC (token auth, no JWT) — terima payload v2 (periode/source_sheet/
// cutoff_date/aktivasi_detail) DAN payload lama (bulan YYYY-MM saja,
// tanpa detail) supaya Apps Script lama tidak langsung putus.
// ─────────────────────────────────────────────────────────────────

function resolvePeriod(body) {
  if (body.periode) return parsePeriod(body.periode);
  if (body.bulan && /^\d{4}-\d{2}$/.test(body.bulan)) return parsePeriod(body.bulan);
  return null;
}

function normalizeRegRow(r) {
  return {
    id_outlet: normStr(r.id_outlet),
    upline: normStr(r.upline),
    nama_pemilik: normStr(r.nama_pemilik),
    notelp_pemilik: normStr(r.notelp_pemilik),
    tipe_outlet: normStr(r.tipe_outlet),
    balance: safeNumber(r.balance),
    is_active: safeBoolean(r.is_active),
    nama_kota: normStr(r.nama_kota),
    nama_propinsi: normStr(r.nama_propinsi),
    tanggal_registrasi: normStr(r.tanggal_registrasi),
    tanggal_aktifasi: normStr(r.tanggal_aktifasi),
    phone_precision_risk: !!r.phone_precision_risk,
  };
}

function normalizeAktRow(r) {
  return {
    id_outlet: normStr(r.id_outlet),
    upline: normStr(r.upline),
    nama_pemilik: normStr(r.nama_pemilik),
    notelp_pemilik: normStr(r.notelp_pemilik),
    tipe_outlet: normStr(r.tipe_outlet),
    balance: safeNumber(r.balance),
    is_active: safeBoolean(r.is_active),
    nama_kota: normStr(r.nama_kota),
    nama_propinsi: normStr(r.nama_propinsi),
    tanggal_aktifasi: normStr(r.tanggal_aktifasi),
    trx: safeNumber(r.trx),
    rev: safeNumber(r.rev),
    phone_precision_risk: !!r.phone_precision_risk,
  };
}

function normalizeDetailRow(d) {
  return {
    id_aktifasi: normStr(d.id_aktifasi),
    id_outlet: normStr(d.id_outlet),
    nama_group: normStr(d.nama_group),
    nama_pemilik: normStr(d.nama_pemilik),
    is_active: safeBoolean(d.is_active),
    upline: normStr(d.upline),
    pembayaran_via: normStr(d.pembayaran_via),
    biaya_aktifasi: safeNumber(d.biaya_aktifasi),
    tipe_outlet: normStr(d.tipe_outlet),
    id_tipe_outlet: normStr(d.id_tipe_outlet),
    biaya_aktifasi_2: safeNumber(d.biaya_aktifasi_2 ?? d['biaya_aktifasi-2']),
    hpp: safeNumber(d.hpp),
    ongkos_kirim: safeNumber(d.ongkos_kirim),
    fee_upline: safeNumber(d.fee_upline),
    komisi_aktifasi: safeNumber(d.komisi_aktifasi),
  };
}

async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (!safeTokenEqual(token, MGM_SYNC_TOKEN)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const periode = resolvePeriod(body);
  if (!periode) return res.status(400).json({ error: 'periode (YYYY-MM-01) atau bulan (YYYY-MM) wajib diisi' });

  const sourceSheet = normStr(body.source_sheet) || normStr(body.bulan) || periode;
  const cutoffDate  = normStr(body.cutoff_date);

  const registrasiIn = Array.isArray(body.registrasi) ? body.registrasi : [];
  const aktivasiIn   = Array.isArray(body.aktivasi)   ? body.aktivasi   : [];
  const detailRaw     = body.aktivasi_detail ?? body.mgm_aktiv ?? body.detail;
  const detailProvided = Array.isArray(detailRaw);
  const detailIn = detailProvided ? detailRaw : [];

  if (registrasiIn.length > MAX_ROWS || aktivasiIn.length > MAX_ROWS || detailIn.length > MAX_ROWS) {
    return res.status(400).json({ error: `Maksimum ${MAX_ROWS} record per array` });
  }

  const regNormAll = registrasiIn.map(normalizeRegRow).filter(r => r.id_outlet);
  const aktNormAll = aktivasiIn.map(normalizeAktRow).filter(r => r.id_outlet);
  const detNormAll = detailIn.map(normalizeDetailRow).filter(d => d.id_aktifasi);

  const { rows: regRows, duplicateCount: regDup } = dedupeLastWins(regNormAll, r => r.id_outlet);
  const { rows: aktRows, duplicateCount: aktDup } = dedupeLastWins(aktNormAll, r => r.id_outlet);
  const { rows: detRows, duplicateCount: detDup } = dedupeLastWins(detNormAll, d => d.id_aktifasi);

  const quality = {
    registrasi_source_rows: registrasiIn.length,
    registrasi_valid_rows: regRows.length,
    registrasi_blank_id: registrasiIn.length - regNormAll.length,
    registrasi_duplicate_id: regDup,
    aktivasi_source_rows: aktivasiIn.length,
    aktivasi_valid_rows: aktRows.length,
    aktivasi_blank_id: aktivasiIn.length - aktNormAll.length,
    aktivasi_duplicate_id: aktDup,
    detail_provided: detailProvided,
    detail_source_rows: detailIn.length,
    detail_valid_rows: detRows.length,
    detail_blank_id: detailIn.length - detNormAll.length,
    detail_duplicate_id: detDup,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM mgm_pa_registrasi WHERE periode = $1', [periode]);
    if (regRows.length) {
      await client.query(`
        INSERT INTO mgm_pa_registrasi
          (periode, id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance,
           is_active, nama_kota, nama_propinsi, tanggal_registrasi, tanggal_aktifasi,
           source_sheet, phone_precision_risk, synced_at)
        SELECT $1, x.id_outlet, x.upline, x.nama_pemilik, x.notelp_pemilik, x.tipe_outlet, x.balance,
               x.is_active, x.nama_kota, x.nama_propinsi,
               NULLIF(x.tanggal_registrasi,'')::date, NULLIF(x.tanggal_aktifasi,'')::date,
               $2, x.phone_precision_risk, NOW()
        FROM jsonb_to_recordset($3::jsonb) AS x(
          id_outlet text, upline text, nama_pemilik text, notelp_pemilik text, tipe_outlet text,
          balance numeric, is_active boolean, nama_kota text, nama_propinsi text,
          tanggal_registrasi text, tanggal_aktifasi text, phone_precision_risk boolean
        )
      `, [periode, sourceSheet, JSON.stringify(regRows)]);
    }

    await client.query('DELETE FROM mgm_pa_aktivasi WHERE periode = $1', [periode]);
    if (aktRows.length) {
      await client.query(`
        INSERT INTO mgm_pa_aktivasi
          (periode, id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance,
           is_active, nama_kota, nama_propinsi, tanggal_aktifasi, trx, rev,
           source_sheet, phone_precision_risk, synced_at)
        SELECT $1, x.id_outlet, x.upline, x.nama_pemilik, x.notelp_pemilik, x.tipe_outlet, x.balance,
               x.is_active, x.nama_kota, x.nama_propinsi, NULLIF(x.tanggal_aktifasi,'')::date,
               x.trx, x.rev, $2, x.phone_precision_risk, NOW()
        FROM jsonb_to_recordset($3::jsonb) AS x(
          id_outlet text, upline text, nama_pemilik text, notelp_pemilik text, tipe_outlet text,
          balance numeric, is_active boolean, nama_kota text, nama_propinsi text,
          tanggal_aktifasi text, trx bigint, rev numeric, phone_precision_risk boolean
        )
      `, [periode, sourceSheet, JSON.stringify(aktRows)]);
    }

    // Detail HANYA diganti kalau field-nya benar-benar ada di payload —
    // payload lama tanpa aktivasi_detail/mgm_aktiv/detail TIDAK menghapus
    // data detail periode yang sudah tersimpan dari sync sebelumnya.
    if (detailProvided) {
      await client.query('DELETE FROM mgm_pa_aktivasi_detail WHERE periode = $1', [periode]);
      if (detRows.length) {
        await client.query(`
          INSERT INTO mgm_pa_aktivasi_detail
            (periode, id_aktifasi, id_outlet, nama_group, nama_pemilik, is_active, upline,
             pembayaran_via, biaya_aktifasi, tipe_outlet, id_tipe_outlet, biaya_aktifasi_2,
             hpp, ongkos_kirim, fee_upline, komisi_aktifasi, source_sheet, synced_at)
          SELECT $1, x.id_aktifasi, x.id_outlet, x.nama_group, x.nama_pemilik, x.is_active, x.upline,
                 x.pembayaran_via, x.biaya_aktifasi, x.tipe_outlet, x.id_tipe_outlet, x.biaya_aktifasi_2,
                 x.hpp, x.ongkos_kirim, x.fee_upline, x.komisi_aktifasi, $2, NOW()
          FROM jsonb_to_recordset($3::jsonb) AS x(
            id_aktifasi text, id_outlet text, nama_group text, nama_pemilik text, is_active boolean,
            upline text, pembayaran_via text, biaya_aktifasi numeric, tipe_outlet text, id_tipe_outlet text,
            biaya_aktifasi_2 numeric, hpp numeric, ongkos_kirim numeric, fee_upline numeric, komisi_aktifasi numeric
          )
        `, [periode, sourceSheet, JSON.stringify(detRows)]);
      }
    }

    await client.query(`
      INSERT INTO mgm_pa_sync_runs
        (periode, source_sheet, cutoff_date, registrasi_count, aktivasi_count,
         aktivasi_detail_count, quality, status, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'success',NOW())
    `, [periode, sourceSheet, cutoffDate, regRows.length, aktRows.length, detRows.length, JSON.stringify(quality)]);

    await client.query('COMMIT');

    const warnings = [];
    if (!detailProvided) warnings.push('activation_detail_missing');

    res.json({
      ok: true,
      periode,
      source_sheet: sourceSheet,
      cutoff_date: cutoffDate,
      registrasi: regRows.length,
      aktivasi: aktRows.length,
      aktivasi_detail: detRows.length,
      quality,
      warnings,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Jangan log body penuh (PII: nama, no telp) — cukup pesan error & periode.
    console.error('[mgm-pa sync] periode=%s error=%s', periode, e.message);
    try {
      await pool.query(`
        INSERT INTO mgm_pa_sync_runs (periode, source_sheet, status, error_message, synced_at)
        VALUES ($1,$2,'failed',$3,NOW())
      `, [periode, sourceSheet, e.message]);
    } catch { /* best-effort logging, jangan gagalkan response error asli */ }
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────
// ANALYTICS (JWT)
// ─────────────────────────────────────────────────────────────────

function applyFilters(dataset, filters) {
  let { registrasi, aktivasi, detail } = dataset;
  const { pb, provinsi, kota, tipe_outlet, pembayaran_via } = filters;

  if (pembayaran_via) {
    const allowed = new Set(detail.filter(d => d.pembayaran_via === pembayaran_via).map(d => d.id_outlet));
    registrasi = registrasi.filter(r => allowed.has(r.id_outlet));
    aktivasi   = aktivasi.filter(a => allowed.has(a.id_outlet));
    detail     = detail.filter(d => d.pembayaran_via === pembayaran_via);
  }
  if (pb) {
    registrasi = registrasi.filter(r => r.upline === pb);
    aktivasi   = aktivasi.filter(a => a.upline === pb);
    detail     = detail.filter(d => d.upline === pb);
  }
  if (provinsi) {
    registrasi = registrasi.filter(r => r.nama_propinsi === provinsi);
    aktivasi   = aktivasi.filter(a => a.nama_propinsi === provinsi);
  }
  if (kota) {
    registrasi = registrasi.filter(r => r.nama_kota === kota);
    aktivasi   = aktivasi.filter(a => a.nama_kota === kota);
  }
  if (tipe_outlet) {
    registrasi = registrasi.filter(r => r.tipe_outlet === tipe_outlet);
    aktivasi   = aktivasi.filter(a => a.tipe_outlet === tipe_outlet);
    detail     = detail.filter(d => d.tipe_outlet === tipe_outlet);
  }
  return { registrasi, aktivasi, detail };
}

async function loadPeriodDataset(periode, cutoff) {
  const [regRes, aktRes, detRes] = await Promise.all([
    pool.query(`
      SELECT id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance, is_active,
             nama_kota, nama_propinsi, tanggal_registrasi::text, tanggal_aktifasi::text
      FROM mgm_pa_registrasi
      WHERE periode = $1 AND ($2::date IS NULL OR tanggal_registrasi IS NULL OR tanggal_registrasi <= $2)
    `, [periode, cutoff]),
    pool.query(`
      SELECT id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance, is_active,
             nama_kota, nama_propinsi, tanggal_aktifasi::text, trx, rev
      FROM mgm_pa_aktivasi
      WHERE periode = $1 AND ($2::date IS NULL OR tanggal_aktifasi IS NULL OR tanggal_aktifasi <= $2)
    `, [periode, cutoff]),
    pool.query(`
      SELECT id_aktifasi, id_outlet, nama_group, nama_pemilik, is_active, upline, pembayaran_via,
             biaya_aktifasi, tipe_outlet, id_tipe_outlet, biaya_aktifasi_2, hpp, ongkos_kirim,
             fee_upline, komisi_aktifasi
      FROM mgm_pa_aktivasi_detail
      WHERE periode = $1
    `, [periode]),
  ]);
  return { registrasi: regRes.rows, aktivasi: aktRes.rows, detail: detRes.rows };
}

// Untuk previous-period same-day compare: detail dibatasi ke outlet yang
// aktivasinya sendiri sudah <= compareCutoff (detail tidak punya tanggal).
async function loadPreviousDataset(periode, cutoff) {
  const [regRes, aktRes, detRes] = await Promise.all([
    pool.query(`
      SELECT id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance, is_active,
             nama_kota, nama_propinsi, tanggal_registrasi::text, tanggal_aktifasi::text
      FROM mgm_pa_registrasi
      WHERE periode = $1 AND ($2::date IS NULL OR tanggal_registrasi IS NULL OR tanggal_registrasi <= $2)
    `, [periode, cutoff]),
    pool.query(`
      SELECT id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance, is_active,
             nama_kota, nama_propinsi, tanggal_aktifasi::text, trx, rev
      FROM mgm_pa_aktivasi
      WHERE periode = $1 AND ($2::date IS NULL OR tanggal_aktifasi IS NULL OR tanggal_aktifasi <= $2)
    `, [periode, cutoff]),
    pool.query(`
      SELECT d.id_aktifasi, d.id_outlet, d.nama_group, d.nama_pemilik, d.is_active, d.upline,
             d.pembayaran_via, d.biaya_aktifasi, d.tipe_outlet, d.id_tipe_outlet, d.biaya_aktifasi_2,
             d.hpp, d.ongkos_kirim, d.fee_upline, d.komisi_aktifasi
      FROM mgm_pa_aktivasi_detail d
      JOIN mgm_pa_aktivasi a ON a.periode = $1 AND a.id_outlet = d.id_outlet
        AND ($2::date IS NULL OR a.tanggal_aktifasi IS NULL OR a.tanggal_aktifasi <= $2)
      WHERE d.periode = $1
    `, [periode, cutoff]),
  ]);
  return { registrasi: regRes.rows, aktivasi: aktRes.rows, detail: detRes.rows };
}

async function resolveCutoffDate(periode) {
  const runRes = await pool.query(`
    SELECT cutoff_date FROM mgm_pa_sync_runs
    WHERE periode = $1 AND status = 'success' AND cutoff_date IS NOT NULL
    ORDER BY synced_at DESC LIMIT 1
  `, [periode]);
  if (runRes.rows[0]?.cutoff_date) return runRes.rows[0].cutoff_date.toISOString().slice(0, 10);

  const maxRes = await pool.query(`
    SELECT GREATEST(
      COALESCE((SELECT MAX(tanggal_registrasi) FROM mgm_pa_registrasi WHERE periode=$1), '1970-01-01'),
      COALESCE((SELECT MAX(tanggal_aktifasi) FROM mgm_pa_aktivasi WHERE periode=$1), '1970-01-01')
    ) AS cutoff
  `, [periode]);
  const cutoff = maxRes.rows[0]?.cutoff;
  return cutoff && cutoff.toISOString().slice(0, 10) !== '1970-01-01' ? cutoff.toISOString().slice(0, 10) : null;
}

async function analyticsHandler(req, res) {
  try {
    const availRes = await pool.query(`
      SELECT DISTINCT periode::text FROM mgm_pa_registrasi
      UNION SELECT DISTINCT periode::text FROM mgm_pa_aktivasi
      ORDER BY 1 DESC
    `);
    const availablePeriods = availRes.rows.map(r => r.periode);

    const requestedPeriod = parsePeriod(req.query.periode) || availablePeriods[0];
    if (!requestedPeriod) {
      return res.json({
        meta: { available_periods: [], selected_period: null, target_available: false },
        summary: null,
      });
    }

    const cutoffDate = await resolveCutoffDate(requestedPeriod);
    const comparePeriod = previousPeriod(requestedPeriod);
    const compareCutoff = cutoffDate ? compareCutoffDate(requestedPeriod, cutoffDate) : null;

    // Current period TIDAK dipotong oleh cutoff_date — cutoff_date hanya
    // menjelaskan tanggal terakhir data source (meta), bukan filter data
    // periode berjalan. Lihat §6 spesifikasi bisnis MGM PA. Previous period
    // TETAP dibandingkan same-day (compareCutoff) supaya delta adil.
    const [currentRaw, previousRaw] = await Promise.all([
      loadPeriodDataset(requestedPeriod, null),
      comparePeriod ? loadPreviousDataset(comparePeriod, compareCutoff) : Promise.resolve({ registrasi: [], aktivasi: [], detail: [] }),
    ]);

    const filters = {
      pb: normStr(req.query.pb),
      provinsi: normStr(req.query.provinsi),
      kota: normStr(req.query.kota),
      tipe_outlet: normStr(req.query.tipe_outlet),
      pembayaran_via: normStr(req.query.pembayaran_via),
    };
    const current = applyFilters(currentRaw, filters);
    const previous = applyFilters(previousRaw, filters);

    const analytics = buildPeriodAnalytics({
      registrasi: current.registrasi, aktivasi: current.aktivasi, detail: current.detail,
      previousRegistrasi: previous.registrasi, previousAktivasi: previous.aktivasi, previousDetail: previous.detail,
    }, { cutoffDate, compareCutoffDateStr: compareCutoff, currentPeriod: requestedPeriod });

    // daily_acquisition — HANYA registrasi & aktivasi harian, TIDAK ADA revenue/trx harian
    // (Trx/Rev adalah agregat periode per outlet, bukan transaksi harian — lihat larangan §15).
    const dailyMap = new Map();
    function bump(dateStr, field) {
      if (!dateStr) return;
      const d = String(dateStr).slice(0, 10);
      if (!dailyMap.has(d)) dailyMap.set(d, { date: d, registrations: 0, paid_conversions: 0, activated_outlets: 0 });
      dailyMap.get(d)[field]++;
    }
    current.registrasi.forEach(r => bump(r.tanggal_registrasi, 'registrations'));
    current.aktivasi.forEach(a => bump(a.tanggal_aktifasi, 'activated_outlets'));
    const aktDateByOutlet = new Map(current.aktivasi.map(a => [a.id_outlet, a.tanggal_aktifasi]));
    current.detail.forEach(d => { if (d.id_outlet && aktDateByOutlet.has(d.id_outlet)) bump(aktDateByOutlet.get(d.id_outlet), 'paid_conversions'); });
    const daily_acquisition = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // monthly_trend — agregat per periode langsung dari SQL (semua bulan
    // tersedia, TIDAK dipotong cutoff — sama seperti current period).
    // Sudah Aktif/Belum Aktif per periode dihitung via JOIN ke AKTIVASI
    // (is_active=true) — SAMA seperti computeActiveOutletMatch, BUKAN
    // REG.is_active (definisi lama TERBUKTI SALAH, lihat catatan modul
    // mgm-utils.js). NMAT per periode juga dihitung via JOIN tanggal
    // aktifasi ke periode itu sendiri + trx>0, konsisten dgn computeNmatDetails.
    const trendRes = await pool.query(`
      WITH reg AS (
        SELECT periode,
          COUNT(DISTINCT id_outlet) AS registrations,
          COUNT(DISTINCT upline) FILTER (WHERE upline IS NOT NULL AND TRIM(upline) <> '') AS active_recruiting_pb,
          MAX(tanggal_registrasi) AS reg_cutoff
        FROM mgm_pa_registrasi GROUP BY periode
      ), active_match AS (
        SELECT r.periode, COUNT(DISTINCT r.id_outlet) AS active_outlets
        FROM mgm_pa_registrasi r
        JOIN mgm_pa_aktivasi a
          ON a.periode = r.periode AND a.id_outlet = r.id_outlet AND a.is_active = true
        GROUP BY r.periode
      ), akt AS (
        SELECT periode, COUNT(DISTINCT id_outlet) AS activated_outlets,
          COUNT(DISTINCT id_outlet) FILTER (WHERE trx>0) AS transacting_outlets,
          COALESCE(SUM(trx),0) AS total_trx, COALESCE(SUM(rev),0) AS transaction_revenue,
          MAX(tanggal_aktifasi) AS akt_cutoff
        FROM mgm_pa_aktivasi GROUP BY periode
      ), nmat AS (
        SELECT periode,
          COUNT(DISTINCT id_outlet) AS nmat_outlets,
          COALESCE(SUM(trx),0) AS nmat_trx
        FROM mgm_pa_aktivasi
        WHERE trx > 0
          AND tanggal_aktifasi >= periode
          AND tanggal_aktifasi < (periode + INTERVAL '1 month')
        GROUP BY periode
      ), det AS (
        SELECT periode, COUNT(DISTINCT id_aktifasi) AS paid_activation_events,
          COALESCE(SUM(fee_upline),0) AS fee_upline, COALESCE(SUM(komisi_aktifasi),0) AS activation_revenue,
          COUNT(*) FILTER (WHERE komisi_aktifasi<0) AS negative_activation_count
        FROM mgm_pa_aktivasi_detail GROUP BY periode
      )
      SELECT periods.periode::text,
        COALESCE(reg.registrations,0)::int AS registrations,
        COALESCE(active_match.active_outlets,0)::int AS active_outlets,
        (COALESCE(reg.registrations,0) - COALESCE(active_match.active_outlets,0))::int AS inactive_outlets,
        COALESCE(reg.active_recruiting_pb,0)::int AS active_recruiting_pb,
        COALESCE(nmat.nmat_outlets,0)::int AS nmat_outlets,
        COALESCE(nmat.nmat_trx,0)::bigint AS nmat_trx,
        COALESCE(det.paid_activation_events,0)::int AS paid_activation_events,
        COALESCE(akt.activated_outlets,0)::int AS activated_outlets,
        COALESCE(akt.transacting_outlets,0)::int AS transacting_outlets,
        COALESCE(akt.total_trx,0)::bigint AS total_trx,
        COALESCE(akt.transaction_revenue,0) AS transaction_revenue,
        COALESCE(det.fee_upline,0) AS fee_upline,
        COALESCE(det.activation_revenue,0) AS activation_revenue,
        COALESCE(det.negative_activation_count,0)::int AS negative_activation_count,
        GREATEST(reg.reg_cutoff, akt.akt_cutoff)::text AS cutoff_day_date
      FROM (SELECT DISTINCT periode FROM mgm_pa_registrasi UNION SELECT DISTINCT periode FROM mgm_pa_aktivasi) periods
      LEFT JOIN reg          ON reg.periode = periods.periode
      LEFT JOIN active_match ON active_match.periode = periods.periode
      LEFT JOIN akt          ON akt.periode = periods.periode
      LEFT JOIN nmat         ON nmat.periode = periods.periode
      LEFT JOIN det          ON det.periode = periods.periode
      ORDER BY periods.periode ASC
    `);
    const monthly_trend = trendRes.rows.map(r => ({
      ...r,
      mgm_revenue: Number(r.transaction_revenue) + Number(r.activation_revenue),
      activation_conversion_pct: safePct(r.active_outlets, r.registrations),
      avg_registration_per_pb: r.active_recruiting_pb > 0 ? r.registrations / r.active_recruiting_pb : null,
      cutoff_day: r.cutoff_day_date ? Number(r.cutoff_day_date.slice(8, 10)) : null,
    }));

    const targetRes = await pool.query('SELECT 1 FROM mgm_pa_pb_targets LIMIT 1');

    res.json({
      meta: {
        available_periods: availablePeriods,
        selected_period: requestedPeriod,
        selected_label: null,
        compare_period: comparePeriod,
        compare_label: null,
        cutoff_date: cutoffDate,
        compare_cutoff_date: compareCutoff,
        comparison_mode: 'previous_same_day',
        last_sync: null,
        target_available: targetRes.rows.length > 0,
        filters,
        quality: analytics.quality,
      },
      summary: analytics.summary,
      cohort_funnel: analytics.cohort_funnel,
      operational_volume: analytics.operational_volume,
      daily_acquisition,
      monthly_trend,
      pb_scorecard: analytics.pb_scorecard,
      pb_matrix: analytics.pb_matrix,
      economics: analytics.economics,
      territories: analytics.territories,
      outlet_types: analytics.outlet_types,
      payment_mix: analytics.payment_mix,
      concentration: analytics.concentration,
      derived_queues: analytics.derived_queues,
    });
  } catch (e) {
    console.error('[mgm-pa analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// OUTLETS (JWT) — satu row per outlet, lifecycle stage, server-side
// pagination, phone masked kecuali admin + include_phone=1.
// ─────────────────────────────────────────────────────────────────

function computeStage(entry) {
  const hasDetail = entry.detail_ids.length > 0;
  if (entry.in_akt) return safeNumber(entry.trx) > 0 ? 'transacting' : 'active_no_trx';
  if (hasDetail) return 'paid_not_active';
  if (entry.in_reg) return 'registered_not_paid';
  return 'data_review';
}

async function outletsHandler(req, res) {
  try {
    const periode = parsePeriod(req.query.periode);
    if (!periode) return res.status(400).json({ error: 'periode wajib diisi (YYYY-MM-01 atau YYYY-MM)' });

    const dataset = await loadPeriodDataset(periode, null);
    const negativeOutlets = new Set(dataset.detail.filter(d => safeNumber(d.komisi_aktifasi) < 0).map(d => d.id_outlet));
    const idx = buildCanonicalOutletIndex(dataset.registrasi, dataset.aktivasi, dataset.detail);

    let rows = [...idx.values()].map(e => ({
      id_outlet: e.id_outlet,
      upline: e.upline,
      nama_pemilik: e.nama_pemilik,
      notelp_pemilik: e.notelp_pemilik,
      nama_kota: e.nama_kota,
      nama_propinsi: e.nama_propinsi,
      tipe_outlet: e.tipe_outlet,
      tanggal_registrasi: e.tanggal_registrasi,
      tanggal_aktifasi: e.tanggal_aktifasi,
      trx: e.trx,
      rev: e.rev,
      payment_methods: e.payment_methods,
      stage: computeStage(e),
      has_negative_economics: negativeOutlets.has(e.id_outlet),
      upline_mismatch: e.upline_mismatch_reg_akt || e.upline_mismatch_reg_detail || e.upline_mismatch_akt_detail,
    }));

    const { stage, pb, provinsi, tipe_outlet, pembayaran_via, search } = req.query;
    if (stage === 'negative_economics') rows = rows.filter(r => r.has_negative_economics);
    else if (stage) rows = rows.filter(r => r.stage === stage);
    if (pb) rows = rows.filter(r => r.upline === pb);
    if (provinsi) rows = rows.filter(r => r.nama_propinsi === provinsi);
    if (tipe_outlet) rows = rows.filter(r => r.tipe_outlet === tipe_outlet);
    if (pembayaran_via) rows = rows.filter(r => r.payment_methods.includes(pembayaran_via));
    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter(r =>
        (r.id_outlet || '').toLowerCase().includes(q) ||
        (r.upline || '').toLowerCase().includes(q) ||
        (r.nama_pemilik || '').toLowerCase().includes(q) ||
        (r.nama_kota || '').toLowerCase().includes(q) ||
        (r.nama_propinsi || '').toLowerCase().includes(q)
      );
    }

    const sortField = ['trx', 'rev', 'tanggal_registrasi', 'tanggal_aktifasi', 'id_outlet'].includes(req.query.sort)
      ? req.query.sort : 'trx';
    const order = req.query.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[sortField], vb = b[sortField];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return va > vb ? order : -order;
    });

    const total = rows.length;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const paged = rows.slice((page - 1) * limit, page * limit);

    const includePhone = req.query.include_phone === '1' && req.user?.role === 'admin';
    const out = paged.map(r => ({
      ...r,
      notelp_pemilik: includePhone ? r.notelp_pemilik : maskPhone(r.notelp_pemilik),
    }));

    res.json({ periode, total, page, limit, outlets: out });
  } catch (e) {
    console.error('[mgm-pa outlets]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// SEARCH (JWT)
// ─────────────────────────────────────────────────────────────────

async function searchHandler(req, res) {
  const { q = '', periode } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Minimal 2 karakter' });

  try {
    const pattern = `%${q.trim().toUpperCase()}%`;
    const periodeVal = parsePeriod(periode);
    const periodeCond = periodeVal ? 'AND periode = $2' : '';
    const params = periodeVal ? [pattern, periodeVal] : [pattern];

    const [regRes, aktRes] = await Promise.all([
      pool.query(`
        SELECT periode::text, upline, id_outlet, nama_pemilik, tipe_outlet, nama_kota, nama_propinsi,
               tanggal_registrasi::text, tanggal_aktifasi::text, is_active
        FROM mgm_pa_registrasi
        WHERE (UPPER(id_outlet) LIKE $1 OR UPPER(upline) LIKE $1 OR UPPER(nama_pemilik) LIKE $1) ${periodeCond}
        ORDER BY periode DESC LIMIT 500
      `, params),
      pool.query(`
        SELECT periode::text, upline, id_outlet, nama_pemilik, tipe_outlet, nama_kota, nama_propinsi,
               tanggal_aktifasi::text, trx, rev, is_active
        FROM mgm_pa_aktivasi
        WHERE (UPPER(id_outlet) LIKE $1 OR UPPER(upline) LIKE $1 OR UPPER(nama_pemilik) LIKE $1) ${periodeCond}
        ORDER BY periode DESC LIMIT 500
      `, params),
    ]);

    const includePhone = req.query.include_phone === '1' && req.user?.role === 'admin';
    res.json({
      q, periode: periodeVal,
      registrasi: regRes.rows,
      aktivasi: aktRes.rows,
      total_registrasi: regRes.rows.length,
      total_aktivasi: aktRes.rows.length,
      _phone_note: includePhone ? undefined : 'Nomor telepon tidak disertakan pada hasil pencarian.',
    });
  } catch (e) {
    console.error('[mgm-pa search]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// ACTIONS CRUD (JWT)
// ─────────────────────────────────────────────────────────────────

const ACTION_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ACTION_STATUSES   = ['open', 'in_progress', 'resolved', 'dismissed'];

async function actionsHandler(req, res) {
  try {
    const periode = parsePeriod(req.query.periode);
    const conds = [];
    const params = [];
    if (periode) { params.push(periode); conds.push(`periode = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`status = $${params.length}`); }
    if (req.query.priority) { params.push(req.query.priority); conds.push(`priority = $${params.length}`); }
    if (req.query.upline) { params.push(req.query.upline); conds.push(`upline = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM mgm_pa_actions ${where} ORDER BY priority ASC, updated_at DESC LIMIT 500`,
      params
    );
    res.json({ actions: rows });
  } catch (e) {
    console.error('[mgm-pa actions get]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function upsertActionHandler(req, res) {
  try {
    const b = req.body || {};
    const periode = parsePeriod(b.periode);
    const idOutlet = normStr(b.id_outlet);
    const actionType = normStr(b.action_type);
    if (!periode || !idOutlet || !actionType) {
      return res.status(400).json({ error: 'periode, id_outlet, action_type wajib diisi' });
    }
    const priority = ACTION_PRIORITIES.includes(b.priority) ? b.priority : 'P2';
    const status = ACTION_STATUSES.includes(b.status) ? b.status : 'open';
    const createdBy = req.user?.username || null;

    const { rows } = await pool.query(`
      INSERT INTO mgm_pa_actions
        (periode, id_outlet, upline, action_type, priority, status, owner, due_date, next_followup, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (periode, id_outlet, action_type) DO UPDATE SET
        upline = EXCLUDED.upline, priority = EXCLUDED.priority, status = EXCLUDED.status,
        owner = EXCLUDED.owner, due_date = EXCLUDED.due_date, next_followup = EXCLUDED.next_followup,
        notes = EXCLUDED.notes, updated_at = NOW(),
        resolved_at = CASE WHEN EXCLUDED.status = 'resolved' THEN NOW() ELSE mgm_pa_actions.resolved_at END
      RETURNING *
    `, [periode, idOutlet, normStr(b.upline), actionType, priority, status,
        normStr(b.owner), normStr(b.due_date), normStr(b.next_followup), normStr(b.notes), createdBy]);

    res.json({ ok: true, action: rows[0] });
  } catch (e) {
    console.error('[mgm-pa actions upsert]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function updateActionHandler(req, res) {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const sets = [];
    const params = [];
    function set(col, val) { params.push(val); sets.push(`${col} = $${params.length}`); }

    if (b.priority !== undefined) {
      if (!ACTION_PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'priority tidak valid' });
      set('priority', b.priority);
    }
    if (b.status !== undefined) {
      if (!ACTION_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status tidak valid' });
      set('status', b.status);
      if (b.status === 'resolved') { params.push(new Date()); sets.push(`resolved_at = $${params.length}`); }
    }
    if (b.owner !== undefined) set('owner', normStr(b.owner));
    if (b.due_date !== undefined) set('due_date', normStr(b.due_date));
    if (b.next_followup !== undefined) set('next_followup', normStr(b.next_followup));
    if (b.notes !== undefined) set('notes', normStr(b.notes));
    if (!sets.length) return res.status(400).json({ error: 'Tidak ada field untuk diupdate' });

    sets.push('updated_at = NOW()');
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE mgm_pa_actions SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Action tidak ditemukan' });
    res.json({ ok: true, action: rows[0] });
  } catch (e) {
    console.error('[mgm-pa actions update]', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  outletsHandler,
  searchHandler,
  actionsHandler,
  upsertActionHandler,
  updateActionHandler,
  _internal: { applyFilters, computeStage, resolvePeriod, safeTokenEqual },
};
