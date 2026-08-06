'use strict';

/**
 * MGM PA — PB Lifecycle & Productivity Control Tower.
 * Pure functions (tidak menyentuh DB/HTTP) — dipakai oleh
 * backend/src/routes/warroom-mgm.js dan diuji langsung oleh
 * backend/scripts/test-mgm-warroom.js.
 *
 * MODEL BISNIS (jangan diubah tanpa sadar):
 *   - Sumber funnel registrasi/aktif/tidak-aktif/PB Aktif Merekrut:
 *     mgm_pa_registrasi (REG). is_active DI SINI adalah status resmi
 *     aktif/tidak-aktif agen — BUKAN status dari tabel AKTIVASI.
 *   - Sumber Revenue MGM: mgm_pa_aktivasi_detail.komisi_aktifasi (DETAIL).
 *     Nilai komisi_aktifasi dipakai APA ADANYA dari source sheet — TIDAK
 *     PERNAH dihitung ulang dan menimpa nilai sumber.
 *   - mgm_pa_aktivasi (AKTIVASI) tetap dipakai untuk analisis transaksi
 *     (transacting outlets, total trx, revenue transaksi) sebagai
 *     INFORMASI PENDUKUNG SAJA — bukan sumber status aktif funnel.
 *   - upline = ID PB (perekrut). id_outlet = agen/outlet yang direkrut.
 *     Jumlah PB Aktif Merekrut = COUNT DISTINCT REG.upline (non-blank),
 *     BUKAN jumlah id_outlet.
 */

// ─────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'ya', 'aktif', 'active'].includes(s)) return true;
  if (['0', 'false', 'tidak', 'nonaktif', 'inactive'].includes(s)) return false;
  return null; // unknown — jangan ditebak jadi true/false
}

// Persentase dari dua angka. Denominator <= 0 => null (bukan Infinity/NaN).
function safePct(numerator, denominator) {
  const den = safeNumber(denominator);
  if (den <= 0) return null;
  return (safeNumber(numerator) / den) * 100;
}

// Delta persen (current vs previous). previous = 0 => null, bukan Infinity.
function pctDelta(current, previous) {
  if (current === null || current === undefined) return null;
  const prev = safeNumber(previous);
  if (prev === 0) return null;
  return ((safeNumber(current) - prev) / prev) * 100;
}

// Delta dalam percentage point (utk rate yang SUDAH berupa persen), mis.
// 45.1% vs 47.9% => -2.8 pt, BUKAN -5.8% (relative). null jika salah satu null.
function pointDelta(currentRate, previousRate) {
  if (currentRate === null || currentRate === undefined) return null;
  if (previousRate === null || previousRate === undefined) return null;
  return safeNumber(currentRate) - safeNumber(previousRate);
}

function percentile(values, p) {
  const arr = (values || [])
    .map(safeNumber)
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  if (arr.length === 1) return arr[0];
  const idx = (p / 100) * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

function maskPhone(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(Math.max(s.length - 4, 3)) + s.slice(-2);
}

// 'YYYY-MM-01' | 'YYYY-MM' | Date -> 'YYYY-MM-01'. Return null jika tidak valid.
function parsePeriod(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

// Kembalikan periode sebelumnya ('YYYY-MM-01' -> 'YYYY-MM-01' bulan lalu).
function previousPeriod(periodStr) {
  const p = parsePeriod(periodStr);
  if (!p) return null;
  const [y, m] = p.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Hari terakhir bulan tsb ('YYYY-MM-01' -> integer).
function lastDayOfMonth(periodStr) {
  const p = parsePeriod(periodStr);
  if (!p) return 31;
  const [y, m] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Same-day compare: cutoff hari-X pada `period`, dibatasi last-day bulan sebelumnya.
function compareCutoffDate(periodStr, cutoffDateStr) {
  const prevPeriod = previousPeriod(periodStr);
  if (!prevPeriod || !cutoffDateStr) return null;
  const day = Number(String(cutoffDateStr).slice(8, 10)) || 1;
  const clampedDay = Math.min(day, lastDayOfMonth(prevPeriod));
  return `${prevPeriod.slice(0, 8)}${String(clampedDay).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────
// Dedup
// ─────────────────────────────────────────────────────────────────

// Last-occurrence-wins dedup by key. Return { rows, duplicateCount, uniqueCount }.
function dedupeLastWins(rows, keyFn) {
  const map = new Map();
  let duplicateCount = 0;
  for (const row of rows || []) {
    const key = keyFn(row);
    if (key === null || key === undefined || key === '') continue;
    if (map.has(key)) duplicateCount++;
    map.set(key, row);
  }
  return { rows: [...map.values()], duplicateCount, uniqueCount: map.size };
}

// ─────────────────────────────────────────────────────────────────
// Canonical outlet index — join REG + AKTIVASI + DETAIL per id_outlet.
// Dipakai untuk endpoint outlet list (satu row per outlet) & audit upline
// mismatch, BUKAN untuk agregasi KPI utama.
// ─────────────────────────────────────────────────────────────────

function buildCanonicalOutletIndex(regRows, actRows, detailRows) {
  const idx = new Map();
  function ensure(id) {
    if (!idx.has(id)) {
      idx.set(id, {
        id_outlet: id,
        in_reg: false, in_akt: false,
        upline_reg: null, upline_akt: null, upline_detail: null,
        nama_pemilik: null, notelp_pemilik: null,
        nama_kota: null, nama_propinsi: null,
        tipe_outlet_reg: null, tipe_outlet_akt: null, tipe_outlet_detail: null,
        tanggal_registrasi: null, tanggal_aktifasi: null,
        is_active: null,
        trx: 0, rev: 0,
        detail_ids: [], payment_methods: new Set(),
        upline_mismatch_reg_akt: false,
        upline_mismatch_reg_detail: false,
        upline_mismatch_akt_detail: false,
      });
    }
    return idx.get(id);
  }

  for (const r of regRows || []) {
    if (!r.id_outlet) continue;
    const e = ensure(r.id_outlet);
    e.in_reg = true;
    e.upline_reg = r.upline || null;
    e.nama_pemilik = e.nama_pemilik || r.nama_pemilik || null;
    e.notelp_pemilik = e.notelp_pemilik || r.notelp_pemilik || null;
    e.tipe_outlet_reg = r.tipe_outlet || null;
    e.nama_kota = e.nama_kota || r.nama_kota || null;
    e.nama_propinsi = e.nama_propinsi || r.nama_propinsi || null;
    e.tanggal_registrasi = r.tanggal_registrasi || null;
    e.is_active = r.is_active === undefined ? null : r.is_active;
  }

  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    const e = ensure(a.id_outlet);
    e.in_akt = true;
    e.upline_akt = a.upline || null;
    e.nama_pemilik = a.nama_pemilik || e.nama_pemilik || null;
    e.notelp_pemilik = a.notelp_pemilik || e.notelp_pemilik || null;
    e.tipe_outlet_akt = a.tipe_outlet || null;
    e.nama_kota = a.nama_kota || e.nama_kota || null;
    e.nama_propinsi = a.nama_propinsi || e.nama_propinsi || null;
    e.tanggal_aktifasi = a.tanggal_aktifasi || null;
    e.trx = safeNumber(a.trx);
    e.rev = safeNumber(a.rev);
  }

  for (const d of detailRows || []) {
    if (!d.id_outlet) continue;
    const e = ensure(d.id_outlet);
    e.detail_ids.push(d.id_aktifasi);
    e.upline_detail = d.upline || e.upline_detail;
    e.tipe_outlet_detail = d.tipe_outlet || e.tipe_outlet_detail;
    if (d.pembayaran_via) e.payment_methods.add(d.pembayaran_via);
  }

  for (const e of idx.values()) {
    if (e.upline_reg && e.upline_akt && e.upline_reg !== e.upline_akt) e.upline_mismatch_reg_akt = true;
    if (e.upline_reg && e.upline_detail && e.upline_reg !== e.upline_detail) e.upline_mismatch_reg_detail = true;
    if (e.upline_akt && e.upline_detail && e.upline_akt !== e.upline_detail) e.upline_mismatch_akt_detail = true;
    e.payment_methods = [...e.payment_methods];
    e.tipe_outlet = e.tipe_outlet_reg || e.tipe_outlet_akt || e.tipe_outlet_detail || null;
    e.upline = e.upline_reg || e.upline_akt || e.upline_detail || null;
  }

  return idx;
}

// ─────────────────────────────────────────────────────────────────
// Registration funnel — sumber TUNGGAL: mgm_pa_registrasi (REG).
// registrations/active/inactive/unknown SELALU mempartisi id_outlet unik
// (registrations = active + inactive + unknown, dijamin secara struktural
// karena setiap outlet masuk tepat satu bucket).
// ─────────────────────────────────────────────────────────────────

function computeRegistrationFunnel(regRows) {
  const byOutlet = new Map();
  for (const r of regRows || []) {
    if (!r.id_outlet) continue;
    byOutlet.set(r.id_outlet, r); // last-wins kalau ada duplikat id_outlet di array
  }

  let active = 0, inactive = 0, unknown = 0;
  const uplineSet = new Set();
  for (const r of byOutlet.values()) {
    if (r.is_active === true) active++;
    else if (r.is_active === false) inactive++;
    else unknown++;
    const up = r.upline && String(r.upline).trim();
    if (up) uplineSet.add(up);
  }

  const registrations = byOutlet.size;
  const active_recruiting_pb = uplineSet.size;

  return {
    registrations,
    active_registrations: active,
    inactive_registrations: inactive,
    unknown_active_status: unknown,
    activation_conversion_pct: safePct(active, registrations),
    active_recruiting_pb,
    avg_registration_per_pb: active_recruiting_pb > 0 ? registrations / active_recruiting_pb : null,
  };
}

// Revenue MGM — sumber TUNGGAL: mgm_pa_aktivasi_detail.komisi_aktifasi.
// Nilai komisi_aktifasi dipakai apa adanya dari source sheet, TIDAK PERNAH
// dihitung ulang untuk menimpa nilai sumber (lihat formula_mismatch di
// buildPeriodAnalytics untuk audit selisih formula vs nilai sumber).
function computeMgmRevenue(detailRows) {
  const rows = detailRows || [];
  const mgm_revenue = rows.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
  const fee_upline = rows.reduce((s, d) => s + safeNumber(d.fee_upline), 0);
  const paid_activation_events = new Set(rows.map(d => d.id_aktifasi).filter(Boolean)).size;
  const negative_activation_count = rows.filter(d => safeNumber(d.komisi_aktifasi) < 0).length;

  return {
    mgm_revenue,
    fee_upline,
    paid_activation_events,
    negative_activation_count,
    negative_activation_rate: safePct(negative_activation_count, paid_activation_events),
    avg_commission_per_activation: paid_activation_events > 0 ? mgm_revenue / paid_activation_events : null,
  };
}

// Info transaksi — sumber mgm_pa_aktivasi (AKTIVASI), INFORMASI PENDUKUNG
// SAJA. Bukan sumber status aktif/tidak-aktif funnel registrasi.
function computeTransactionInfo(actRows) {
  const byOutlet = new Map();
  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    byOutlet.set(a.id_outlet, a);
  }
  let transacting = 0, total_trx = 0, transaction_revenue = 0;
  for (const a of byOutlet.values()) {
    const trx = safeNumber(a.trx);
    total_trx += trx;
    transaction_revenue += safeNumber(a.rev);
    if (trx > 0) transacting++;
  }
  const activated_outlets = byOutlet.size;
  return {
    activated_outlets,
    transacting_outlets: transacting,
    total_trx,
    transaction_revenue,
    activation_to_transaction_pct: safePct(transacting, activated_outlets),
  };
}

// Gabungan satu periode: funnel registrasi + revenue MGM + info transaksi
// pendukung + irisan "sudah registrasi DAN sudah transaksi" (dipakai funnel
// tahap 3 — lihat §10 spesifikasi bisnis).
function computeSummary(regRows, actRows, detailRows) {
  const funnel = computeRegistrationFunnel(regRows);
  const revenue = computeMgmRevenue(detailRows);
  const txn = computeTransactionInfo(actRows);

  const regOutletSet = new Set((regRows || []).map(r => r.id_outlet).filter(Boolean));
  const transactingOutletIds = new Set(
    (actRows || []).filter(a => safeNumber(a.trx) > 0).map(a => a.id_outlet).filter(Boolean)
  );
  const registered_and_transacting = [...regOutletSet].filter(id => transactingOutletIds.has(id)).length;

  return {
    ...funnel,
    ...revenue,
    ...txn,
    registered_and_transacting,
    registered_to_transacting_pct: safePct(registered_and_transacting, funnel.registrations),
  };
}

function summaryDeltas(current, previous) {
  const rateKeys = new Set([
    'activation_conversion_pct', 'activation_to_transaction_pct',
    'negative_activation_rate', 'registered_to_transacting_pct',
  ]);
  const deltas = {};
  for (const key of Object.keys(current)) {
    if (rateKeys.has(key)) deltas[key] = pointDelta(current[key], previous[key]);
    else deltas[key] = pctDelta(current[key], previous[key]);
  }
  return deltas;
}

// ─────────────────────────────────────────────────────────────────
// PB segmentation — cascade rule berbasis distribusi (P50/P75) aktual dari
// registrations, activation_conversion_pct, inactive_registrations.
// BUKAN target bisnis yang belum ada.
// ─────────────────────────────────────────────────────────────────

function computeSegmentationThresholds(pbRows) {
  const nn = arr => arr.filter(v => v !== null && v !== undefined);
  return {
    registrations_p50: percentile(pbRows.map(r => r.registrations), 50),
    conversion_p50: percentile(nn(pbRows.map(r => r.activation_conversion_pct)), 50),
    conversion_p75: percentile(nn(pbRows.map(r => r.activation_conversion_pct)), 75),
    inactive_p75: percentile(pbRows.map(r => r.inactive_registrations), 75),
  };
}

function classifyPb(row, thresholds) {
  const gte = (v, t) => v !== null && v !== undefined && v >= t;
  const reg = safeNumber(row.registrations);
  const conv = row.activation_conversion_pct;

  if (reg >= thresholds.registrations_p50 && gte(conv, thresholds.conversion_p50)) {
    return 'Growth Engine';
  }
  if (reg < thresholds.registrations_p50 && gte(conv, thresholds.conversion_p75)) {
    return 'Closer';
  }
  if (reg >= thresholds.registrations_p50 && !gte(conv, thresholds.conversion_p50)) {
    return 'Hunter Only';
  }
  if (safeNumber(row.inactive_registrations) >= thresholds.inactive_p75) {
    return 'High Backlog';
  }
  return 'Low Activity';
}

// ─────────────────────────────────────────────────────────────────
// PB scorecard — satu row per upline yang muncul di mgm_pa_registrasi
// (roster PB ditentukan oleh REG.upline — itulah definisi "PB Aktif
// Merekrut"). Revenue MGM per PB diatribusikan lewat DETAIL.upline.
// ─────────────────────────────────────────────────────────────────

function buildPbScorecard(regRows, actRows, detailRows, prevRegRows, prevActRows, prevDetailRows) {
  const reg = regRows || [];
  const det = detailRows || [];
  const prevReg = prevRegRows || [];
  const prevDet = prevDetailRows || [];

  const uplineSet = new Set();
  reg.forEach(r => { const u = r.upline && String(r.upline).trim(); if (u) uplineSet.add(u); });

  const totalFunnel = computeRegistrationFunnel(reg);
  const totalMgmRevenue = det.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);

  function pbBlock(pb, regSrc, detSrc) {
    const regForPb = regSrc.filter(r => r.upline === pb);
    const detForPb = detSrc.filter(d => d.upline === pb);
    const funnel = computeRegistrationFunnel(regForPb);
    const mgm_revenue = detForPb.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
    const dates = new Set(regForPb.map(r => r.tanggal_registrasi).filter(Boolean));
    const avg_registration_per_day = dates.size > 0 ? funnel.registrations / dates.size : null;
    return { ...funnel, mgm_revenue, avg_registration_per_day };
  }

  const rows = [...uplineSet].map(pb => {
    const cur = pbBlock(pb, reg, det);
    const prev = pbBlock(pb, prevReg, prevDet);
    const deltas = {
      registrations: pctDelta(cur.registrations, prev.registrations),
      active_registrations: pctDelta(cur.active_registrations, prev.active_registrations),
      inactive_registrations: pctDelta(cur.inactive_registrations, prev.inactive_registrations),
      activation_conversion_pct: pointDelta(cur.activation_conversion_pct, prev.activation_conversion_pct),
      avg_registration_per_day: pctDelta(cur.avg_registration_per_day, prev.avg_registration_per_day),
      mgm_revenue: pctDelta(cur.mgm_revenue, prev.mgm_revenue),
    };
    return {
      pb,
      registrations: cur.registrations,
      active_registrations: cur.active_registrations,
      inactive_registrations: cur.inactive_registrations,
      unknown_active_status: cur.unknown_active_status,
      activation_conversion_pct: cur.activation_conversion_pct,
      avg_registration_per_day: cur.avg_registration_per_day,
      mgm_revenue: cur.mgm_revenue,
      contribution_registration_pct: safePct(cur.registrations, totalFunnel.registrations),
      contribution_active_pct: safePct(cur.active_registrations, totalFunnel.active_registrations),
      contribution_revenue_pct: safePct(cur.mgm_revenue, totalMgmRevenue),
      previous_same_day: prev,
      deltas,
      status: null, // diisi setelah threshold dihitung
    };
  });

  const thresholds = computeSegmentationThresholds(rows);
  rows.forEach(r => { r.status = classifyPb(r, thresholds); });

  return { rows, thresholds };
}

// ─────────────────────────────────────────────────────────────────
// Concentration risk — kontribusi Top-1/5/10 PB terhadap suatu metrik.
// ─────────────────────────────────────────────────────────────────

function concentrationRisk(pbRows, metricKey, totalValue) {
  const sorted = [...pbRows].sort((a, b) => safeNumber(b[metricKey]) - safeNumber(a[metricKey]));
  const topN = n => sorted.slice(0, n).reduce((s, r) => s + safeNumber(r[metricKey]), 0);
  return {
    top1: { value: topN(1), pct: safePct(topN(1), totalValue), pb: sorted[0]?.pb || null },
    top5: { value: topN(5), pct: safePct(topN(5), totalValue) },
    top10: { value: topN(10), pct: safePct(topN(10), totalValue) },
  };
}

// ─────────────────────────────────────────────────────────────────
// Aging — hari sejak tanggal acuan sampai cutoff. Deskriptif SAJA — belum
// ada SLA resmi yang ditetapkan untuk MGM PA, jangan dilabeli "SLA breach".
// ─────────────────────────────────────────────────────────────────

function daysBetween(fromDateStr, toDateStr) {
  if (!fromDateStr || !toDateStr) return null;
  const from = new Date(`${String(fromDateStr).slice(0, 10)}T00:00:00Z`);
  const to = new Date(`${String(toDateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.max(0, Math.round((to - from) / 86400000));
}

function agingBucket(days) {
  if (days === null) return 'unknown';
  if (days <= 1) return '0-1 hari';
  if (days <= 3) return '2-3 hari';
  if (days <= 7) return '4-7 hari';
  if (days <= 14) return '8-14 hari';
  return '>14 hari';
}

// ─────────────────────────────────────────────────────────────────
// Orchestrator utama — dipanggil dari analyticsHandler.
// dataset: { registrasi, aktivasi, detail, previousRegistrasi, previousAktivasi, previousDetail }
// options: { cutoffDate, compareCutoffDateStr }
//
// PENTING: `registrasi`/`aktivasi`/`detail` di sini HARUS SUDAH berisi
// seluruh data periode yang tersinkron (current period TIDAK dipotong
// oleh cutoff_date — lihat §6 spesifikasi bisnis). cutoffDate di sini
// hanya dipakai untuk menghitung `aging_days` deskriptif, BUKAN untuk
// memfilter current period.
// ─────────────────────────────────────────────────────────────────

function buildPeriodAnalytics(dataset, options = {}) {
  const {
    registrasi = [], aktivasi = [], detail = [],
    previousRegistrasi = [], previousAktivasi = [], previousDetail = [],
  } = dataset;
  const cutoffDate = options.cutoffDate || null;

  const current = computeSummary(registrasi, aktivasi, detail);
  const previous = computeSummary(previousRegistrasi, previousAktivasi, previousDetail);
  const deltas = summaryDeltas(current, previous);

  const cohort_funnel = {
    registrations: current.registrations,
    active_registrations: current.active_registrations,
    inactive_registrations: current.inactive_registrations,
    unknown_active_status: current.unknown_active_status,
    registered_and_transacting: current.registered_and_transacting,
    activation_conversion_pct: current.activation_conversion_pct,
    registered_to_transacting_pct: current.registered_to_transacting_pct,
  };

  const operational_volume = {
    activated_outlets: current.activated_outlets,
    transacting_outlets: current.transacting_outlets,
    total_trx: current.total_trx,
    transaction_revenue: current.transaction_revenue,
    activation_to_transaction_pct: current.activation_to_transaction_pct,
    paid_activation_events: current.paid_activation_events,
  };

  const { rows: pb_scorecard, thresholds } = buildPbScorecard(
    registrasi, aktivasi, detail, previousRegistrasi, previousAktivasi, previousDetail
  );

  const pb_matrix = {
    thresholds,
    rows: pb_scorecard.map(r => ({
      pb: r.pb,
      x_registrations: r.registrations,
      y_conversion_pct: r.activation_conversion_pct,
      bubble_revenue: r.mgm_revenue,
      status: r.status,
    })),
  };

  const concentration = {
    registrations: concentrationRisk(pb_scorecard, 'registrations', current.registrations),
    mgm_revenue: concentrationRisk(pb_scorecard, 'mgm_revenue', current.mgm_revenue),
  };

  const economics = {
    mgm_revenue: current.mgm_revenue,
    fee_upline: current.fee_upline,
    avg_commission_per_activation: current.avg_commission_per_activation,
    paid_activation_events: current.paid_activation_events,
    negative_activation_count: current.negative_activation_count,
    negative_activation_rate: current.negative_activation_rate,
    transaction_revenue: current.transaction_revenue,
    by_tipe_outlet: groupSum(detail, 'tipe_outlet', ['fee_upline', 'komisi_aktifasi', 'biaya_aktifasi']),
    by_nama_group: groupSum(detail, 'nama_group', ['fee_upline', 'komisi_aktifasi', 'biaya_aktifasi']),
    by_pembayaran_via: groupSum(detail, 'pembayaran_via', ['fee_upline', 'komisi_aktifasi', 'biaya_aktifasi']),
    negative_activations: detail
      .filter(d => safeNumber(d.komisi_aktifasi) < 0)
      .map(d => ({
        id_aktifasi: d.id_aktifasi, id_outlet: d.id_outlet, upline: d.upline,
        komisi_aktifasi: safeNumber(d.komisi_aktifasi), fee_upline: safeNumber(d.fee_upline),
        biaya_aktifasi_2: safeNumber(d.biaya_aktifasi_2), hpp: safeNumber(d.hpp), ongkos_kirim: safeNumber(d.ongkos_kirim),
      })),
    formula_mismatch: detail
      .map(d => {
        const expected = safeNumber(d.biaya_aktifasi_2) - safeNumber(d.hpp) - safeNumber(d.ongkos_kirim) - safeNumber(d.fee_upline);
        const actual = safeNumber(d.komisi_aktifasi);
        const diff = Math.round((actual - expected) * 100) / 100;
        return { id_aktifasi: d.id_aktifasi, id_outlet: d.id_outlet, expected, actual, diff };
      })
      .filter(x => Math.abs(x.diff) > 0.01),
  };

  const territories = groupSum(aktivasi, 'nama_propinsi', []).map(t => {
    const rowsInProv = aktivasi.filter(a => (a.nama_propinsi || 'Tidak diketahui') === t.key);
    const regInProv = registrasi.filter(r => (r.nama_propinsi || 'Tidak diketahui') === t.key).length;
    return {
      provinsi: t.key,
      registrations: regInProv,
      activated_outlets: rowsInProv.length,
      transacting_outlets: rowsInProv.filter(a => safeNumber(a.trx) > 0).length,
      total_trx: rowsInProv.reduce((s, a) => s + safeNumber(a.trx), 0),
      transaction_revenue: rowsInProv.reduce((s, a) => s + safeNumber(a.rev), 0),
    };
  }).sort((a, b) => b.transaction_revenue - a.transaction_revenue);

  const outlet_types = distinctValues(aktivasi, 'tipe_outlet').map(tipe => {
    const rows = aktivasi.filter(a => (a.tipe_outlet || 'Tidak diketahui') === tipe);
    return {
      tipe_outlet: tipe,
      activated_outlets: rows.length,
      transacting_outlets: rows.filter(a => safeNumber(a.trx) > 0).length,
      total_trx: rows.reduce((s, a) => s + safeNumber(a.trx), 0),
      transaction_revenue: rows.reduce((s, a) => s + safeNumber(a.rev), 0),
    };
  }).sort((a, b) => b.activated_outlets - a.activated_outlets);

  const payment_mix = distinctValues(detail, 'pembayaran_via').map(via => {
    const rows = detail.filter(d => (d.pembayaran_via || 'Tidak diketahui') === via);
    return {
      pembayaran_via: via,
      count: rows.length,
      fee_upline: rows.reduce((s, d) => s + safeNumber(d.fee_upline), 0),
      mgm_revenue: rows.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0),
    };
  }).sort((a, b) => b.count - a.count);

  // ── Derived action queues (data-driven, deskriptif — belum ada SLA resmi) ──
  const p0_unknown_active = registrasi
    .filter(r => r.id_outlet && r.is_active === null)
    .map(r => ({ type: 'unknown_active_status', id_outlet: r.id_outlet, upline: r.upline }));

  const uplineIndex = buildCanonicalOutletIndex(registrasi, aktivasi, detail);
  const p0_upline_mismatch = [];
  uplineIndex.forEach(e => {
    if (e.upline_mismatch_reg_akt || e.upline_mismatch_reg_detail || e.upline_mismatch_akt_detail) {
      p0_upline_mismatch.push({
        type: 'upline_mismatch', id_outlet: e.id_outlet,
        upline_reg: e.upline_reg, upline_akt: e.upline_akt, upline_detail: e.upline_detail,
      });
    }
  });

  const p1_registered_not_active = registrasi
    .filter(r => r.id_outlet && r.is_active === false)
    .map(r => ({
      type: 'registered_not_active', id_outlet: r.id_outlet, upline: r.upline,
      aging_days: daysBetween(r.tanggal_registrasi, cutoffDate),
    }))
    .sort((a, b) => (b.aging_days ?? -1) - (a.aging_days ?? -1));

  const p1_pb_high_inactive_backlog = [...pb_scorecard]
    .filter(r => r.inactive_registrations > 0)
    .sort((a, b) => b.inactive_registrations - a.inactive_registrations)
    .slice(0, 20)
    .map(r => ({ type: 'pb_high_inactive_backlog', pb: r.pb, inactive_registrations: r.inactive_registrations, registrations: r.registrations }));

  const p1_pb_high_reg_low_conversion = pb_scorecard
    .filter(r => r.registrations >= thresholds.registrations_p50 &&
      (r.activation_conversion_pct === null || r.activation_conversion_pct < thresholds.conversion_p50))
    .map(r => ({ type: 'pb_high_reg_low_conversion', pb: r.pb, registrations: r.registrations, activation_conversion_pct: r.activation_conversion_pct }));

  const p2_pb_scale_candidate = pb_scorecard
    .filter(r => r.activation_conversion_pct !== null && r.activation_conversion_pct >= thresholds.conversion_p75 &&
      r.registrations >= thresholds.registrations_p50)
    .map(r => ({ type: 'pb_scale_candidate', pb: r.pb, activation_conversion_pct: r.activation_conversion_pct, registrations: r.registrations }));

  const p2_pb_high_revenue = [...pb_scorecard]
    .sort((a, b) => b.mgm_revenue - a.mgm_revenue)
    .slice(0, 20)
    .map(r => ({ type: 'pb_high_revenue', pb: r.pb, mgm_revenue: r.mgm_revenue }));

  const derived_queues = {
    p0: [...p0_unknown_active, ...p0_upline_mismatch],
    p1: [...p1_registered_not_active, ...p1_pb_high_inactive_backlog, ...p1_pb_high_reg_low_conversion],
    p2: [...p2_pb_scale_candidate, ...p2_pb_high_revenue],
    p3: [{ type: 'monitoring_normal', count: current.active_registrations }],
  };

  // ── Data quality ──
  const { duplicateCount: dupReg } = dedupeLastWins(registrasi, r => r.id_outlet);
  const { duplicateCount: dupAkt } = dedupeLastWins(aktivasi, a => a.id_outlet);
  const { duplicateCount: dupDetailId } = dedupeLastWins(detail, d => d.id_aktifasi);
  const detailByOutlet = new Map();
  detail.forEach(d => { if (d.id_outlet) detailByOutlet.set(d.id_outlet, d); });
  const actByOutlet = new Map(aktivasi.map(a => [a.id_outlet, a]));

  let uplineMismatchRegAkt = 0, uplineMismatchRegDetail = 0, uplineMismatchAktDetail = 0;
  uplineIndex.forEach(e => {
    if (e.upline_mismatch_reg_akt) uplineMismatchRegAkt++;
    if (e.upline_mismatch_reg_detail) uplineMismatchRegDetail++;
    if (e.upline_mismatch_akt_detail) uplineMismatchAktDetail++;
  });

  const quality = {
    rows: { registrasi: registrasi.length, aktivasi: aktivasi.length, aktivasi_detail: detail.length },
    duplicate_removed: { registrasi: dupReg, aktivasi: dupAkt, aktivasi_detail_id: dupDetailId },
    unknown_active_status: current.unknown_active_status,
    registration_without_activation_or_detail: registrasi.filter(r => r.id_outlet && !detailByOutlet.has(r.id_outlet)).length,
    activation_without_detail: aktivasi.filter(a => a.id_outlet && !detailByOutlet.has(a.id_outlet)).length,
    detail_without_activation: detail.filter(d => d.id_outlet && !actByOutlet.has(d.id_outlet)).length,
    upline_mismatch_reg_vs_activation: uplineMismatchRegAkt,
    upline_mismatch_reg_vs_detail: uplineMismatchRegDetail,
    upline_mismatch_activation_vs_detail: uplineMismatchAktDetail,
    economics_formula_mismatch: economics.formula_mismatch.length,
  };

  return {
    summary: { current, previous, deltas },
    cohort_funnel,
    operational_volume,
    pb_scorecard,
    pb_matrix,
    economics,
    territories,
    outlet_types,
    payment_mix,
    concentration,
    derived_queues,
    quality,
  };
}

function groupSum(rows, key, sumFields) {
  const groups = new Map();
  for (const row of rows) {
    const k = row[key] || 'Tidak diketahui';
    if (!groups.has(k)) groups.set(k, { key: k, count: 0, ...Object.fromEntries(sumFields.map(f => [f, 0])) });
    const g = groups.get(k);
    g.count++;
    sumFields.forEach(f => { g[f] += safeNumber(row[f]); });
  }
  return [...groups.values()];
}

function distinctValues(rows, key) {
  return [...new Set(rows.map(r => r[key] || 'Tidak diketahui'))];
}

module.exports = {
  safeNumber,
  safeBoolean,
  safePct,
  pctDelta,
  pointDelta,
  percentile,
  maskPhone,
  parsePeriod,
  previousPeriod,
  lastDayOfMonth,
  compareCutoffDate,
  dedupeLastWins,
  buildCanonicalOutletIndex,
  computeRegistrationFunnel,
  computeMgmRevenue,
  computeTransactionInfo,
  computeSummary,
  summaryDeltas,
  computeSegmentationThresholds,
  classifyPb,
  buildPbScorecard,
  concentrationRisk,
  daysBetween,
  agingBucket,
  buildPeriodAnalytics,
  groupSum,
  distinctValues,
};
