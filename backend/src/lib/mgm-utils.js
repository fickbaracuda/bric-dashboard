'use strict';

/**
 * MGM PA — PB Lifecycle & Productivity Control Tower.
 * Pure functions (tidak menyentuh DB/HTTP) — dipakai oleh
 * backend/src/routes/warroom-mgm.js dan diuji langsung oleh
 * backend/scripts/test-mgm-warroom.js.
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
// Dipakai untuk endpoint outlet list (satu row per outlet), BUKAN untuk
// agregasi KPI (KPI tetap dihitung langsung per-source, lihat catatan
// attribution di buildPeriodAnalytics).
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
    e.tipe_outlet = e.tipe_outlet_akt || e.tipe_outlet_reg || e.tipe_outlet_detail || null;
    e.upline = e.upline_akt || e.upline_reg || e.upline_detail || null;
  }

  return idx;
}

// ─────────────────────────────────────────────────────────────────
// PB segmentation — cascade rule berbasis distribusi (P25/P50/P75),
// BUKAN target bisnis yang belum ada.
// ─────────────────────────────────────────────────────────────────

function computeSegmentationThresholds(pbRows) {
  const gte = arr => arr.filter(v => v !== null && v !== undefined);
  return {
    registrations_p50: percentile(pbRows.map(r => r.registrations), 50),
    conversion_p25: percentile(gte(pbRows.map(r => r.reg_to_paid_conversion_pct)), 25),
    conversion_p50: percentile(gte(pbRows.map(r => r.reg_to_paid_conversion_pct)), 50),
    conversion_p75: percentile(gte(pbRows.map(r => r.reg_to_paid_conversion_pct)), 75),
    transaction_rate_p50: percentile(gte(pbRows.map(r => r.activation_to_transaction_pct)), 50),
    transaction_rate_p75: percentile(gte(pbRows.map(r => r.activation_to_transaction_pct)), 75),
    revenue_p50: percentile(pbRows.map(r => r.total_revenue), 50),
    revenue_per_outlet_p75: percentile(gte(pbRows.map(r => r.revenue_per_activated_outlet)), 75),
    negative_activation_rate_p75: percentile(gte(pbRows.map(r => r.negative_activation_rate)), 75),
  };
}

function classifyPb(row, thresholds) {
  const gte = (v, t) => v !== null && v !== undefined && v >= t;
  const commission = safeNumber(row.activation_commission);
  const negCount = safeNumber(row.negative_activation_count);
  const negRate = row.negative_activation_rate;

  if (commission < 0 || (negCount > 0 && gte(negRate, thresholds.negative_activation_rate_p75))) {
    return 'Costly PB';
  }
  if (
    gte(row.registrations, thresholds.registrations_p50) &&
    gte(row.reg_to_paid_conversion_pct, thresholds.conversion_p50) &&
    gte(row.activation_to_transaction_pct, thresholds.transaction_rate_p50) &&
    gte(row.total_revenue, thresholds.revenue_p50)
  ) {
    return 'Growth Engine';
  }
  if (safeNumber(row.registrations) < thresholds.registrations_p50 && gte(row.reg_to_paid_conversion_pct, thresholds.conversion_p75)) {
    return 'Closer';
  }
  if (gte(row.registrations, thresholds.registrations_p50) &&
      !gte(row.reg_to_paid_conversion_pct, thresholds.conversion_p50)) {
    return 'Hunter Only';
  }
  if (gte(row.activation_to_transaction_pct, thresholds.transaction_rate_p75) ||
      gte(row.revenue_per_activated_outlet, thresholds.revenue_per_outlet_p75)) {
    return 'Productivity Builder';
  }
  return 'Low Activity';
}

// ─────────────────────────────────────────────────────────────────
// Core KPI block untuk satu periode (dipakai utk current & previous).
// PENTING (attribution rule, jangan diubah tanpa sadar):
//   - registrations & conversion denominator: REG.upline / REG.id_outlet
//   - activated/transacting/trx/revenue: AKTIVASI.upline
//   - fee_upline/komisi: DETAIL.upline (MGM AKTIV)
// converted_registrations = REG.id_outlet yang match ke DETAIL.id_outlet
// (bukan match ke AKTIVASI — detail = kejadian aktivasi BERBAYAR).
// ─────────────────────────────────────────────────────────────────

function computeCoreKpis(regRows, actRows, detailRows) {
  const registrations = new Set((regRows || []).map(r => r.id_outlet).filter(Boolean)).size;

  const detailOutletSet = new Set((detailRows || []).map(d => d.id_outlet).filter(Boolean));
  const regOutletSet = new Set((regRows || []).map(r => r.id_outlet).filter(Boolean));
  const convertedRegistrations = [...regOutletSet].filter(id => detailOutletSet.has(id)).length;

  const paidActivationEvents = new Set((detailRows || []).map(d => d.id_aktifasi).filter(Boolean)).size;
  const paidActivationOutlets = detailOutletSet.size;

  const activatedOutlets = new Set((actRows || []).map(a => a.id_outlet).filter(Boolean)).size;
  const transactingOutletIds = new Set(
    (actRows || []).filter(a => safeNumber(a.trx) > 0).map(a => a.id_outlet).filter(Boolean)
  );
  const transactingOutlets = transactingOutletIds.size;

  const convertedAndTransacting = [...regOutletSet].filter(
    id => detailOutletSet.has(id) && transactingOutletIds.has(id)
  ).length;

  const totalTrx = (actRows || []).reduce((s, a) => s + safeNumber(a.trx), 0);
  const totalRevenue = (actRows || []).reduce((s, a) => s + safeNumber(a.rev), 0);

  const feeUpline = (detailRows || []).reduce((s, d) => s + safeNumber(d.fee_upline), 0);
  const activationCommission = (detailRows || []).reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
  const negativeActivationCount = (detailRows || []).filter(d => safeNumber(d.komisi_aktifasi) < 0).length;

  const regToPaidConversionPct = safePct(convertedRegistrations, registrations);
  const convertedToTransactionPct = safePct(convertedAndTransacting, convertedRegistrations);
  const activationToTransactionPct = safePct(transactingOutlets, activatedOutlets);
  const avgCommissionPerActivation = paidActivationEvents > 0 ? activationCommission / paidActivationEvents : null;
  const revenuePerTransaction = totalTrx > 0 ? totalRevenue / totalTrx : null;
  const revenuePerActivatedOutlet = activatedOutlets > 0 ? totalRevenue / activatedOutlets : null;
  const negativeActivationRate = safePct(negativeActivationCount, paidActivationEvents);

  return {
    registrations,
    converted_registrations: convertedRegistrations,
    converted_and_transacting: convertedAndTransacting,
    paid_activation_events: paidActivationEvents,
    paid_activation_outlets: paidActivationOutlets,
    activated_outlets: activatedOutlets,
    transacting_outlets: transactingOutlets,
    total_trx: totalTrx,
    total_revenue: totalRevenue,
    fee_upline: feeUpline,
    activation_commission: activationCommission,
    negative_activation_count: negativeActivationCount,
    reg_to_paid_conversion_pct: regToPaidConversionPct,
    converted_to_transaction_pct: convertedToTransactionPct,
    activation_to_transaction_pct: activationToTransactionPct,
    avg_commission_per_activation: avgCommissionPerActivation,
    revenue_per_transaction: revenuePerTransaction,
    revenue_per_activated_outlet: revenuePerActivatedOutlet,
    negative_activation_rate: negativeActivationRate,
  };
}

function summaryDeltas(current, previous) {
  const rateKeys = new Set([
    'reg_to_paid_conversion_pct', 'converted_to_transaction_pct', 'activation_to_transaction_pct',
    'negative_activation_rate',
  ]);
  const deltas = {};
  for (const key of Object.keys(current)) {
    if (rateKeys.has(key)) deltas[key] = pointDelta(current[key], previous[key]);
    else deltas[key] = pctDelta(current[key], previous[key]);
  }
  return deltas;
}

// ─────────────────────────────────────────────────────────────────
// PB scorecard — satu row per upline yang muncul di salah satu dataset.
// ─────────────────────────────────────────────────────────────────

function buildPbScorecard(regRows, actRows, detailRows, prevRegRows, prevActRows, prevDetailRows) {
  const uplines = new Set();
  (regRows || []).forEach(r => r.upline && uplines.add(r.upline));
  (actRows || []).forEach(a => a.upline && uplines.add(a.upline));
  (detailRows || []).forEach(d => d.upline && uplines.add(d.upline));

  const totalRevenueAll = (actRows || []).reduce((s, a) => s + safeNumber(a.rev), 0);
  const totalRegAll = new Set((regRows || []).map(r => r.id_outlet)).size;
  const totalDetailAll = new Set((detailRows || []).map(d => d.id_aktifasi)).size;

  const rows = [...uplines].map(pb => {
    const reg = (regRows || []).filter(r => r.upline === pb);
    const act = (actRows || []).filter(a => a.upline === pb);
    const det = (detailRows || []).filter(d => d.upline === pb);
    const cur = computeCoreKpis(reg, act, det);

    const prevReg = (prevRegRows || []).filter(r => r.upline === pb);
    const prevAct = (prevActRows || []).filter(a => a.upline === pb);
    const prevDet = (prevDetailRows || []).filter(d => d.upline === pb);
    const prev = computeCoreKpis(prevReg, prevAct, prevDet);

    return {
      pb,
      registrations: cur.registrations,
      converted_registrations: cur.converted_registrations,
      paid_activation_events: cur.paid_activation_events,
      activated_outlets: cur.activated_outlets,
      transacting_outlets: cur.transacting_outlets,
      total_trx: cur.total_trx,
      total_revenue: cur.total_revenue,
      fee_upline: cur.fee_upline,
      activation_commission: cur.activation_commission,
      negative_activation_count: cur.negative_activation_count,
      negative_activation_rate: cur.negative_activation_rate,
      reg_to_paid_conversion_pct: cur.reg_to_paid_conversion_pct,
      activation_to_transaction_pct: cur.activation_to_transaction_pct,
      revenue_per_activated_outlet: cur.revenue_per_activated_outlet,
      contribution_reg_pct: safePct(cur.registrations, totalRegAll),
      contribution_revenue_pct: safePct(cur.total_revenue, totalRevenueAll),
      contribution_paid_activation_pct: safePct(cur.paid_activation_events, totalDetailAll),
      target: null,
      achievement: null,
      status: null, // diisi setelah threshold dihitung
      previous: prev,
      deltas: summaryDeltas(cur, prev),
    };
  });

  const thresholds = computeSegmentationThresholds(rows);
  rows.forEach(r => { r.status = classifyPb(r, thresholds); });

  return { rows, thresholds };
}

// ─────────────────────────────────────────────────────────────────
// Concentration risk — kontribusi Top-1/5/10 PB.
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
// Aging — hari sejak tanggal acuan sampai cutoff.
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
// ─────────────────────────────────────────────────────────────────

function buildPeriodAnalytics(dataset, options = {}) {
  const {
    registrasi = [], aktivasi = [], detail = [],
    previousRegistrasi = [], previousAktivasi = [], previousDetail = [],
  } = dataset;
  const cutoffDate = options.cutoffDate || null;
  const compareCutoff = options.compareCutoffDateStr || null;

  const current = computeCoreKpis(registrasi, aktivasi, detail);
  const previous = computeCoreKpis(previousRegistrasi, previousAktivasi, previousDetail);
  const deltas = summaryDeltas(current, previous);

  const cohort_funnel = {
    registrations: current.registrations,
    converted_registrations: current.converted_registrations,
    converted_and_transacting: current.converted_and_transacting,
    reg_to_paid_conversion_pct: current.reg_to_paid_conversion_pct,
    converted_to_transaction_pct: current.converted_to_transaction_pct,
  };

  const operational_volume = {
    paid_activation_events: current.paid_activation_events,
    paid_activation_outlets: current.paid_activation_outlets,
    activated_outlets: current.activated_outlets,
    transacting_outlets: current.transacting_outlets,
    activation_to_transaction_pct: current.activation_to_transaction_pct,
  };

  const { rows: pb_scorecard, thresholds } = buildPbScorecard(
    registrasi, aktivasi, detail, previousRegistrasi, previousAktivasi, previousDetail
  );

  const pb_matrix = {
    thresholds,
    rows: pb_scorecard.map(r => ({
      pb: r.pb,
      x_registrations: r.registrations,
      y_conversion_pct: r.reg_to_paid_conversion_pct,
      bubble_revenue: r.total_revenue,
      status: r.status,
    })),
  };

  const concentration = {
    registrations: concentrationRisk(pb_scorecard, 'registrations', current.registrations),
    paid_activation_events: concentrationRisk(pb_scorecard, 'paid_activation_events', current.paid_activation_events),
    revenue: concentrationRisk(pb_scorecard, 'total_revenue', current.total_revenue),
  };

  const economics = {
    fee_upline: current.fee_upline,
    activation_commission: current.activation_commission,
    avg_commission_per_activation: current.avg_commission_per_activation,
    negative_activation_count: current.negative_activation_count,
    negative_activation_rate: current.negative_activation_rate,
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

  const territories = groupSum(
    aktivasi.map(a => ({ ...a, __trx: a.trx, __rev: a.rev })),
    'nama_propinsi',
    []
  ).map(t => {
    const rowsInProv = aktivasi.filter(a => (a.nama_propinsi || 'Tidak diketahui') === t.key);
    const regInProv = registrasi.filter(r => r.nama_propinsi === t.key).length;
    return {
      provinsi: t.key,
      registrations: regInProv,
      activated_outlets: rowsInProv.length,
      transacting_outlets: rowsInProv.filter(a => safeNumber(a.trx) > 0).length,
      total_trx: rowsInProv.reduce((s, a) => s + safeNumber(a.trx), 0),
      total_revenue: rowsInProv.reduce((s, a) => s + safeNumber(a.rev), 0),
    };
  }).sort((a, b) => b.total_revenue - a.total_revenue);

  const outlet_types = distinctValues(aktivasi, 'tipe_outlet').map(tipe => {
    const rows = aktivasi.filter(a => (a.tipe_outlet || 'Tidak diketahui') === tipe);
    return {
      tipe_outlet: tipe,
      activated_outlets: rows.length,
      transacting_outlets: rows.filter(a => safeNumber(a.trx) > 0).length,
      total_trx: rows.reduce((s, a) => s + safeNumber(a.trx), 0),
      total_revenue: rows.reduce((s, a) => s + safeNumber(a.rev), 0),
    };
  }).sort((a, b) => b.activated_outlets - a.activated_outlets);

  const payment_mix = distinctValues(detail, 'pembayaran_via').map(via => {
    const rows = detail.filter(d => (d.pembayaran_via || 'Tidak diketahui') === via);
    return {
      pembayaran_via: via,
      count: rows.length,
      fee_upline: rows.reduce((s, d) => s + safeNumber(d.fee_upline), 0),
      activation_commission: rows.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0),
    };
  }).sort((a, b) => b.count - a.count);

  // ── Derived action queues (data-driven, bukan SLA resmi) ──
  const regOutletMap = new Map(registrasi.map(r => [r.id_outlet, r]));
  const detailByOutlet = new Map();
  detail.forEach(d => { if (d.id_outlet) detailByOutlet.set(d.id_outlet, d); });
  const actByOutlet = new Map(aktivasi.map(a => [a.id_outlet, a]));

  const p0_negative_commission = detail
    .filter(d => safeNumber(d.komisi_aktifasi) < 0)
    .map(d => ({ type: 'negative_commission', id_outlet: d.id_outlet, id_aktifasi: d.id_aktifasi, upline: d.upline, komisi_aktifasi: safeNumber(d.komisi_aktifasi) }));

  const p0_paid_not_active = detail
    .filter(d => d.id_outlet && !actByOutlet.has(d.id_outlet))
    .map(d => ({ type: 'data_mismatch_paid_not_active', id_outlet: d.id_outlet, id_aktifasi: d.id_aktifasi, upline: d.upline }));

  const regNotPaid = registrasi
    .filter(r => r.id_outlet && !detailByOutlet.has(r.id_outlet))
    .map(r => ({
      type: 'registered_not_paid', id_outlet: r.id_outlet, upline: r.upline,
      aging_days: daysBetween(r.tanggal_registrasi, cutoffDate),
    }))
    .sort((a, b) => (b.aging_days ?? -1) - (a.aging_days ?? -1));
  const agingCriticalCutoffIdx = Math.floor(regNotPaid.length * 0.1);
  const p1_registered_not_paid = regNotPaid.map((r, i) => ({ ...r, aging_critical: i < agingCriticalCutoffIdx }));

  const activeNoTrx = aktivasi
    .filter(a => safeNumber(a.trx) === 0)
    .map(a => ({
      type: 'active_no_transaction', id_outlet: a.id_outlet, upline: a.upline,
      aging_days: daysBetween(a.tanggal_aktifasi, cutoffDate),
    }))
    .sort((a, b) => (b.aging_days ?? -1) - (a.aging_days ?? -1));
  const p1ActiveCutoffIdx = Math.floor(activeNoTrx.length * 0.1);
  const p1_active_no_transaction = activeNoTrx.map((r, i) => ({ ...r, aging_critical: i < p1ActiveCutoffIdx }));

  const p2_high_reg_low_conversion = pb_scorecard
    .filter(r => r.registrations >= thresholds.registrations_p50 &&
      (r.reg_to_paid_conversion_pct === null || r.reg_to_paid_conversion_pct < thresholds.conversion_p25 || r.reg_to_paid_conversion_pct < thresholds.conversion_p50))
    .map(r => ({ type: 'high_reg_low_conversion', pb: r.pb, registrations: r.registrations, conversion_pct: r.reg_to_paid_conversion_pct }));

  const p2_scale_candidate = pb_scorecard
    .filter(r => r.reg_to_paid_conversion_pct !== null && r.reg_to_paid_conversion_pct >= thresholds.conversion_p75 &&
      r.total_revenue >= thresholds.revenue_p50)
    .map(r => ({ type: 'scale_reward_candidate', pb: r.pb, conversion_pct: r.reg_to_paid_conversion_pct, total_revenue: r.total_revenue }));

  const derived_queues = {
    p0: [...p0_negative_commission, ...p0_paid_not_active],
    p1: [...p1_registered_not_paid, ...p1_active_no_transaction],
    p2: [...p2_high_reg_low_conversion, ...p2_scale_candidate],
    p3: [{ type: 'monitoring_normal', count: current.activated_outlets - p1_active_no_transaction.length }],
  };

  // ── Data quality ──
  const { duplicateCount: dupReg } = dedupeLastWins(registrasi, r => r.id_outlet);
  const { duplicateCount: dupAkt } = dedupeLastWins(aktivasi, a => a.id_outlet);
  const { duplicateCount: dupDetailId } = dedupeLastWins(detail, d => d.id_aktifasi);
  const detailOutletDupe = detail.length - new Set(detail.map(d => d.id_outlet)).size;

  const uplineIndex = buildCanonicalOutletIndex(registrasi, aktivasi, detail);
  let uplineMismatchRegAkt = 0, uplineMismatchRegDetail = 0, uplineMismatchAktDetail = 0;
  uplineIndex.forEach(e => {
    if (e.upline_mismatch_reg_akt) uplineMismatchRegAkt++;
    if (e.upline_mismatch_reg_detail) uplineMismatchRegDetail++;
    if (e.upline_mismatch_akt_detail) uplineMismatchAktDetail++;
  });

  const regWithoutActivationDetail = registrasi.filter(r => r.id_outlet && !detailByOutlet.has(r.id_outlet)).length;
  const activationWithoutDetail = aktivasi.filter(a => a.id_outlet && !detailByOutlet.has(a.id_outlet)).length;
  const detailWithoutActivation = detail.filter(d => d.id_outlet && !actByOutlet.has(d.id_outlet)).length;

  const quality = {
    rows: { registrasi: registrasi.length, aktivasi: aktivasi.length, aktivasi_detail: detail.length },
    duplicate_removed: { registrasi: dupReg, aktivasi: dupAkt, aktivasi_detail_id: dupDetailId, aktivasi_detail_outlet: Math.max(detailOutletDupe, 0) },
    registration_without_activation_or_detail: regWithoutActivationDetail,
    activation_without_detail: activationWithoutDetail,
    detail_without_activation: detailWithoutActivation,
    upline_mismatch_reg_vs_activation: uplineMismatchRegAkt,
    upline_mismatch_reg_vs_detail: uplineMismatchRegDetail,
    upline_mismatch_activation_vs_detail: uplineMismatchAktDetail,
    economics_formula_mismatch: economics.formula_mismatch.length,
    detail_date_unclassified: detail.filter(d => d.id_outlet && !actByOutlet.has(d.id_outlet)).length,
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
  computeSegmentationThresholds,
  classifyPb,
  computeCoreKpis,
  summaryDeltas,
  buildPbScorecard,
  concentrationRisk,
  daysBetween,
  agingBucket,
  buildPeriodAnalytics,
  groupSum,
  distinctValues,
};
