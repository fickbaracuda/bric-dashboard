'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola seluruh test
// Balance Control Tower lain di project ini.
// Run: node backend/scripts/test-balance-control-tower-operational-engine.js
//
// Hanya mencakup logic PURE (tidak menyentuh DB): seluruh formula & cascade
// status di calculationEngine.js. Data access (fetchRecentMatchedOutflows,
// posisi rekonsiliasi live) diverifikasi end-to-end setelah deploy, sama
// seperti pola test balance-control-tower/rekonsiliasi lain.

const assert = require('assert');
const { STATUS } = require('../src/utils/balanceControlTower');
const {
  CALCULATION_VERSION,
  bucketOutflowsByWindow,
  selectOperationalBurnRate,
  computeUsableBalance,
  computeLeadTimeNeed,
  computeSafetyBufferAmount,
  computeSafeTargetBalance,
  computeRecommendedTopup,
  computeUsableRunwayMinutes,
  computeZeroBalanceRunwayMinutes,
  computeDeadlines,
  classifyOperationalStatus,
  buildOperationalCalculation,
} = require('../src/balanceControlTower/calculationEngine');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BANK = { id: 1, bank_code: 'OCBC', account_number: '050800487444 - IDR', account_name: 'PT. BIMASAKTI MULTI SINERGI' };
const BASE_POLICY = {
  absolute_minimum_balance: 200000000, burn_window_minutes: 15, topup_lead_time_minutes: 30,
  critical_margin_minutes: 15, watch_buffer_minutes: 30, safety_buffer_type: 'PERCENTAGE', safety_buffer_percentage: 20,
  topup_rounding_amount: 1000000, stale_after_minutes: 60,
};
function position(overrides = {}) {
  return {
    available_balance: 845077711, ledger_balance: 845077711, opening_balance: 424963361, closing_balance: 845077711,
    total_credit_amount: 7010255064, total_debit_amount: 6583281616,
    synced_at: new Date().toISOString(), source_table: 'recon_sync_batches.raw_summary', source_reference: '2026-07-29',
    ...overrides,
  };
}
function outflowRows(ratePerMinute, count, now) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push({ principal: ratePerMinute, fee: 0, matchedAt: new Date(now.getTime() - i * 60000) });
  return rows;
}

// ── FORMULAS ─────────────────────────────────────────────────────────────
test('computeUsableBalance: available - absolute_minimum, boleh negatif (tidak di-clamp)', () => {
  assert.strictEqual(computeUsableBalance({ availableBalance: 845077711, absoluteMinimumBalance: 200000000 }), 645077711);
  assert.strictEqual(computeUsableBalance({ availableBalance: 100000000, absoluteMinimumBalance: 200000000 }), -100000000);
});
test('computeLeadTimeNeed: burn_rate x lead_time_minutes', () => {
  assert.strictEqual(computeLeadTimeNeed({ burnRatePerMinute: 1000000, topupLeadTimeMinutes: 30 }), 30000000);
});
test('computeLeadTimeNeed: burn_rate 0 -> lead_time_need 0 (bukan error)', () => {
  assert.strictEqual(computeLeadTimeNeed({ burnRatePerMinute: 0, topupLeadTimeMinutes: 30 }), 0);
});
test('computeSafetyBufferAmount: mode FIXED -> nilai apa adanya, TIDAK terpengaruh lead_time_need', () => {
  const amt = computeSafetyBufferAmount({ safetyBufferType: 'FIXED', safetyBufferFixedAmount: 50000000, safetyBufferPercentage: 999, leadTimeNeed: 1000000 });
  assert.strictEqual(amt, 50000000);
});
test('computeSafetyBufferAmount: mode PERCENTAGE -> persentase dari lead_time_need', () => {
  const amt = computeSafetyBufferAmount({ safetyBufferType: 'PERCENTAGE', safetyBufferFixedAmount: 999999999, safetyBufferPercentage: 20, leadTimeNeed: 30000000 });
  assert.strictEqual(amt, 6000000);
});
test('computeSafetyBufferAmount: type null/tidak dikenal -> 0 (bukan dikarang)', () => {
  assert.strictEqual(computeSafetyBufferAmount({ safetyBufferType: null, leadTimeNeed: 1000000 }), 0);
  assert.strictEqual(computeSafetyBufferAmount({ safetyBufferType: 'UNKNOWN', leadTimeNeed: 1000000 }), 0);
});
test('computeSafetyBufferAmount: TIDAK PERNAH FIXED dan PERCENTAGE sekaligus (satu mode aktif)', () => {
  const fixedResult = computeSafetyBufferAmount({ safetyBufferType: 'FIXED', safetyBufferFixedAmount: 10000000, safetyBufferPercentage: 50, leadTimeNeed: 1000000 });
  assert.strictEqual(fixedResult, 10000000, 'mode FIXED tidak boleh ikut menghitung percentage sama sekali');
});
test('computeSafeTargetBalance: absolute_minimum + lead_time_need + safety_buffer, masing2 SATU KALI', () => {
  const target = computeSafeTargetBalance({ absoluteMinimumBalance: 200000000, leadTimeNeed: 30000000, safetyBufferAmount: 6000000 });
  assert.strictEqual(target, 236000000);
});
test('computeRecommendedTopup: raw = safe_target - available, clamp ke 0, dibulatkan SETELAH clamp', () => {
  const r1 = computeRecommendedTopup({ safeTargetBalance: 236000000, availableBalance: 100000000, topupRoundingAmount: 1000000 });
  assert.strictEqual(r1.raw_recommended_topup, 136000000);
  assert.strictEqual(r1.recommended_topup, 136000000);
});
test('computeRecommendedTopup: hasil negatif -> clamp ke 0, TIDAK PERNAH jadi top-up positif', () => {
  const r = computeRecommendedTopup({ safeTargetBalance: 236000000, availableBalance: 999999999999, topupRoundingAmount: 1000000 });
  assert.strictEqual(r.raw_recommended_topup < 0, true);
  assert.strictEqual(r.recommended_topup, 0);
});
test('computeRecommendedTopup: pembulatan ke atas terjadi SETELAH clamp (bukan pembulatan raw negatif)', () => {
  const r = computeRecommendedTopup({ safeTargetBalance: 100000001, availableBalance: 0, topupRoundingAmount: 1000000 });
  assert.strictEqual(r.recommended_topup, 101000000, 'dibulatkan ke atas ke kelipatan 1jt dari hasil clamp');
});
test('computeRecommendedTopup: topup_rounding_amount 0/null -> tidak dibulatkan', () => {
  const r = computeRecommendedTopup({ safeTargetBalance: 100000001, availableBalance: 0, topupRoundingAmount: 0 });
  assert.strictEqual(r.recommended_topup, 100000001);
});
test('computeUsableRunwayMinutes: usable_balance / burn_rate_per_minute', () => {
  assert.strictEqual(computeUsableRunwayMinutes({ usableBalance: 600000000, burnRatePerMinute: 1000000 }), 600);
});
test('computeUsableRunwayMinutes: burn_rate <= 0 -> null (BUKAN Infinity/NaN)', () => {
  assert.strictEqual(computeUsableRunwayMinutes({ usableBalance: 600000000, burnRatePerMinute: 0 }), null);
  assert.strictEqual(computeUsableRunwayMinutes({ usableBalance: 600000000, burnRatePerMinute: -5 }), null);
});
test('computeZeroBalanceRunwayMinutes: available_balance / burn_rate_per_minute', () => {
  assert.strictEqual(computeZeroBalanceRunwayMinutes({ availableBalance: 800000000, burnRatePerMinute: 1000000 }), 800);
});
test('computeZeroBalanceRunwayMinutes: usable_balance negatif TETAP dihitung (utk diagnosis)', () => {
  const usable = computeUsableBalance({ availableBalance: 100000000, absoluteMinimumBalance: 200000000 });
  assert.strictEqual(usable, -100000000);
});
test('computeDeadlines: breach = now + runway, deadline = breach - lead_time - safety_margin', () => {
  const now = new Date('2026-07-29T10:00:00.000Z');
  const { minimum_balance_breach_time, topup_deadline } = computeDeadlines({ now, usableRunwayMinutes: 120, topupLeadTimeMinutes: 30, operationalSafetyMarginMinutes: 10 });
  assert.strictEqual(minimum_balance_breach_time, '2026-07-29T12:00:00.000Z');
  assert.strictEqual(topup_deadline, '2026-07-29T11:20:00.000Z');
});
test('computeDeadlines: runway null (tidak ada outflow aktif) -> tidak ada deadline palsu', () => {
  const { minimum_balance_breach_time, topup_deadline } = computeDeadlines({ now: new Date(), usableRunwayMinutes: null, topupLeadTimeMinutes: 30, operationalSafetyMarginMinutes: 0 });
  assert.strictEqual(minimum_balance_breach_time, null);
  assert.strictEqual(topup_deadline, null);
});

// ── BURN WINDOW BUCKETING & ACCELERATION ────────────────────────────────
test('bucketOutflowsByWindow: 4 window standar selalu ada (5/15/30/60)', () => {
  const now = new Date();
  const windows = bucketOutflowsByWindow([], now);
  assert.deepStrictEqual(Object.keys(windows).map(Number).sort((a, b) => a - b), [5, 15, 30, 60]);
});
test('bucketOutflowsByWindow: window kosong (tidak ada transaksi) -> outflow 0, burn_rate 0 (bukan null/error)', () => {
  const now = new Date();
  const windows = bucketOutflowsByWindow([], now);
  assert.strictEqual(windows[15].total_window_outflow, 0);
  assert.strictEqual(windows[15].burn_rate_per_minute, 0);
});
test('bucketOutflowsByWindow: partial window (data lebih muda dari window) -> effective_window_minutes dikurangi, TIDAK dibagi window penuh', () => {
  const now = new Date();
  // hanya 1 baris, 2 menit lalu -- window 60 menit, tapi data cuma ada 2 menit ke belakang.
  const rows = [{ principal: 1000000, fee: 0, matchedAt: new Date(now.getTime() - 2 * 60000) }];
  const windows = bucketOutflowsByWindow(rows, now);
  assert.strictEqual(windows[60].effective_window_minutes, 2);
  assert.strictEqual(windows[60].burn_rate_per_minute, 500000); // 1jt / 2 menit, BUKAN 1jt/60menit
});
test('selectOperationalBurnRate: tanpa akselerasi -> pakai primary window apa adanya', () => {
  const now = new Date();
  const windows = bucketOutflowsByWindow(outflowRows(1000000, 15, now), now); // rate konstan di semua window
  const result = selectOperationalBurnRate({ windows, primaryWindowMinutes: 15 });
  assert.strictEqual(result.acceleration_detected, false);
  assert.strictEqual(result.trend, 'STABLE');
});
test('selectOperationalBurnRate: akselerasi terdeteksi -> rate 5 menit dipakai, di-cap maksimal 3x primary', () => {
  const now = new Date();
  // window 5 menit: burn SANGAT tinggi (10jt/menit); window 15/30/60 lebih rendah krn rata2 lebih tua.
  const rows = [
    ...outflowRows(10000000, 4, now), // 4 baris @ 10jt dalam 5 menit terakhir
  ];
  // primary 15 menit -- HANYA rows di atas ada (di dalam 5 menit), jadi rate 15 menit jadi rendah krn dibagi effective_window lebih pendek dari 15... untuk isolasi murni, uji cap-nya scr langsung:
  const windows = { 5: { burn_rate_per_minute: 10000000, matched_transaction_count: 4 }, 15: { burn_rate_per_minute: 1000000, matched_transaction_count: 4 } };
  const result = selectOperationalBurnRate({ windows, primaryWindowMinutes: 15 });
  assert.strictEqual(result.acceleration_detected, true);
  assert.strictEqual(result.applied_rate_per_minute, 3000000, 'di-cap ke 3x primary (3 x 1jt), BUKAN rate 5 menit mentah (10jt)');
});
test('selectOperationalBurnRate: window primary tidak ada -> tidak crash, applied_rate null', () => {
  const result = selectOperationalBurnRate({ windows: {}, primaryWindowMinutes: 15 });
  assert.strictEqual(result.applied_rate_per_minute, null);
});

// ── STATUS CASCADE (formula murni) ──────────────────────────────────────
function classify(overrides) {
  return classifyOperationalStatus({
    STATUS, availableBalance: 845077711, usableBalance: 645077711, burnRatePerMinute: 0,
    usableRunwayMinutes: null, zeroBalanceRunwayMinutes: null, topupLeadTimeMinutes: 30,
    criticalMarginMinutes: 15, watchBufferMinutes: 30, recommendedTopup: 0,
    ...overrides,
  });
}
test('WORKED EXAMPLE (spec): Rp845.077.711 dgn minimum Rp200.000.000, TANPA outflow aktif -> SAFE, BUKAN Emergency', () => {
  const r = classify({});
  assert.strictEqual(r.status, STATUS.SAFE);
});
test('historical daily burn TIDAK BISA memaksa Emergency sendirian -- burn_rate_per_minute=0 selalu berujung SAFE/CRITICAL(jika usable<=0), tidak pernah EMERGENCY-by-runway', () => {
  const r = classify({ burnRatePerMinute: 0, usableRunwayMinutes: null, zeroBalanceRunwayMinutes: null });
  assert.notStrictEqual(r.status, STATUS.EMERGENCY);
});
test('EMERGENCY: available_balance <= 0', () => {
  const r = classify({ availableBalance: -1000, usableBalance: -201000000 });
  assert.strictEqual(r.status, STATUS.EMERGENCY);
});
test('EMERGENCY: usable_balance <= 0 DAN masih ada outflow aktif', () => {
  const r = classify({ availableBalance: 200000000, usableBalance: 0, burnRatePerMinute: 1000000 });
  assert.strictEqual(r.status, STATUS.EMERGENCY);
});
test('CRITICAL (bukan EMERGENCY): usable_balance <= 0 TAPI TIDAK ada outflow aktif', () => {
  const r = classify({ availableBalance: 200000000, usableBalance: 0, burnRatePerMinute: 0 });
  assert.strictEqual(r.status, STATUS.CRITICAL);
});
test('EMERGENCY: zero_balance_runway <= lead_time (akan habis sebelum top-up masuk)', () => {
  const r = classify({ availableBalance: 220000000, usableBalance: 20000000, burnRatePerMinute: 10000000, zeroBalanceRunwayMinutes: 22, usableRunwayMinutes: 2 });
  assert.strictEqual(r.status, STATUS.EMERGENCY);
});
test('CRITICAL: usable_runway <= lead_time + critical_margin', () => {
  const r = classify({ burnRatePerMinute: 1000000, usableRunwayMinutes: 40, zeroBalanceRunwayMinutes: 300, topupLeadTimeMinutes: 30, criticalMarginMinutes: 15 });
  assert.strictEqual(r.status, STATUS.CRITICAL); // 40 <= 45
});
test('WATCH: usable_runway di atas critical tapi <= critical+watch_buffer', () => {
  const r = classify({ burnRatePerMinute: 1000000, usableRunwayMinutes: 60, zeroBalanceRunwayMinutes: 500, topupLeadTimeMinutes: 30, criticalMarginMinutes: 15, watchBufferMinutes: 30 });
  assert.strictEqual(r.status, STATUS.WATCH); // 45 < 60 <= 75
});
test('SAFE: usable_runway jauh di atas critical+watch_buffer', () => {
  const r = classify({ burnRatePerMinute: 100000, usableRunwayMinutes: 5000, zeroBalanceRunwayMinutes: 8000 });
  assert.strictEqual(r.status, STATUS.SAFE);
});
test('Rp200.000.000 minimum TIDAK PERNAH dihitung dua kali sbg reserve tambahan (hanya field absolute_minimum_balance yg dipakai di usable_balance)', () => {
  const usable = computeUsableBalance({ availableBalance: 845077711, absoluteMinimumBalance: 200000000 });
  const target = computeSafeTargetBalance({ absoluteMinimumBalance: 200000000, leadTimeNeed: 0, safetyBufferAmount: 0 });
  assert.strictEqual(usable, 645077711);
  assert.strictEqual(target, 200000000, 'safe_target TANPA outflow = persis absolute_minimum, tidak digandakan');
});

// ── ORKESTRASI PENUH (buildOperationalCalculation) ──────────────────────
test('buildOperationalCalculation: worked example produksi -> SAFE, calculation_version tercatat', () => {
  const now = new Date();
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: position(), freshness: 'FRESH', outflowRows: [], now });
  assert.strictEqual(out.operational_status, STATUS.SAFE);
  assert.strictEqual(out.calculation_version, CALCULATION_VERSION);
  assert.strictEqual(out.usable_balance, 645077711);
  assert.strictEqual(out.recommended_topup, 0);
});
test('buildOperationalCalculation: posisi tidak tersedia -> CONFIGURATION_REQUIRED', () => {
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: null, freshness: 'UNAVAILABLE', outflowRows: [], now: new Date() });
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
});
test('buildOperationalCalculation: freshness STALE -> DATA_STALE, TIDAK menampilkan deadline meyakinkan', () => {
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: position(), freshness: 'STALE', outflowRows: [], now: new Date() });
  assert.strictEqual(out.operational_status, STATUS.DATA_STALE);
  // Kalkulasi parsial (revisi): field ini SELALU ada di payload (schema
  // konsisten), null berarti "tidak ada deadline" -- sama artinya dgn
  // undefined di versi sebelumnya, TIDAK menampilkan deadline meyakinkan.
  assert.strictEqual(out.topup_deadline, null);
});
test('buildOperationalCalculation: policy tidak lengkap (burn_window_minutes null) -> CONFIGURATION_REQUIRED', () => {
  const incompletePolicy = { ...BASE_POLICY, burn_window_minutes: null };
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: incompletePolicy, position: position(), freshness: 'FRESH', outflowRows: [], now: new Date() });
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
  assert.ok(out.status_reason.includes('burn_window_minutes'));
});
test('buildOperationalCalculation: policy null sama sekali -> CONFIGURATION_REQUIRED', () => {
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: null, position: position(), freshness: 'FRESH', outflowRows: [], now: new Date() });
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
});
test('buildOperationalCalculation: movement variance terdeteksi TAPI available_balance TIDAK PERNAH ditimpa', () => {
  const now = new Date();
  const pos = position({ opening_balance: 100000000, total_credit_amount: 500000000, total_debit_amount: 100000000, available_balance: 845077711 });
  // computed movement = 100jt+500jt-100jt = 500jt, available=845.077.711 -> variance besar
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: [], now });
  assert.strictEqual(out.available_balance, 845077711, 'available_balance TETAP dari posisi rekonsiliasi, TIDAK diganti hasil movement');
  assert.ok(out.movement_variance, 'variance harus terdeteksi & dilaporkan');
  assert.strictEqual(out.warnings.includes('MOVEMENT_VARIANCE_DETECTED'), true);
});
test('buildOperationalCalculation: EMERGENCY nyata dgn outflow tinggi & saldo kecil', () => {
  const now = new Date();
  const pos = position({ available_balance: 220000000 });
  const rows = outflowRows(10000000, 15, now); // Rp10jt/menit selama 15 menit
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out.operational_status, STATUS.EMERGENCY);
  assert.ok(out.recommended_topup > 0);
});
test('buildOperationalCalculation: dua panggilan dgn input IDENTIK -> hasil status/topup IDENTIK (deterministik, konsisten lintas endpoint)', () => {
  const now = new Date('2026-07-29T10:00:00.000Z');
  const pos = position();
  const rows = outflowRows(1000000, 10, now);
  const out1 = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: rows, now });
  const out2 = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out1.operational_status, out2.operational_status);
  assert.strictEqual(out1.recommended_topup, out2.recommended_topup);
  assert.strictEqual(out1.usable_runway_minutes, out2.usable_runway_minutes);
});

// ── PARTIAL CALCULATION (revisi wajib item 1) ───────────────────────────
test('partial calc: burn_window_minutes & topup_lead_time_minutes null -> absolute_minimum/usable_balance TETAP tampil (bukan blank)', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: 200000000, burn_window_minutes: null, topup_lead_time_minutes: null };
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: [], now });
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
  assert.strictEqual(out.available_balance, 845077711);
  assert.strictEqual(out.absolute_minimum_balance, 200000000, 'minimum HARUS tampil walau burn_window/lead_time belum dikonfigurasi');
  assert.strictEqual(out.usable_balance, 645077711, 'usable_balance HARUS tampil (available - minimum), tidak menunggu burn_window/lead_time');
  assert.strictEqual(out.missing_configuration.includes('burn_window_minutes'), true);
  assert.strictEqual(out.missing_configuration.includes('topup_lead_time_minutes'), true);
});
test('partial calc: absolute_minimum_balance null -> minimum & usable_balance null DENGAN alasan eksplisit (bukan angka dikarang)', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: null, burn_window_minutes: 15, topup_lead_time_minutes: 30 };
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: [], now });
  assert.strictEqual(out.absolute_minimum_balance, null);
  assert.strictEqual(out.usable_balance, null);
  assert.ok(out.absolute_minimum_balance_unavailable_reason);
  assert.ok(out.usable_balance_unavailable_reason);
});
test('partial calc: 5/15/30/60 window outflow SELALU tampil dari outflowRows, independen dari burn_window_minutes policy', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: 200000000, burn_window_minutes: null, topup_lead_time_minutes: null };
  const rows = outflowRows(1000000, 10, now); // 10 baris 1 menit terakhir -> masuk window 15/30/60, sebagian ke window 5
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: rows, now });
  assert.ok(out.burn_rate_per_5_minutes > 0, 'window mentah 5 menit harus tetap terisi walau burn_window_minutes belum dikonfigurasi');
  assert.ok(out.burn_rate_per_15_minutes > 0);
  assert.ok(out.burn_rate_per_30_minutes > 0);
  assert.ok(out.burn_rate_per_60_minutes > 0);
});
test('partial calc: TIDAK ADA fallback/estimasi non-final utk selected burn rate & runway -- keduanya tetap null total kalau burn_window_minutes belum diisi', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: 200000000, burn_window_minutes: null, topup_lead_time_minutes: 30 };
  const rows = outflowRows(1000000, 10, now);
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out.selected_burn_window_minutes, null);
  assert.strictEqual(out.burn_rate_per_minute, null, 'tidak boleh diam-diam pakai window lain sbg pengganti');
  assert.strictEqual(out.usable_runway_minutes, null, 'runway tidak boleh muncul non-final/estimasi tanpa burn_window_minutes eksplisit');
  assert.ok(out.burn_rate_unavailable_reason);
  assert.ok(out.runway_unavailable_reason);
});
test('partial calc: recommended_topup & topup_deadline tetap unavailable kalau topup_lead_time_minutes belum diisi, walau burn_window sudah ada', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: 200000000, burn_window_minutes: 15, topup_lead_time_minutes: null };
  const rows = outflowRows(1000000, 10, now);
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out.recommended_topup, null);
  assert.strictEqual(out.topup_deadline, null);
  assert.ok(out.recommended_topup_unavailable_reason.includes('lead time') || out.recommended_topup_unavailable_reason.includes('top-up lead time'));
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
});
test('partial calc: policy lengkap penuh -> tidak ada field yang unavailable_reason terisi (semua kosong/null)', () => {
  const now = new Date();
  const rows = outflowRows(100000, 5, now);
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: position(), freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out.operational_status === STATUS.CONFIGURATION_REQUIRED, false);
  assert.strictEqual(out.absolute_minimum_balance_unavailable_reason, null);
  assert.strictEqual(out.usable_balance_unavailable_reason, null);
  assert.strictEqual(out.burn_rate_unavailable_reason, null);
});

// ── today_usage (item 4) ────────────────────────────────────────────────
test('today_usage: dilewatkan apa adanya dari caller, independen dari policy (tampil walau CONFIGURATION_REQUIRED)', () => {
  const now = new Date();
  const policy = { absolute_minimum_balance: 200000000, burn_window_minutes: null, topup_lead_time_minutes: null };
  const todayUsage = {
    business_date: '2026-07-29', matched_principal_outflow_today: 6000000000, verified_fee_outflow_today: 5000000,
    other_verified_operational_outflow_today: 0, total_bank_debit_today: 6583281616, unmatched_or_anomaly_debit_today: 578281616,
  };
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy, position: position(), freshness: 'FRESH', outflowRows: [], todayUsage, now });
  assert.strictEqual(out.operational_status, STATUS.CONFIGURATION_REQUIRED);
  assert.deepStrictEqual(out.today_usage, todayUsage, 'today_usage tidak boleh ikut kosong hanya karena policy belum lengkap');
});

// ── FORMULA AUDIT (item 9) ──────────────────────────────────────────────
test('formula audit: confirmed_incoming_not_yet_reflected selalu 0, TIDAK mengurangi recommended_topup pada rilis ini', () => {
  const now = new Date();
  const pos = position({ available_balance: 220000000 });
  const rows = outflowRows(10000000, 15, now);
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: rows, now });
  assert.strictEqual(out.confirmed_incoming_not_yet_reflected, 0);
  // Formula manual: safe_target - available - confirmed_incoming(0) == recommended_topup (sebelum rounding/clamp check terpisah)
  const expectedRaw = out.safe_target_balance - pos.available_balance - 0;
  assert.strictEqual(out.raw_recommended_topup, round2(expectedRaw));
});
test('formula audit: reserve historis (balanceForecast.js) TIDAK PERNAH masuk ke formula recommended_topup operasional -- safe_target_balance hanya absolute_minimum+lead_time_need+safety_buffer, masing2 SATU KALI', () => {
  const now = new Date();
  const pos = position({ available_balance: 220000000 });
  const rows = outflowRows(10000000, 15, now);
  const out = buildOperationalCalculation({ STATUS, bank: BANK, policy: BASE_POLICY, position: pos, freshness: 'FRESH', outflowRows: rows, now });
  const manualSafeTarget = round2(BASE_POLICY.absolute_minimum_balance + out.lead_time_need + out.safety_buffer_amount);
  assert.strictEqual(out.safe_target_balance, manualSafeTarget, 'tidak ada komponen reserve dinamis historis yang ikut ditambahkan');
});
function round2(n) { return Math.round(n * 100) / 100; }

// ── Runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${tests.length} total)`);
process.exit(fail ? 1 : 0);
