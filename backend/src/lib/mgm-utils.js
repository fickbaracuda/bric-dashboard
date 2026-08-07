'use strict';

/**
 * MGM PA — PB Lifecycle & Opportunity Control Tower.
 * Pure functions (tidak menyentuh DB/HTTP) — dipakai oleh
 * backend/src/routes/warroom-mgm.js dan diuji langsung oleh
 * backend/scripts/test-mgm-warroom.js.
 *
 * MODEL BISNIS (jangan diubah tanpa sadar):
 *   - Total Registrasi = COUNT DISTINCT mgm_pa_registrasi.id_outlet.
 *   - Sudah Aktif (active_outlets) — KOREKSI FINAL (angka 690 hasil JOIN
 *     REG<->AKTIVASI TERBUKTI SALAH juga — bukan definisi bisnis yang
 *     diminta). Definisi RESMI: PURE COUNT DISTINCT mgm_pa_aktivasi.
 *     id_outlet WHERE is_active dinormalisasi TRUE (nilai valid: 1, "1",
 *     boolean true — lihat safeBoolean). TIDAK PERNAH JOIN/intersection ke
 *     REG. Blank/null/false/unknown TIDAK dihitung aktif. TIDAK PERNAH
 *     pakai REG.is_active atau MGM AKTIV(DETAIL).is_active/id_aktifasi.
 *   - Belum Aktif (inactive_outlets) = registrations - active_outlets
 *     (ARITMATIKA murni dari dua angka independen di atas, BUKAN set-
 *     difference outlet). Jika active_outlets > registrations: JANGAN
 *     cap ke 0/diam-diam jadi positif — flag `active_exceeds_registrations`
 *     dan biarkan quality audit melaporkannya, TIDAK memalsukan angka.
 *   - Conversion Aktivasi = active_outlets / registrations x 100 —
 *     digabung sbg sub-text di kartu Sudah Aktif, BUKAN kartu sendiri.
 *   - NMAT/Transaksi NMAT/Revenue Transaksi/Revenue Aktivasi/Revenue MGM —
 *     TIDAK BERUBAH dari koreksi sebelumnya (lihat komentar masing-masing
 *     fungsi). mgm_revenue SELALU = transaction_revenue + activation_revenue.
 *   - PB Scorecard: registrations per PB dari REG.upline, active_outlets
 *     per PB dari AKTIVASI.upline (is_active=true) — DIHITUNG TERPISAH
 *     (agregasi REG dan AKTIVASI per upline masing-masing, lalu di-UNION
 *     bukan di-inner-join) supaya PB yang hanya muncul di salah satu
 *     sumber TIDAK hilang. Anomali per PB (active > registrations) DIFLAG
 *     `data_quality_anomaly`, TIDAK di-cap, dikeluarkan dari ranking
 *     conversion via status 'CHECK DATA' (priority tertinggi).
 *   - PB Opportunity segmentation: 5 label business-friendly (SCALE UP/
 *     FIX CONVERSION/PUSH RECRUITMENT/HIGH BACKLOG/LOW PRODUCTIVITY) + 1
 *     status audit (CHECK DATA), berbasis percentile aktual (P50/P75),
 *     BUKAN target bisnis. Sample-size guard (qualified_conversion_min_reg)
 *     mencegah PB volume sangat kecil (mis. 1 registrasi, 100% conversion)
 *     otomatis dianggap top performer.
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
// mismatch, BUKAN untuk agregasi KPI utama (Sudah Aktif TIDAK boleh
// dihitung dari sini — lihat computeActiveOutletsFromAktivasi).
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
// Registration funnel — sumber TUNGGAL: mgm_pa_registrasi (REG). HANYA
// fakta murni REG (registrations, PB Aktif Merekrut, rata-rata rekrut/PB).
// TIDAK mengandung active/inactive (lihat computeSudahAktif).
// ─────────────────────────────────────────────────────────────────

function computeRegistrationFunnel(regRows) {
  const byOutlet = new Map();
  for (const r of regRows || []) {
    if (!r.id_outlet) continue;
    byOutlet.set(r.id_outlet, r); // last-wins kalau ada duplikat id_outlet di array
  }

  const uplineSet = new Set();
  for (const r of byOutlet.values()) {
    const up = r.upline && String(r.upline).trim();
    if (up) uplineSet.add(up);
  }

  const registrations = byOutlet.size;
  const active_recruiting_pb = uplineSet.size;

  return {
    registrations,
    active_recruiting_pb,
    avg_registration_per_pb: active_recruiting_pb > 0 ? registrations / active_recruiting_pb : null,
  };
}

// ─────────────────────────────────────────────────────────────────
// Sudah Aktif — DEFINISI RESMI FINAL (koreksi ke-2, angka 690 hasil JOIN
// REG<->AKTIVASI JUGA SALAH). PURE COUNT DISTINCT id_outlet dari
// mgm_pa_aktivasi WHERE is_active dinormalisasi TRUE — TIDAK PERNAH
// join/intersection ke REG, TIDAK PERNAH pakai REG.is_active atau
// DETAIL.is_active/id_aktifasi. Blank/null/false = TIDAK aktif.
// ─────────────────────────────────────────────────────────────────

function computeActiveOutletsFromAktivasi(actRows) {
  const activeIds = new Set();
  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    if (safeBoolean(a.is_active) === true) activeIds.add(a.id_outlet);
  }
  return { active_outlets: activeIds.size, activeIds };
}

// Belum Aktif = registrations - active_outlets — ARITMATIKA murni dari dua
// angka INDEPENDEN (registrations dari REG, active_outlets dari AKTIVASI
// SAJA). Jika active_outlets > registrations: TIDAK di-cap, flag
// `active_exceeds_registrations` supaya quality audit bisa melaporkannya
// — jangan pernah menyembunyikan kondisi ini di balik angka yang terlihat
// valid.
function computeSudahAktif(regRows, actRows) {
  const registrations = computeRegistrationFunnel(regRows).registrations;
  const { active_outlets } = computeActiveOutletsFromAktivasi(actRows);
  const inactive_outlets = registrations - active_outlets;
  return {
    registrations,
    active_outlets,
    inactive_outlets,
    active_exceeds_registrations: active_outlets > registrations,
    activation_conversion_pct: safePct(active_outlets, registrations),
  };
}

// Audit: upline REG vs upline AKTIVASI HANYA utk outlet yang muncul di
// KEDUA sumber & aktif (utk actionability, bukan penentu Sudah Aktif),
// DAN outlet AKTIVASI (apa pun status aktifnya) yang sama sekali tidak
// punya baris REG. Dipakai quality object — bukan bagian nilai KPI.
function computeActivationMatchQuality(regRows, actRows) {
  const regRowsArr = regRows || [];
  const regIds = new Set(regRowsArr.map(r => r.id_outlet).filter(Boolean));
  const regByOutlet = new Map(regRowsArr.filter(r => r.id_outlet).map(r => [r.id_outlet, r]));
  const { activeIds } = computeActiveOutletsFromAktivasi(actRows);
  const aktByOutletActive = new Map();
  const allAktIds = new Set();
  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    allAktIds.add(a.id_outlet);
    if (activeIds.has(a.id_outlet)) aktByOutletActive.set(a.id_outlet, a);
  }

  let uplineMismatch = 0;
  aktByOutletActive.forEach((aktRow, id) => {
    if (!regIds.has(id)) return;
    const regRow = regByOutlet.get(id);
    if (regRow?.upline && aktRow?.upline && regRow.upline !== aktRow.upline) uplineMismatch++;
  });

  const activationWithoutRegistration = [...allAktIds].filter(id => !regIds.has(id)).length;
  const registrationWithoutActivation = [...regIds].filter(id => !allAktIds.has(id)).length;

  return {
    registration_activation_upline_mismatch: uplineMismatch,
    activation_without_registration: activationWithoutRegistration,
    registration_without_activation: registrationWithoutActivation,
  };
}

// Revenue Aktivasi — sumber TUNGGAL: mgm_pa_aktivasi_detail.komisi_aktifasi.
// TIDAK BERUBAH oleh koreksi Sudah Aktif — nilai komisi_aktifasi dipakai
// apa adanya dari source sheet, TIDAK PERNAH dihitung ulang.
function computeActivationRevenue(detailRows) {
  const rows = detailRows || [];
  const activation_revenue = rows.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
  const fee_upline = rows.reduce((s, d) => s + safeNumber(d.fee_upline), 0);
  const paid_activation_events = new Set(rows.map(d => d.id_aktifasi).filter(Boolean)).size;
  const negative_activation_count = rows.filter(d => safeNumber(d.komisi_aktifasi) < 0).length;

  return {
    activation_revenue,
    fee_upline,
    paid_activation_events,
    negative_activation_count,
    negative_activation_rate: safePct(negative_activation_count, paid_activation_events),
    avg_commission_per_activation: paid_activation_events > 0 ? activation_revenue / paid_activation_events : null,
  };
}

// Info transaksi — sumber mgm_pa_aktivasi (AKTIVASI), INFORMASI PENDUKUNG
// SAJA. transaction_revenue TIDAK diubah oleh koreksi Sudah Aktif/NMAT.
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

// dateValue jatuh di [periodStart, periodStart + 1 bulan)? Dipakai NMAT.
function isDateInPeriod(dateValue, periodStart) {
  if (!dateValue || !periodStart) return false;

  const date = String(dateValue).slice(0, 10);
  const start = String(periodStart).slice(0, 10);

  const startDate = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) return false;

  const nextMonth = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    1
  ));

  const next = nextMonth.toISOString().slice(0, 10);

  return date >= start && date < next;
}

// NMAT (New Member Aktif Transaksi) + Transaksi NMAT — TIDAK BERUBAH dari
// koreksi sebelumnya. Sumber TUNGGAL mgm_pa_aktivasi: id_outlet dgn
// tanggal_aktifasi di dalam bulan terpilih DAN trx > 0. nmat_trx = SUM trx
// HANYA outlet yang lolos syarat itu. Duplikat baris last-wins per outlet.
function computeNmatDetails(actRows, periodStart) {
  const byOutlet = new Map();
  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    if (!isDateInPeriod(a.tanggal_aktifasi, periodStart)) continue;
    if (safeNumber(a.trx) <= 0) continue;
    byOutlet.set(a.id_outlet, a); // last-wins per outlet
  }
  let nmat_trx = 0;
  for (const row of byOutlet.values()) nmat_trx += safeNumber(row.trx);
  return { nmat_outlets: byOutlet.size, nmat_trx };
}

// Alias ringkas (kompatibilitas) — hanya jumlah outlet NMAT.
function computeNmatOutlets(actRows, periodStart) {
  if (!periodStart) return 0;
  return computeNmatDetails(actRows, periodStart).nmat_outlets;
}

// Audit row-level KENAPA suatu baris AKTIVASI tidak lolos NMAT.
function computeNmatQuality(actRows, periodStart) {
  let missingDate = 0, invalidDate = 0, excludedOtherMonth = 0, excludedZeroTrx = 0;
  for (const a of actRows || []) {
    if (!a.id_outlet) continue;
    if (!a.tanggal_aktifasi) { missingDate++; continue; }
    const dateStr = String(a.tanggal_aktifasi).slice(0, 10);
    const parsed = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) { invalidDate++; continue; }
    if (!periodStart || !isDateInPeriod(a.tanggal_aktifasi, periodStart)) { excludedOtherMonth++; continue; }
    if (safeNumber(a.trx) <= 0) { excludedZeroTrx++; continue; }
  }
  return {
    nmat_missing_activation_date: missingDate,
    nmat_invalid_activation_date: invalidDate,
    nmat_excluded_other_month: excludedOtherMonth,
    nmat_excluded_zero_trx: excludedZeroTrx,
  };
}

// Gabungan satu periode: funnel registrasi + Sudah Aktif/Belum Aktif
// (PURE COUNT dari AKTIVASI, TIDAK join REG) + revenue (transaksi +
// aktivasi) + NMAT/Transaksi NMAT + info transaksi pendukung + irisan
// "sudah registrasi DAN sudah transaksi".
//
// mgm_revenue SELALU = transaction_revenue + activation_revenue.
function computeSummary(regRows, actRows, detailRows, periodStart) {
  const funnel = computeRegistrationFunnel(regRows);
  const sudahAktif = computeSudahAktif(regRows, actRows);
  const activation = computeActivationRevenue(detailRows);
  const txn = computeTransactionInfo(actRows);
  const nmatDetails = computeNmatDetails(actRows, periodStart);
  const mgm_revenue = txn.transaction_revenue + activation.activation_revenue;

  const regOutletSet = new Set((regRows || []).map(r => r.id_outlet).filter(Boolean));
  const transactingOutletIds = new Set(
    (actRows || []).filter(a => safeNumber(a.trx) > 0).map(a => a.id_outlet).filter(Boolean)
  );
  const registered_and_transacting = [...regOutletSet].filter(id => transactingOutletIds.has(id)).length;

  return {
    ...funnel,
    active_outlets: sudahAktif.active_outlets,
    inactive_outlets: sudahAktif.inactive_outlets,
    active_exceeds_registrations: sudahAktif.active_exceeds_registrations,
    activation_conversion_pct: sudahAktif.activation_conversion_pct,
    ...activation,
    ...txn,
    nmat_outlets: nmatDetails.nmat_outlets,
    nmat_trx: nmatDetails.nmat_trx,
    mgm_revenue,
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
    if (typeof current[key] === 'boolean') continue;
    if (rateKeys.has(key)) deltas[key] = pointDelta(current[key], previous[key]);
    else deltas[key] = pctDelta(current[key], previous[key]);
  }
  // Alias eksplisit _pct/_pt sesuai kontrak API (sama nilainya dgn
  // deltas.X generik di atas — disediakan sbg nama field yang eksplisit
  // diminta spesifikasi, jangan dihapus).
  deltas.transaction_revenue_pct = pctDelta(current.transaction_revenue, previous.transaction_revenue);
  deltas.activation_revenue_pct = pctDelta(current.activation_revenue, previous.activation_revenue);
  deltas.mgm_revenue_pct = pctDelta(current.mgm_revenue, previous.mgm_revenue);
  deltas.active_outlets_pct = pctDelta(current.active_outlets, previous.active_outlets);
  deltas.inactive_outlets_pct = pctDelta(current.inactive_outlets, previous.inactive_outlets);
  deltas.activation_conversion_pt = pointDelta(current.activation_conversion_pct, previous.activation_conversion_pct);
  deltas.nmat_outlets_pct = pctDelta(current.nmat_outlets, previous.nmat_outlets);
  deltas.nmat_trx_pct = pctDelta(current.nmat_trx, previous.nmat_trx);
  return deltas;
}

// ─────────────────────────────────────────────────────────────────
// PB Opportunity segmentation — 5 label business-friendly + 1 status audit,
// cascade rule berbasis distribusi aktual (P50/P75) + sample-size guard.
// BUKAN target bisnis yang belum ada.
// ─────────────────────────────────────────────────────────────────

const SEGMENT_ACTION = {
  'SCALE UP': 'PB sehat dengan volume dan conversion kuat — tambah kapasitas hunting.',
  'FIX CONVERSION': 'Registrasi kuat tetapi aktivasi tertinggal — fokus follow-up aktivasi.',
  'PUSH RECRUITMENT': 'Conversion baik tetapi volume rendah — tingkatkan aktivitas recruitment.',
  'HIGH BACKLOG': 'Registrasi belum aktif tinggi — prioritas recovery backlog.',
  'LOW PRODUCTIVITY': 'Volume dan conversion belum memadai — coaching dan evaluasi aktivitas.',
  'CHECK DATA': 'Data tidak konsisten (active_outlets > registrations) — periksa sumber sebelum dipakai untuk ranking performa.',
};

// qualified_conversion_min_reg — sample-size guard (§N): ambil PB dengan
// registrations > 1, hitung P25 dari populasi itu, floor teknis minimum 2
// supaya PB 1 registrasi/1 aktif/100% conversion TIDAK PERNAH otomatis
// eligible utk label PUSH RECRUITMENT / top converter.
function computeQualifiedConversionMinReg(pbRows) {
  const eligiblePool = (pbRows || []).filter(r => safeNumber(r.registrations) > 1).map(r => r.registrations);
  const p25 = eligiblePool.length ? percentile(eligiblePool, 25) : 0;
  return Math.max(2, Math.round(p25));
}

function computeOpportunitySegmentThresholds(pbRows) {
  const nn = arr => arr.filter(v => v !== null && v !== undefined);
  const rows = pbRows || [];
  return {
    registrations_p50: percentile(rows.map(r => r.registrations), 50),
    registrations_p75: percentile(rows.map(r => r.registrations), 75),
    conversion_p50: percentile(nn(rows.map(r => r.activation_conversion_pct)), 50),
    conversion_p75: percentile(nn(rows.map(r => r.activation_conversion_pct)), 75),
    inactive_p75: percentile(rows.map(r => r.inactive_outlets), 75),
    mgm_revenue_p50: percentile(rows.map(r => r.mgm_revenue), 50),
    transaction_revenue_p50: percentile(rows.map(r => r.transaction_revenue), 50),
    activation_revenue_p50: percentile(rows.map(r => r.activation_revenue), 50),
    nmat_outlets_p50: percentile(rows.map(r => r.nmat_outlets), 50),
    qualified_conversion_min_reg: computeQualifiedConversionMinReg(rows),
  };
}

// Priority cascade (§P): 1) data_quality_anomaly -> CHECK DATA (tertinggi,
// dikeluarkan dari ranking performa) 2) HIGH BACKLOG (backlog P75 tertinggi)
// 3) SCALE UP 4) FIX CONVERSION 5) PUSH RECRUITMENT (wajib lolos sample-size
// guard) 6) LOW PRODUCTIVITY (fallback). Mutually exclusive — satu PB SATU
// status saja.
function classifyOpportunitySegment(row, thresholds) {
  if (row.data_quality_anomaly) return 'CHECK DATA';

  const gte = (v, t) => v !== null && v !== undefined && v >= t;
  const reg = safeNumber(row.registrations);
  const conv = row.activation_conversion_pct;
  const sampleOk = reg >= thresholds.qualified_conversion_min_reg;

  if (reg > 0 && gte(row.inactive_outlets, thresholds.inactive_p75)) {
    return 'HIGH BACKLOG';
  }
  if (reg >= thresholds.registrations_p75 && gte(conv, thresholds.conversion_p50)) {
    return 'SCALE UP';
  }
  if (reg >= thresholds.registrations_p75 && !gte(conv, thresholds.conversion_p50)) {
    return 'FIX CONVERSION';
  }
  if (reg < thresholds.registrations_p75 && gte(conv, thresholds.conversion_p75) && sampleOk) {
    return 'PUSH RECRUITMENT';
  }
  return 'LOW PRODUCTIVITY';
}

// ─────────────────────────────────────────────────────────────────
// PB scorecard — satu row per upline. Roster PAKAI FULL OUTER UNIVERSE
// (union upline dari REG ∪ AKTIVASI ∪ DETAIL) supaya PB yang cuma muncul
// di salah satu sumber TIDAK hilang revenue/NMAT-nya dari scorecard —
// beda dari "PB Aktif Merekrut" (KPI utama, tetap murni COUNT DISTINCT
// REG.upline, lihat computeRegistrationFunnel, TIDAK diubah).
//
// Atribusi per PB (§H — agregasi TERPISAH per sumber, BUKAN inner join):
//   registrations   = REG outlet milik PB (REG.upline = PB)
//   active_outlets  = AKTIVASI outlet milik PB DENGAN is_active=true
//                     (AKTIVASI.upline = PB) — TIDAK di-match ke REG outlet
//                     manapun, murni dari AKTIVASI sendiri.
//   inactive_outlets = registrations - active_outlets (aritmatika, bisa
//                     negatif kalau active > registrations — TIDAK di-cap,
//                     diflag data_quality_anomaly & status CHECK DATA).
//   nmat_outlets/nmat_trx = AKTIVASI.upline = PB, syarat NMAT (tanggal
//     bulan terpilih + trx>0) — attribusi langsung dari AKTIVASI.
//   transaction_revenue = SUM AKTIVASI.rev   GROUP BY AKTIVASI.upline
//   activation_revenue  = SUM DETAIL.komisi_aktifasi GROUP BY DETAIL.upline
//   mgm_revenue          = transaction_revenue + activation_revenue
//   nmat_rate_pct        = nmat_outlets/active_outlets x 100 (null jika 0)
//   revenue_per_nmat     = mgm_revenue/nmat_outlets (null jika 0)
// ─────────────────────────────────────────────────────────────────

function computeByUplineSet(rows, activeOnly) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r.id_outlet || !r.upline) continue;
    if (activeOnly && safeBoolean(r.is_active) !== true) continue;
    const up = String(r.upline).trim();
    if (!up) continue;
    if (!map.has(up)) map.set(up, new Set());
    map.get(up).add(r.id_outlet);
  }
  return map;
}

function buildPbScorecard(regRows, actRows, detailRows, prevRegRows, prevActRows, prevDetailRows, currentPeriod, prevPeriodStart) {
  const reg = regRows || [];
  const act = actRows || [];
  const det = detailRows || [];
  const prevReg = prevRegRows || [];
  const prevAct = prevActRows || [];
  const prevDet = prevDetailRows || [];

  const uplineSet = new Set();
  const collectUplines = rows => rows.forEach(r => { const u = r.upline && String(r.upline).trim(); if (u) uplineSet.add(u); });
  collectUplines(reg); collectUplines(act); collectUplines(det);

  const totalFunnel = computeRegistrationFunnel(reg);
  const totalSudahAktif = computeSudahAktif(reg, act);
  const totalTransactionRevenue = act.reduce((s, a) => s + safeNumber(a.rev), 0);
  const totalActivationRevenue = det.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
  const totalMgmRevenue = totalTransactionRevenue + totalActivationRevenue;
  const totalNmat = computeNmatDetails(act, currentPeriod);

  function pbBlock(pb, regSrc, actSrc, detSrc, periodStart) {
    // Agregasi REG dan AKTIVASI per upline DILAKUKAN TERPISAH (§H) — bukan
    // inner join outlet-level, supaya PB tidak hilang & angka tidak
    // dipengaruhi kecocokan id_outlet lintas sumber.
    const regForPb = regSrc.filter(r => r.upline === pb);
    const actForPb = actSrc.filter(a => a.upline === pb);
    const detForPb = detSrc.filter(d => d.upline === pb);

    const funnel = computeRegistrationFunnel(regForPb);
    const { active_outlets } = computeActiveOutletsFromAktivasi(actForPb);
    const inactive_outlets = funnel.registrations - active_outlets;
    const data_quality_anomaly = active_outlets > funnel.registrations;
    const activation_conversion_pct = safePct(active_outlets, funnel.registrations);

    const nmatDetails = computeNmatDetails(actForPb, periodStart);
    const nmat_rate_pct = active_outlets > 0 ? safePct(nmatDetails.nmat_outlets, active_outlets) : null;

    const transaction_revenue = actForPb.reduce((s, a) => s + safeNumber(a.rev), 0);
    const activation_revenue = detForPb.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0);
    const mgm_revenue = transaction_revenue + activation_revenue;
    const revenue_per_nmat = nmatDetails.nmat_outlets > 0 ? mgm_revenue / nmatDetails.nmat_outlets : null;

    const dates = new Set(regForPb.map(r => r.tanggal_registrasi).filter(Boolean));
    const avg_registration_per_day = funnel.registrations > 0 && dates.size > 0 ? funnel.registrations / dates.size : null;

    return {
      ...funnel, active_outlets, inactive_outlets, data_quality_anomaly, activation_conversion_pct,
      nmat_outlets: nmatDetails.nmat_outlets, nmat_trx: nmatDetails.nmat_trx, nmat_rate_pct,
      transaction_revenue, activation_revenue, mgm_revenue, revenue_per_nmat, avg_registration_per_day,
    };
  }

  const preliminary = [...uplineSet].map(pb => {
    const cur = pbBlock(pb, reg, act, det, currentPeriod);
    const prev = pbBlock(pb, prevReg, prevAct, prevDet, prevPeriodStart);
    const deltas = {
      registrations: pctDelta(cur.registrations, prev.registrations),
      active_outlets: pctDelta(cur.active_outlets, prev.active_outlets),
      inactive_outlets: pctDelta(cur.inactive_outlets, prev.inactive_outlets),
      activation_conversion_pct: pointDelta(cur.activation_conversion_pct, prev.activation_conversion_pct),
      nmat_outlets: pctDelta(cur.nmat_outlets, prev.nmat_outlets),
      nmat_trx: pctDelta(cur.nmat_trx, prev.nmat_trx),
      avg_registration_per_day: pctDelta(cur.avg_registration_per_day, prev.avg_registration_per_day),
      transaction_revenue: pctDelta(cur.transaction_revenue, prev.transaction_revenue),
      activation_revenue: pctDelta(cur.activation_revenue, prev.activation_revenue),
      mgm_revenue: pctDelta(cur.mgm_revenue, prev.mgm_revenue),
    };
    return {
      pb,
      registrations: cur.registrations,
      active_outlets: cur.active_outlets,
      inactive_outlets: cur.inactive_outlets,
      data_quality_anomaly: cur.data_quality_anomaly,
      activation_conversion_pct: cur.activation_conversion_pct,
      nmat_outlets: cur.nmat_outlets,
      nmat_trx: cur.nmat_trx,
      nmat_rate_pct: cur.nmat_rate_pct,
      avg_registration_per_day: cur.avg_registration_per_day,
      transaction_revenue: cur.transaction_revenue,
      activation_revenue: cur.activation_revenue,
      mgm_revenue: cur.mgm_revenue,
      revenue_per_nmat: cur.revenue_per_nmat,
      contribution_registration_pct: safePct(cur.registrations, totalFunnel.registrations),
      contribution_active_pct: safePct(cur.active_outlets, totalSudahAktif.active_outlets),
      contribution_nmat_pct: safePct(cur.nmat_outlets, totalNmat.nmat_outlets),
      contribution_transaction_revenue_pct: safePct(cur.transaction_revenue, totalTransactionRevenue),
      contribution_activation_revenue_pct: safePct(cur.activation_revenue, totalActivationRevenue),
      contribution_mgm_revenue_pct: safePct(cur.mgm_revenue, totalMgmRevenue),
      contribution_revenue_pct: safePct(cur.mgm_revenue, totalMgmRevenue),
      previous_same_day: prev,
      deltas,
    };
  });

  const thresholds = computeOpportunitySegmentThresholds(preliminary);
  const rows = preliminary.map(r => {
    const sample_size_low = safeNumber(r.registrations) < thresholds.qualified_conversion_min_reg;
    const status = classifyOpportunitySegment(r, thresholds);
    return {
      ...r,
      sample_size_low,
      status,
      recommended_action: SEGMENT_ACTION[status] || '',
    };
  });

  return { rows, thresholds };
}

// ─────────────────────────────────────────────────────────────────
// Segment summary (§Q) — ringkasan agregat per segment, dipakai panel
// "Ringkasan Segmen PB" (menggantikan panel teknis Threshold Segmentasi).
// ─────────────────────────────────────────────────────────────────

const SEGMENT_DISPLAY_ORDER = ['SCALE UP', 'FIX CONVERSION', 'PUSH RECRUITMENT', 'HIGH BACKLOG', 'LOW PRODUCTIVITY', 'CHECK DATA'];

function buildSegmentSummary(pbRows) {
  const groups = new Map();
  for (const r of pbRows || []) {
    const seg = r.status || 'LOW PRODUCTIVITY';
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg).push(r);
  }
  return SEGMENT_DISPLAY_ORDER.filter(seg => groups.has(seg)).map(seg => {
    const rows = groups.get(seg);
    const registrations = rows.reduce((s, r) => s + safeNumber(r.registrations), 0);
    const active_outlets = rows.reduce((s, r) => s + safeNumber(r.active_outlets), 0);
    const inactive_outlets = rows.reduce((s, r) => s + safeNumber(r.inactive_outlets), 0);
    const nmat_outlets = rows.reduce((s, r) => s + safeNumber(r.nmat_outlets), 0);
    const mgm_revenue = rows.reduce((s, r) => s + safeNumber(r.mgm_revenue), 0);
    return {
      segment: seg,
      pb_count: rows.length,
      registrations, active_outlets, inactive_outlets,
      activation_conversion_pct: safePct(active_outlets, registrations),
      nmat_outlets, mgm_revenue,
      action_text: SEGMENT_ACTION[seg] || '',
    };
  });
}

// ─────────────────────────────────────────────────────────────────
// Top Opportunity lists (§S) — maks 5 per kelompok, TIDAK menampilkan
// puluhan baris.
// ─────────────────────────────────────────────────────────────────

function buildOpportunityLists(pbRows) {
  const rows = pbRows || [];

  const prioritas_aktivasi = [...rows]
    .filter(r => r.status !== 'CHECK DATA')
    .sort((a, b) => (b.inactive_outlets - a.inactive_outlets)
      || (b.registrations - a.registrations)
      || ((a.activation_conversion_pct ?? 0) - (b.activation_conversion_pct ?? 0)))
    .slice(0, 5)
    .map(r => ({
      pb: r.pb, registrations: r.registrations, active_outlets: r.active_outlets,
      inactive_outlets: r.inactive_outlets, activation_conversion_pct: r.activation_conversion_pct,
    }));

  const kandidat_scale_up = rows
    .filter(r => r.status === 'SCALE UP')
    .sort((a, b) => b.mgm_revenue - a.mgm_revenue)
    .slice(0, 5)
    .map(r => ({
      pb: r.pb, registrations: r.registrations, activation_conversion_pct: r.activation_conversion_pct,
      nmat_outlets: r.nmat_outlets, mgm_revenue: r.mgm_revenue,
    }));

  const push_recruitment = rows
    .filter(r => r.status === 'PUSH RECRUITMENT')
    .sort((a, b) => (b.activation_conversion_pct ?? 0) - (a.activation_conversion_pct ?? 0))
    .slice(0, 5)
    .map(r => ({
      pb: r.pb, registrations: r.registrations, activation_conversion_pct: r.activation_conversion_pct,
      mgm_revenue: r.mgm_revenue,
    }));

  return { prioritas_aktivasi, kandidat_scale_up, push_recruitment };
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
// ada SLA resmi yang ditetapkan untuk MGM PA.
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
// options: { cutoffDate, compareCutoffDateStr, currentPeriod }
//
// PENTING: `registrasi`/`aktivasi`/`detail` di sini HARUS SUDAH berisi
// seluruh data periode yang tersinkron (current period TIDAK dipotong
// oleh cutoff_date). cutoffDate di sini hanya dipakai untuk menghitung
// `aging_days` deskriptif, BUKAN untuk memfilter current period.
// `currentPeriod` ('YYYY-MM-01') dipakai KHUSUS utk NMAT — previous period
// NMAT otomatis dihitung dari previousPeriod(currentPeriod).
// ─────────────────────────────────────────────────────────────────

function buildPeriodAnalytics(dataset, options = {}) {
  const {
    registrasi = [], aktivasi = [], detail = [],
    previousRegistrasi = [], previousAktivasi = [], previousDetail = [],
  } = dataset;
  const cutoffDate = options.cutoffDate || null;
  const currentPeriod = options.currentPeriod || null;
  const prevPeriod = currentPeriod ? previousPeriod(currentPeriod) : null;

  const current = computeSummary(registrasi, aktivasi, detail, currentPeriod);
  const previous = computeSummary(previousRegistrasi, previousAktivasi, previousDetail, prevPeriod);
  const deltas = summaryDeltas(current, previous);

  const cohort_funnel = {
    registrations: current.registrations,
    active_outlets: current.active_outlets,
    inactive_outlets: current.inactive_outlets,
    registered_and_transacting: current.registered_and_transacting,
    activation_conversion_pct: current.activation_conversion_pct,
    registered_to_transacting_pct: current.registered_to_transacting_pct,
  };

  const operational_volume = {
    activated_outlets: current.activated_outlets,
    transacting_outlets: current.transacting_outlets,
    nmat_outlets: current.nmat_outlets,
    nmat_trx: current.nmat_trx,
    total_trx: current.total_trx,
    transaction_revenue: current.transaction_revenue,
    activation_to_transaction_pct: current.activation_to_transaction_pct,
    paid_activation_events: current.paid_activation_events,
  };

  const { rows: pb_scorecard, thresholds } = buildPbScorecard(
    registrasi, aktivasi, detail, previousRegistrasi, previousAktivasi, previousDetail,
    currentPeriod, prevPeriod
  );

  const segment_summary = buildSegmentSummary(pb_scorecard);
  const opportunity_lists = buildOpportunityLists(pb_scorecard);

  const pb_matrix = {
    thresholds,
    rows: pb_scorecard.map(r => ({
      pb: r.pb,
      x_registrations: r.registrations,
      y_conversion_pct: r.activation_conversion_pct,
      bubble_revenue: r.mgm_revenue,
      status: r.status,
      active_outlets: r.active_outlets,
      inactive_outlets: r.inactive_outlets,
      nmat_outlets: r.nmat_outlets,
      nmat_trx: r.nmat_trx,
      transaction_revenue: r.transaction_revenue,
      activation_revenue: r.activation_revenue,
      recommended_action: r.recommended_action,
      sample_size_low: r.sample_size_low,
      data_quality_anomaly: r.data_quality_anomaly,
    })),
  };

  const concentration = {
    registrations: concentrationRisk(pb_scorecard, 'registrations', current.registrations),
    mgm_revenue: concentrationRisk(pb_scorecard, 'mgm_revenue', current.mgm_revenue),
    nmat_outlets: concentrationRisk(pb_scorecard, 'nmat_outlets', current.nmat_outlets),
  };

  const economics = {
    transaction_revenue: current.transaction_revenue,
    activation_revenue: current.activation_revenue,
    mgm_revenue: current.mgm_revenue,
    transaction_revenue_share_pct: safePct(current.transaction_revenue, current.mgm_revenue),
    activation_revenue_share_pct: safePct(current.activation_revenue, current.mgm_revenue),
    fee_upline: current.fee_upline,
    avg_commission_per_activation: current.avg_commission_per_activation,
    paid_activation_events: current.paid_activation_events,
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

  // Peta id_outlet -> provinsi (satu nilai per outlet, dari AKTIVASI dulu lalu
  // REG sbg fallback) supaya atribusi activation_revenue per provinsi TIDAK
  // menjumlahkan record ganda akibat join one-to-many — setiap baris DETAIL
  // di-lookup ke SATU provinsi lewat Map, bukan di-join silang ke AKTIVASI.
  const outletProvinceMap = new Map();
  aktivasi.forEach(a => { if (a.id_outlet && !outletProvinceMap.has(a.id_outlet)) outletProvinceMap.set(a.id_outlet, a.nama_propinsi || 'Tidak diketahui'); });
  registrasi.forEach(r => { if (r.id_outlet && !outletProvinceMap.has(r.id_outlet)) outletProvinceMap.set(r.id_outlet, r.nama_propinsi || 'Tidak diketahui'); });

  const activationRevenueByProvince = new Map();
  detail.forEach(d => {
    const prov = outletProvinceMap.get(d.id_outlet) || 'Tidak diketahui';
    activationRevenueByProvince.set(prov, (activationRevenueByProvince.get(prov) || 0) + safeNumber(d.komisi_aktifasi));
  });

  const territories = groupSum(aktivasi, 'nama_propinsi', []).map(t => {
    const rowsInProv = aktivasi.filter(a => (a.nama_propinsi || 'Tidak diketahui') === t.key);
    const regInProv = registrasi.filter(r => (r.nama_propinsi || 'Tidak diketahui') === t.key).length;
    const transaction_revenue = rowsInProv.reduce((s, a) => s + safeNumber(a.rev), 0);
    const activation_revenue = activationRevenueByProvince.get(t.key) || 0;
    return {
      provinsi: t.key,
      registrations: regInProv,
      activated_outlets: rowsInProv.length,
      transacting_outlets: rowsInProv.filter(a => safeNumber(a.trx) > 0).length,
      total_trx: rowsInProv.reduce((s, a) => s + safeNumber(a.trx), 0),
      transaction_revenue,
      activation_revenue,
      mgm_revenue: transaction_revenue + activation_revenue,
    };
  }).sort((a, b) => b.mgm_revenue - a.mgm_revenue);

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
      // HANYA dari DETAIL (pembayaran_via bukan kolom AKTIVASI) — activation_revenue,
      // BUKAN mgm_revenue penuh (jangan disamakan, ini cuma satu komponen).
      activation_revenue: rows.reduce((s, d) => s + safeNumber(d.komisi_aktifasi), 0),
    };
  }).sort((a, b) => b.count - a.count);

  // ── Derived action queues (data-driven, deskriptif — belum ada SLA resmi) ──
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

  // Queue "Registrasi Belum Aktif" — INFORMASIONAL utk follow-up (set REG
  // outlet yang id_outlet-nya TIDAK ada di set aktif AKTIVASI). Ini BUKAN
  // definisi resmi KPI Belum Aktif (yang aritmatika murni, lihat
  // computeSudahAktif) — jumlah baris queue ini BISA berbeda dari angka
  // KPI inactive_outlets kalau ada AKTIVASI aktif di luar universe REG
  // (lihat quality.activation_without_registration). Dipakai murni utk
  // actionability (siapa yang perlu di-follow-up), bukan sumber kebenaran KPI.
  const { activeIds: curActiveIds } = computeActiveOutletsFromAktivasi(aktivasi);
  const regByOutletMap = new Map(registrasi.filter(r => r.id_outlet).map(r => [r.id_outlet, r]));
  const p1_registered_not_active = [...regByOutletMap.keys()]
    .filter(id => !curActiveIds.has(id))
    .map(id => {
      const regRow = regByOutletMap.get(id);
      return {
        type: 'registered_not_active', id_outlet: id, upline: regRow?.upline || null,
        aging_days: daysBetween(regRow?.tanggal_registrasi, cutoffDate),
      };
    }).sort((a, b) => (b.aging_days ?? -1) - (a.aging_days ?? -1));

  const p1_pb_high_inactive_backlog = [...pb_scorecard]
    .filter(r => r.inactive_outlets > 0 && r.status !== 'CHECK DATA')
    .sort((a, b) => b.inactive_outlets - a.inactive_outlets)
    .slice(0, 20)
    .map(r => ({ type: 'pb_high_inactive_backlog', pb: r.pb, inactive_outlets: r.inactive_outlets, registrations: r.registrations }));

  const p1_pb_high_reg_low_conversion = pb_scorecard
    .filter(r => r.status === 'FIX CONVERSION')
    .map(r => ({ type: 'pb_high_reg_low_conversion', pb: r.pb, registrations: r.registrations, activation_conversion_pct: r.activation_conversion_pct }));

  const p2_pb_scale_candidate = pb_scorecard
    .filter(r => r.status === 'SCALE UP')
    .map(r => ({ type: 'pb_scale_candidate', pb: r.pb, activation_conversion_pct: r.activation_conversion_pct, registrations: r.registrations }));

  const p2_pb_high_revenue = [...pb_scorecard]
    .sort((a, b) => b.mgm_revenue - a.mgm_revenue)
    .slice(0, 20)
    .map(r => ({ type: 'pb_high_revenue', pb: r.pb, mgm_revenue: r.mgm_revenue }));

  const p2_pb_high_nmat = [...pb_scorecard]
    .filter(r => r.nmat_outlets > 0)
    .sort((a, b) => b.nmat_outlets - a.nmat_outlets)
    .slice(0, 20)
    .map(r => ({ type: 'pb_high_nmat', pb: r.pb, nmat_outlets: r.nmat_outlets, nmat_trx: r.nmat_trx }));

  const revenueConcentration = concentrationRisk(pb_scorecard, 'mgm_revenue', current.mgm_revenue);
  const topRevenuePbSet = new Set(
    [...pb_scorecard].sort((a, b) => b.mgm_revenue - a.mgm_revenue).slice(0, 5).map(r => r.pb)
  );
  const p2_pb_concentration_risk = revenueConcentration.top1?.pct != null && revenueConcentration.top1.pct >= 20
    ? [...pb_scorecard].filter(r => topRevenuePbSet.has(r.pb))
        .map(r => ({ type: 'pb_revenue_concentration_risk', pb: r.pb, mgm_revenue: r.mgm_revenue, contribution_mgm_revenue_pct: r.contribution_mgm_revenue_pct }))
    : [];

  const p0_data_quality_anomaly = pb_scorecard
    .filter(r => r.data_quality_anomaly)
    .map(r => ({ type: 'pb_active_exceeds_registrations', pb: r.pb, registrations: r.registrations, active_outlets: r.active_outlets }));

  const derived_queues = {
    p0: [...p0_data_quality_anomaly, ...p0_upline_mismatch],
    p1: [...p1_registered_not_active, ...p1_pb_high_inactive_backlog, ...p1_pb_high_reg_low_conversion],
    p2: [
      ...p2_pb_scale_candidate, ...p2_pb_high_revenue, ...p2_pb_high_nmat,
      ...p2_pb_concentration_risk,
    ],
    p3: [{ type: 'monitoring_normal', count: current.active_outlets }],
  };

  // ── Data quality (§X) ──
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

  const revenueFormulaDiff = Math.abs(current.mgm_revenue - (current.transaction_revenue + current.activation_revenue));
  const activationMatchQuality = computeActivationMatchQuality(registrasi, aktivasi);
  const nmatQuality = computeNmatQuality(aktivasi, currentPeriod);
  const lowSamplePbCount = pb_scorecard.filter(r => r.sample_size_low).length;
  const segmentationAnomalyCount = pb_scorecard.filter(r => r.status === 'CHECK DATA').length;

  const quality = {
    rows: { registrasi: registrasi.length, aktivasi: aktivasi.length, aktivasi_detail: detail.length },
    duplicate_removed: { registrasi: dupReg, aktivasi: dupAkt, aktivasi_detail_id: dupDetailId },
    // §X — audit Sudah Aktif/Belum Aktif (definisi RESMI FINAL: pure count).
    activation_active_source_count: current.active_outlets,
    registrations_count: current.registrations,
    active_vs_registration_gap: current.active_outlets - current.registrations,
    active_exceeds_registrations: current.active_exceeds_registrations,
    registrations_total: current.registrations,
    active_matched_outlets: current.active_outlets,
    inactive_unmatched_outlets: current.inactive_outlets,
    registration_activation_upline_mismatch: activationMatchQuality.registration_activation_upline_mismatch,
    activation_without_registration: activationMatchQuality.activation_without_registration,
    registration_without_activation: activationMatchQuality.registration_without_activation,
    registration_without_active_activation: current.inactive_outlets,
    active_inactive_partition_consistent: (current.active_outlets + current.inactive_outlets) === current.registrations,
    pb_active_exceeds_registrations_count: pb_scorecard.filter(r => r.data_quality_anomaly).length,
    low_sample_pb_count: lowSamplePbCount,
    segmentation_anomaly_count: segmentationAnomalyCount,
    // §X — audit NMAT.
    nmat_outlets: current.nmat_outlets,
    nmat_trx: current.nmat_trx,
    nmat_missing_activation_date: nmatQuality.nmat_missing_activation_date,
    nmat_invalid_activation_date: nmatQuality.nmat_invalid_activation_date,
    nmat_excluded_other_month: nmatQuality.nmat_excluded_other_month,
    nmat_excluded_zero_trx: nmatQuality.nmat_excluded_zero_trx,
    // Audit lama (DETAIL/AKTIVASI cross-check) — tidak berubah, konsern berbeda.
    registration_without_activation_or_detail: registrasi.filter(r => r.id_outlet && !detailByOutlet.has(r.id_outlet)).length,
    activation_without_detail: aktivasi.filter(a => a.id_outlet && !detailByOutlet.has(a.id_outlet)).length,
    detail_without_activation: detail.filter(d => d.id_outlet && !actByOutlet.has(d.id_outlet)).length,
    upline_mismatch_reg_vs_activation: uplineMismatchRegAkt,
    upline_mismatch_reg_vs_detail: uplineMismatchRegDetail,
    upline_mismatch_activation_vs_detail: uplineMismatchAktDetail,
    economics_formula_mismatch: economics.formula_mismatch.length,
    // Audit pemisahan revenue — toleransi floating point maksimal Rp0,01.
    transaction_revenue_source_rows: aktivasi.length,
    activation_revenue_source_rows: detail.length,
    transaction_revenue_total: current.transaction_revenue,
    activation_revenue_total: current.activation_revenue,
    mgm_revenue_total: current.mgm_revenue,
    revenue_formula_consistent: revenueFormulaDiff <= 0.01,
    qualified_conversion_min_reg: thresholds.qualified_conversion_min_reg,
  };

  return {
    summary: { current, previous, deltas },
    cohort_funnel,
    operational_volume,
    pb_scorecard,
    pb_matrix,
    segment_summary,
    opportunity_lists,
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
  computeActiveOutletsFromAktivasi,
  computeSudahAktif,
  computeActivationMatchQuality,
  computeActivationRevenue,
  computeTransactionInfo,
  isDateInPeriod,
  computeNmatDetails,
  computeNmatOutlets,
  computeNmatQuality,
  computeSummary,
  summaryDeltas,
  computeQualifiedConversionMinReg,
  computeOpportunitySegmentThresholds,
  classifyOpportunitySegment,
  SEGMENT_ACTION,
  buildPbScorecard,
  buildSegmentSummary,
  buildOpportunityLists,
  concentrationRisk,
  daysBetween,
  agingBucket,
  buildPeriodAnalytics,
  groupSum,
  distinctValues,
};
