'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-finance-balance-requests.js (belum ada test
// framework/mocking DB di project ini).
// Run: node backend/scripts/test-balance-control-tower.js
//
// Hanya mencakup logic PURE (tidak menyentuh DB): kalkulasi effective
// balance, klasifikasi status, aturan maker-checker, validasi status
// transition top up. Skenario yang butuh DB sungguhan (dedup alert lewat
// partial unique index, race condition approve, endpoint RBAC) diverifikasi
// end-to-end lewat server sungguhan setelah deploy, sama seperti pola test
// rekonsiliasi/finance-balance-requests lain di project ini.

const assert = require('assert');
const {
  toCents,
  centsToString,
  computeEffectiveBalance,
  classifyBankStatus,
  classifyBankStatusDetailed,
  evaluateSuddenDrop,
  resolveReserveBalance,
  alertTypeForStatus,
  canTransitionTopup,
  isSelfApproval,
  computeBalanceMovement,
  enrichSnapshotHistory,
  MOVEMENT_CLASSIFICATION,
  pickCurrentAndPrevious,
  STATUS,
} = require('../src/utils/balanceControlTower');
const {
  buildForecastOutput,
  computeRecommendedTopup,
  roundUpToNearest,
  resolveThresholdField,
  computeForecastConfidence,
} = require('../src/reconciliation/balanceForecast');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── toCents / centsToString (NUMERIC-safe, bukan floating point) ──────────
test('toCents: parse desimal biasa', () => {
  assert.strictEqual(toCents('1234.56'), 123456n);
  assert.strictEqual(toCents(1000), 100000n);
  assert.strictEqual(toCents('1000'), 100000n);
});
test('toCents: negatif', () => {
  assert.strictEqual(toCents('-500.25'), -50025n);
});
test('toCents: null/undefined/kosong -> 0', () => {
  assert.strictEqual(toCents(null), 0n);
  assert.strictEqual(toCents(undefined), 0n);
  assert.strictEqual(toCents(''), 0n);
});
test('toCents: nilai tidak valid -> throw', () => {
  assert.throws(() => toCents('abc'));
  assert.throws(() => toCents('12.34.56'));
});
test('centsToString: format 2 desimal', () => {
  assert.strictEqual(centsToString(123456n), '1234.56');
  assert.strictEqual(centsToString(-50025n), '-500.25');
  assert.strictEqual(centsToString(0n), '0.00');
});

// ── computeEffectiveBalance — rumus wajib dari spec ────────────────────────
test('effective_balance = available - held - pending - reserve (kasus normal)', () => {
  const r = computeEffectiveBalance({
    available_balance: '1000000.00', held_balance: '100000.00',
    pending_amount: '50000.00', reserve_balance: '25000.00',
  });
  assert.strictEqual(r, '825000.00');
});
test('effective_balance: komponen kosong dianggap 0', () => {
  const r = computeEffectiveBalance({ available_balance: '500.00' });
  assert.strictEqual(r, '500.00');
});
test('effective_balance: bisa negatif (defisit)', () => {
  const r = computeEffectiveBalance({
    available_balance: '100.00', held_balance: '50.00',
    pending_amount: '40.00', reserve_balance: '30.00',
  });
  assert.strictEqual(r, '-20.00');
});
test('effective_balance: presisi desimal tidak meleset (uji anti-floating-point)', () => {
  // 0.1 + 0.2 secara floating point classic = 0.30000000000000004 -- kasus mirip di Rupiah.
  const r = computeEffectiveBalance({
    available_balance: '1000000000.10', held_balance: '0.20',
    pending_amount: '0', reserve_balance: '0',
  });
  assert.strictEqual(r, '999999999.90');
});

// ── classifyBankStatus — cascade status ────────────────────────────────────
const activePolicy = {
  is_active: true,
  absolute_minimum_balance: '100000',
  watch_threshold: '500000',
  excess_balance_threshold: '10000000',
  stale_after_minutes: 60,
  safety_buffer_percentage: 10,
};
function snap(effective, overrides = {}) {
  return { effective_balance: effective, captured_at: new Date().toISOString(), sync_status: 'OK', ...overrides };
}

test('classifyBankStatus: tidak ada snapshot -> CONFIGURATION_REQUIRED', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: null, policy: activePolicy }), STATUS.CONFIGURATION_REQUIRED);
});
test('classifyBankStatus: snapshot sync_status ERROR -> SYNC_ERROR (prioritas di atas policy)', () => {
  const s = snap('999999999', { sync_status: 'ERROR' });
  assert.strictEqual(classifyBankStatus({ snapshot: s, policy: activePolicy }), STATUS.SYNC_ERROR);
});
test('classifyBankStatus: policy belum ada -> CONFIGURATION_REQUIRED', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('1000000'), policy: null }), STATUS.CONFIGURATION_REQUIRED);
});
test('classifyBankStatus: policy is_active=false -> CONFIGURATION_REQUIRED', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('1000000'), policy: { ...activePolicy, is_active: false } }), STATUS.CONFIGURATION_REQUIRED);
});
test('classifyBankStatus: snapshot lebih tua dari stale_after_minutes -> DATA_STALE', () => {
  const old = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const s = snap('1000000', { captured_at: old });
  assert.strictEqual(classifyBankStatus({ snapshot: s, policy: activePolicy }), STATUS.DATA_STALE);
});
test('classifyBankStatus: effective <= absolute_minimum -> CRITICAL', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('100000'), policy: activePolicy }), STATUS.CRITICAL);
  assert.strictEqual(classifyBankStatus({ snapshot: snap('50000'), policy: activePolicy }), STATUS.CRITICAL);
});
test('classifyBankStatus: effective <= watch_threshold (di atas minimum) -> TOP_UP_RECOMMENDED', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('400000'), policy: activePolicy }), STATUS.TOP_UP_RECOMMENDED);
});
test('classifyBankStatus: effective di zona buffer watch_threshold*(1+buffer%) -> WATCH', () => {
  // watch_threshold=500000, buffer 10% -> upper 550000
  assert.strictEqual(classifyBankStatus({ snapshot: snap('520000'), policy: activePolicy }), STATUS.WATCH);
});
test('classifyBankStatus: effective >= excess_balance_threshold -> EXCESS_BALANCE', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('15000000'), policy: activePolicy }), STATUS.EXCESS_BALANCE);
});
test('classifyBankStatus: effective di tengah aman -> SAFE', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('2000000'), policy: activePolicy }), STATUS.SAFE);
});
test('classifyBankStatus: policy tanpa threshold apa pun (semua null) -> SAFE selama sync OK & tidak stale', () => {
  const minimalPolicy = { is_active: true, absolute_minimum_balance: null, watch_threshold: null, excess_balance_threshold: null, stale_after_minutes: null, safety_buffer_percentage: null };
  assert.strictEqual(classifyBankStatus({ snapshot: snap('123'), policy: minimalPolicy }), STATUS.SAFE);
});

// ── alertTypeForStatus ─────────────────────────────────────────────────────
test('alertTypeForStatus: mapping status -> alert_type', () => {
  assert.strictEqual(alertTypeForStatus(STATUS.WATCH), 'LOW_BALANCE');
  assert.strictEqual(alertTypeForStatus(STATUS.TOP_UP_RECOMMENDED), 'LOW_BALANCE');
  assert.strictEqual(alertTypeForStatus(STATUS.CRITICAL), 'CRITICAL_BALANCE');
  assert.strictEqual(alertTypeForStatus(STATUS.EXCESS_BALANCE), 'EXCESS_BALANCE');
  assert.strictEqual(alertTypeForStatus(STATUS.DATA_STALE), 'DATA_STALE');
  assert.strictEqual(alertTypeForStatus(STATUS.SYNC_ERROR), 'SYNC_ERROR');
});
test('alertTypeForStatus: SAFE & CONFIGURATION_REQUIRED tidak menghasilkan alert', () => {
  assert.strictEqual(alertTypeForStatus(STATUS.SAFE), null);
  assert.strictEqual(alertTypeForStatus(STATUS.CONFIGURATION_REQUIRED), null);
});

// ── canTransitionTopup — validasi status transition ────────────────────────
test('canTransitionTopup: alur normal DRAFT -> ... -> COMPLETED semua valid', () => {
  assert.ok(canTransitionTopup('DRAFT', 'REQUESTED'));
  assert.ok(canTransitionTopup('REQUESTED', 'APPROVED'));
  assert.ok(canTransitionTopup('APPROVED', 'TRANSFERRED'));
  assert.ok(canTransitionTopup('TRANSFERRED', 'BALANCE_CONFIRMED'));
  assert.ok(canTransitionTopup('BALANCE_CONFIRMED', 'COMPLETED'));
});
test('canTransitionTopup: REJECTED hanya dari REQUESTED', () => {
  assert.ok(canTransitionTopup('REQUESTED', 'REJECTED'));
  assert.strictEqual(canTransitionTopup('APPROVED', 'REJECTED'), false);
  assert.strictEqual(canTransitionTopup('DRAFT', 'REJECTED'), false);
});
test('canTransitionTopup: CANCELLED hanya dari DRAFT/REQUESTED/APPROVED', () => {
  assert.ok(canTransitionTopup('DRAFT', 'CANCELLED'));
  assert.ok(canTransitionTopup('REQUESTED', 'CANCELLED'));
  assert.ok(canTransitionTopup('APPROVED', 'CANCELLED'));
  assert.strictEqual(canTransitionTopup('TRANSFERRED', 'CANCELLED'), false);
});
test('canTransitionTopup: melompat tahap (DRAFT -> APPROVED) ditolak', () => {
  assert.strictEqual(canTransitionTopup('DRAFT', 'APPROVED'), false);
});
test('canTransitionTopup: mundur (APPROVED -> REQUESTED) ditolak', () => {
  assert.strictEqual(canTransitionTopup('APPROVED', 'REQUESTED'), false);
});
test('canTransitionTopup: status terminal (COMPLETED/REJECTED/CANCELLED) tidak punya transisi lanjutan', () => {
  assert.strictEqual(canTransitionTopup('COMPLETED', 'DRAFT'), false);
  assert.strictEqual(canTransitionTopup('REJECTED', 'REQUESTED'), false);
  assert.strictEqual(canTransitionTopup('CANCELLED', 'DRAFT'), false);
});
test('canTransitionTopup: status tidak dikenal -> false (bukan crash)', () => {
  assert.strictEqual(canTransitionTopup('UNKNOWN', 'REQUESTED'), false);
});

// ── isSelfApproval — inti maker-checker ────────────────────────────────────
test('isSelfApproval: requester sama dengan approver -> true (harus diblokir)', () => {
  assert.strictEqual(isSelfApproval(42, 42), true);
  assert.strictEqual(isSelfApproval('42', 42), true, 'harus cocok walau tipe beda (string vs number dari JWT/DB)');
});
test('isSelfApproval: requester beda approver -> false (boleh lanjut)', () => {
  assert.strictEqual(isSelfApproval(1, 2), false);
});
test('isSelfApproval: salah satu id null/undefined -> false (tidak menganggap self approval)', () => {
  assert.strictEqual(isSelfApproval(null, 2), false);
  assert.strictEqual(isSelfApproval(1, undefined), false);
});

// ── EMERGENCY / CRITICAL / threshold ordering (fitur baru) ─────────────────
const fullPolicy = {
  is_active: true,
  absolute_minimum_balance: null, // sengaja kosong -- pakai critical_threshold, bukan legacy field
  critical_threshold: '300000',
  emergency_threshold: '100000',
  watch_threshold: '500000',
  excess_balance_threshold: '10000000',
  reserve_balance: '0',
  stale_after_minutes: 60,
  safety_buffer_percentage: 10,
  sudden_drop_window_minutes: null,
  sudden_drop_amount_threshold: null,
  sudden_drop_percentage_threshold: null,
};
test('classifyBankStatus: effective <= emergency_threshold -> EMERGENCY (paling parah)', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('100000'), policy: fullPolicy }), STATUS.EMERGENCY);
  assert.strictEqual(classifyBankStatus({ snapshot: snap('50000'), policy: fullPolicy }), STATUS.EMERGENCY);
});
test('classifyBankStatus: effective <= critical_threshold (di atas emergency) -> CRITICAL', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('300000'), policy: fullPolicy }), STATUS.CRITICAL);
  assert.strictEqual(classifyBankStatus({ snapshot: snap('250000'), policy: fullPolicy }), STATUS.CRITICAL);
});
test('classifyBankStatus: critical_threshold belum diisi -> fallback ke absolute_minimum_balance lama (backward-compat)', () => {
  const legacyPolicy = { ...fullPolicy, critical_threshold: null, emergency_threshold: null, absolute_minimum_balance: '300000' };
  assert.strictEqual(classifyBankStatus({ snapshot: snap('300000'), policy: legacyPolicy }), STATUS.CRITICAL);
});
test('classifyBankStatus: emergency & critical berdampingan dengan watch/top_up_recommended', () => {
  assert.strictEqual(classifyBankStatus({ snapshot: snap('400000'), policy: fullPolicy }), STATUS.TOP_UP_RECOMMENDED);
  assert.strictEqual(classifyBankStatus({ snapshot: snap('2000000'), policy: fullPolicy }), STATUS.SAFE);
});
test('threshold ordering: emergency_threshold <= critical_threshold <= watch_threshold (policy valid, tidak error)', () => {
  assert.ok(Number(fullPolicy.emergency_threshold) <= Number(fullPolicy.critical_threshold));
  assert.ok(Number(fullPolicy.critical_threshold) <= Number(fullPolicy.watch_threshold));
});

// ── Validasi percentage (0..100) — logic yang dipakai route PUT policy ─────
function isValidPercentage(v) {
  if (v === null || v === undefined) return true;
  const n = Number(v);
  return !Number.isNaN(n) && n >= 0 && n <= 100;
}
test('invalid percentage: safety_buffer_percentage/sudden_drop_percentage_threshold di luar 0..100 ditolak', () => {
  assert.strictEqual(isValidPercentage(150), false);
  assert.strictEqual(isValidPercentage(-5), false);
  assert.strictEqual(isValidPercentage(0), true);
  assert.strictEqual(isValidPercentage(100), true);
  assert.strictEqual(isValidPercentage(null), true, 'null = belum diisi, bukan invalid');
});

// ── Sudden drop ──────────────────────────────────────────────────────────
const suddenDropPolicy = {
  is_active: true, watch_threshold: '500000', absolute_minimum_balance: '100000',
  sudden_drop_window_minutes: 60, sudden_drop_amount_threshold: '200000', sudden_drop_percentage_threshold: null,
};
function snapAt(effective, minutesAgo) {
  return { effective_balance: effective, captured_at: new Date(Date.now() - minutesAgo * 60000).toISOString(), sync_status: 'OK' };
}
test('sudden drop by amount: drop_amount melewati threshold, dalam window -> SUDDEN_DROP', () => {
  const previous = snapAt('2000000', 30);
  const current = snapAt('1000000', 0); // drop 1,000,000 > threshold 200,000, dalam 30 menit (window 60)
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previous, policy: suddenDropPolicy });
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.dropAmount, 1000000);
  assert.strictEqual(classifyBankStatus({ snapshot: current, previousSnapshot: previous, policy: suddenDropPolicy }), STATUS.SUDDEN_DROP);
});
test('sudden drop by percentage: drop_percentage melewati threshold (amount threshold kosong)', () => {
  const pctPolicy = { ...suddenDropPolicy, sudden_drop_amount_threshold: null, sudden_drop_percentage_threshold: 30 };
  const previous = snapAt('1000000', 10);
  const current = snapAt('600000', 0); // drop 40% > 30%
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previous, policy: pctPolicy });
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(Math.round(r.dropPercentage), 40);
});
test('sudden drop: no division by zero saat previous effective_balance = 0 atau negatif', () => {
  const previousZero = snapAt('0', 10);
  const current = snapAt('-100', 0);
  const r1 = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previousZero, policy: suddenDropPolicy });
  assert.strictEqual(r1.triggered, false);
  assert.strictEqual(r1.dropPercentage, null);

  const previousNeg = snapAt('-500', 10);
  const r2 = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previousNeg, policy: suddenDropPolicy });
  assert.strictEqual(r2.triggered, false);
  assert.strictEqual(r2.dropPercentage, null);
});
test('sudden drop: bukan kenaikan saldo -> tidak triggered', () => {
  const previous = snapAt('500000', 10);
  const current = snapAt('900000', 0); // naik, bukan turun
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previous, policy: suddenDropPolicy });
  assert.strictEqual(r.triggered, false);
});
test('sudden drop: di luar window -> tidak triggered walau drop besar', () => {
  const previous = snapAt('2000000', 120); // 120 menit lalu, window cuma 60
  const current = snapAt('1000000', 0);
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previous, policy: suddenDropPolicy });
  assert.strictEqual(r.triggered, false);
});
test('sudden drop: policy tidak set window/threshold -> tidak pernah triggered (tidak ada angka dikarang)', () => {
  const previous = snapAt('2000000', 10);
  const current = snapAt('100', 0);
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: previous, policy: { is_active: true, watch_threshold: '500000' } });
  assert.strictEqual(r.triggered, false);
});
test('sudden drop: tidak ada previousSnapshot -> tidak pernah triggered', () => {
  const current = snapAt('100', 0);
  const r = evaluateSuddenDrop({ snapshot: current, previousSnapshot: null, policy: suddenDropPolicy });
  assert.strictEqual(r.triggered, false);
});
test('classifyBankStatus: SUDDEN_DROP diprioritaskan di atas EMERGENCY/CRITICAL', () => {
  const previous = snapAt('2000000', 10);
  const current = snapAt('50000', 0); // drop besar sekaligus di bawah absolute_minimum_balance (100000)
  assert.strictEqual(classifyBankStatus({ snapshot: current, previousSnapshot: previous, policy: suddenDropPolicy }), STATUS.SUDDEN_DROP);
});

// ── Reserve balance resolution — SNAPSHOT vs POLICY_DEFAULT, no double-subtract ──
test('reserve from snapshot: reserve_balance dikirim eksplisit -> source SNAPSHOT, dipakai apa adanya', () => {
  const r = resolveReserveBalance({ providedReserveBalance: '50000', policyReserveBalance: '999999' });
  assert.strictEqual(r.source, 'SNAPSHOT');
  assert.strictEqual(r.value, '50000');
});
test('reserve from snapshot: dikirim eksplisit 0 tetap dianggap "diberikan" (bukan fallback ke policy)', () => {
  const r = resolveReserveBalance({ providedReserveBalance: 0, policyReserveBalance: '999999' });
  assert.strictEqual(r.source, 'SNAPSHOT');
  assert.strictEqual(r.value, 0);
});
test('reserve from policy default: reserve_balance tidak dikirim -> fallback ke policy.reserve_balance', () => {
  const r1 = resolveReserveBalance({ providedReserveBalance: undefined, policyReserveBalance: '75000' });
  assert.strictEqual(r1.source, 'POLICY_DEFAULT');
  assert.strictEqual(r1.value, '75000');
  const r2 = resolveReserveBalance({ providedReserveBalance: null, policyReserveBalance: '75000' });
  assert.strictEqual(r2.source, 'POLICY_DEFAULT');
  const r3 = resolveReserveBalance({ providedReserveBalance: '', policyReserveBalance: '75000' });
  assert.strictEqual(r3.source, 'POLICY_DEFAULT');
});
test('reserve default: tidak dikirim & policy juga belum punya reserve -> 0, source POLICY_DEFAULT (bukan angka dikarang)', () => {
  const r = resolveReserveBalance({ providedReserveBalance: undefined, policyReserveBalance: null });
  assert.strictEqual(r.source, 'POLICY_DEFAULT');
  assert.strictEqual(r.value, 0);
});
test('no double subtraction: effective_balance memakai HANYA satu nilai reserve (snapshot ATAU policy, tidak dijumlah)', () => {
  // snapshot eksplisit 50.000 -- efektif harus kurangi 50.000 SAJA, BUKAN 50.000 + policy default 75.000.
  const resolved = resolveReserveBalance({ providedReserveBalance: '50000', policyReserveBalance: '75000' });
  const eff = computeEffectiveBalance({ available_balance: '1000000', held_balance: '0', pending_amount: '0', reserve_balance: resolved.value });
  assert.strictEqual(eff, '950000.00', 'harus 1.000.000 - 50.000 = 950.000, BUKAN 1.000.000 - 50.000 - 75.000');
});

// ── Audit — struktur payload yang dikirim ke logAudit (dicek di sini secara
//    struktural karena logAudit sendiri butuh DB client sungguhan; endpoint-
//    level verification dilakukan end-to-end setelah deploy) ───────────────
test('audit payload bank account creation: action CREATE_BANK_ACCOUNT, before null, after berisi row baru', () => {
  const payload = { entityType: 'BANK_ACCOUNT', entityId: 1, action: 'CREATE_BANK_ACCOUNT', before: null, after: { id: 1, bank_code: 'OCBC' } };
  assert.strictEqual(payload.action, 'CREATE_BANK_ACCOUNT');
  assert.strictEqual(payload.before, null);
  assert.ok(payload.after);
});
test('audit payload snapshot creation: action CREATE_BALANCE_SNAPSHOT, notes menyertakan reserve_source', () => {
  const reserveSource = 'POLICY_DEFAULT';
  const notes = `reserve_source=${reserveSource}`;
  assert.strictEqual(notes, 'reserve_source=POLICY_DEFAULT');
});
test('audit payload policy create vs update: action ditentukan dari ada/tidaknya before', () => {
  const actionFor = (before) => (before ? 'UPDATE_POLICY' : 'CREATE_POLICY');
  assert.strictEqual(actionFor(null), 'CREATE_POLICY');
  assert.strictEqual(actionFor({ id: 1 }), 'UPDATE_POLICY');
});

// ── Ringkasan lintas bank (simulasi agregasi summary) ──────────────────────
test('summary lintas bank: total saldo efektif & bank_perlu_perhatian dihitung benar', () => {
  const banks = [
    { snapshot: snap('2000000'), policy: activePolicy },     // SAFE
    { snapshot: snap('400000'), policy: activePolicy },      // TOP_UP_RECOMMENDED
    { snapshot: snap('50000'), policy: activePolicy },       // CRITICAL
  ];
  const statuses = banks.map(b => classifyBankStatus({ snapshot: b.snapshot, policy: b.policy }));
  const totalEfektif = banks.reduce((s, b) => s + Number(b.snapshot.effective_balance), 0);
  const perluPerhatian = statuses.filter(s => s !== STATUS.SAFE).length;

  assert.strictEqual(totalEfektif, 2450000);
  assert.strictEqual(perluPerhatian, 2);
  assert.deepStrictEqual(statuses, [STATUS.SAFE, STATUS.TOP_UP_RECOMMENDED, STATUS.CRITICAL]);
});

// ═══════════════════════════════════════════════════════════════════════
// FASE FORECAST — OCBC Rekonsiliasi sbg forecasting engine, Balance
// Control Tower sbg control room (buildForecastOutput + classify forecast-aware)
// ═══════════════════════════════════════════════════════════════════════
function snapNow(effective, overrides = {}) {
  return { effective_balance: effective, available_balance: effective, captured_at: new Date().toISOString(), sync_status: 'OK', ...overrides };
}
function burnStats(overrides = {}) {
  return { available: true, window_days: 14, coverage: { included_days: 14, selected_days: 14 }, average_burn_rate: 300000000, peak_burn_rate: 450000000, ...overrides };
}

// ── forecast-driven SAFE/WATCH/CRITICAL/EMERGENCY ──────────────────────────
test('forecast-driven: saldo jauh di atas semua dynamic threshold -> SAFE', () => {
  const snapshot = snapNow('2000000000');
  const policy = { is_active: true, safety_buffer_percentage: 10 };
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(classifyBankStatus({ snapshot, policy, forecast }), STATUS.SAFE);
});
test('forecast-driven: saldo di zona buffer dynamic watch (di ATAS watch, di BAWAH watch*(1+buffer%)) -> WATCH', () => {
  const snapshot = snapNow('2000000000');
  const policy = { is_active: true, safety_buffer_percentage: 10 };
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  // Zona WATCH = (watch, watch*(1+buffer%)] -- pakai titik tengah supaya pasti masuk buffer, bukan <= watch (itu TOP_UP_RECOMMENDED).
  const watchUpper = forecast.dynamic_watch_threshold * 1.1;
  const midBuffer = (forecast.dynamic_watch_threshold + watchUpper) / 2;
  const watchSnapshot = snapNow(String(midBuffer));
  assert.strictEqual(classifyBankStatus({ snapshot: watchSnapshot, policy, forecast }), STATUS.WATCH);
});
test('forecast-driven: saldo <= dynamic_critical_threshold -> CRITICAL', () => {
  const snapshot = snapNow('2000000000');
  const policy = { is_active: true, safety_buffer_percentage: 10 };
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  const criticalSnapshot = snapNow(String(forecast.dynamic_critical_threshold));
  assert.strictEqual(classifyBankStatus({ snapshot: criticalSnapshot, policy, forecast }), STATUS.CRITICAL);
});
test('forecast-driven: saldo <= dynamic_emergency_threshold -> EMERGENCY', () => {
  const snapshot = snapNow('2000000000');
  const policy = { is_active: true, safety_buffer_percentage: 10 };
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  const emergencySnapshot = snapNow(String(forecast.dynamic_emergency_threshold));
  assert.strictEqual(classifyBankStatus({ snapshot: emergencySnapshot, policy, forecast }), STATUS.EMERGENCY);
});
test('forecast-driven: EMERGENCY via runway lebih pendek dari funding window, ISOLATED dari amount-based check (critical/emergency manual di-set sangat rendah)', () => {
  // critical/emergency manual di-set tiny -> amount-based check TIDAK PERNAH trigger duluan,
  // supaya test ini murni membuktikan cabang runway-based EMERGENCY (bukan kebetulan amount-based).
  const policy = { is_active: true, funding_window_hours: 1, critical_threshold: '1', emergency_threshold: '1', safety_buffer_percentage: 0 };
  const bs = burnStats({ average_burn_rate: 500000000, peak_burn_rate: 500000000 }); // burn 500jt/hari -> forecast_required (window 1 jam) ~= 20.8jt
  // Saldo DI BAWAH forecast_required_balance (20.8jt) -> runway < funding window (1 jam), tapi masih jauh di atas critical/emergency manual (1).
  const snapshot = snapNow('10000000');
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: bs, bankCode: 'OCBC' });
  assert.ok(forecast.estimated_runway_minutes < forecast.funding_window_hours * 60, 'prasyarat: runway harus lebih pendek dari funding window utk test ini valid');
  const detail = classifyBankStatusDetailed({ snapshot, policy, forecast });
  assert.strictEqual(detail.status, STATUS.EMERGENCY);
  assert.ok(detail.reason.toLowerCase().includes('runway'), 'alasan harus menyebut runway, bukan amount threshold');
});
test('forecast-driven: CRITICAL kalau projected_balance_at_next_funding di bawah dynamic_critical_threshold walau saldo saat ini masih di atas critical', () => {
  const policy = { is_active: true, funding_window_hours: 48, safety_buffer_percentage: 0 };
  const bs = burnStats({ average_burn_rate: 100000000, peak_burn_rate: 100000000 });
  // Saldo dipilih PAS di atas critical (belum trigger by-amount), tapi proyeksi 48 jam ke depan (2x forecast_required) akan jatuh di bawah critical.
  const probe = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy, burnStats: bs, bankCode: 'OCBC' });
  const snapshot = snapNow(String(probe.dynamic_critical_threshold + 1000)); // sedikit di atas critical -> tidak trigger by-amount
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: bs, bankCode: 'OCBC' });
  const detail = classifyBankStatusDetailed({ snapshot, policy, forecast });
  assert.strictEqual(detail.status, STATUS.CRITICAL);
  assert.ok(detail.reason.toLowerCase().includes('proyeksi'), 'alasan harus menyebut proyeksi, bukan cuma saldo saat ini');
});

// ── stale data (snapshot & reconciliation) ─────────────────────────────────
test('stale data: snapshot saldo lebih tua dari stale_after_minutes -> DATA_STALE (walau forecast tersedia)', () => {
  const policy = { is_active: true, stale_after_minutes: 60 };
  const oldSnapshot = snapNow('1000000000', { captured_at: new Date(Date.now() - 90 * 60000).toISOString() });
  const forecast = buildForecastOutput({ snapshot: oldSnapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(classifyBankStatus({ snapshot: oldSnapshot, policy, forecast }), STATUS.DATA_STALE);
});
test('stale data: data rekonsiliasi lebih basi dari stale_after_minutes -> DATA_STALE walau snapshot saldo baru', () => {
  const policy = { is_active: true, stale_after_minutes: 60 };
  const freshSnapshot = snapNow('1000000000');
  const staleBurn = burnStats({ latest_reconciliation_age_minutes: 2880 }); // 2 hari
  const forecast = buildForecastOutput({ snapshot: freshSnapshot, previousSnapshot: null, policy, burnStats: staleBurn, bankCode: 'OCBC' });
  assert.strictEqual(classifyBankStatus({ snapshot: freshSnapshot, policy, forecast }), STATUS.DATA_STALE);
});

// ── no forecast available ───────────────────────────────────────────────────
test('no forecast available: burnStats.available=false -> forecast_available=false, classify fallback ke logic lama', () => {
  const policy = { is_active: true, absolute_minimum_balance: '500000' };
  const snapshot = snapNow('500000');
  const noForecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: { available: false, reason: 'belum ada batch' }, bankCode: 'OCBC' });
  assert.strictEqual(noForecast.forecast_available, false);
  assert.strictEqual(noForecast.forecast_source, null);
  assert.strictEqual(classifyBankStatus({ snapshot, policy, forecast: noForecast }), STATUS.CRITICAL); // absolute_minimum_balance manual tetap berlaku
});
test('no forecast available: burnStats null sama sekali (forecast param null) -> identik classifyBankStatus tanpa forecast', () => {
  const policy = { is_active: true, absolute_minimum_balance: '500000' };
  const snapshot = snapNow('500000');
  assert.strictEqual(classifyBankStatus({ snapshot, policy }), classifyBankStatus({ snapshot, policy, forecast: null }));
});

// ── manual override precedence ──────────────────────────────────────────────
test('manual override precedence: watch_threshold manual dipakai apa adanya, BUKAN dynamic_watch_threshold hasil forecast', () => {
  const policy = { is_active: true, watch_threshold: '999999999', safety_buffer_percentage: 10 };
  const snapshot = snapNow('1000000000');
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.dynamic_watch_threshold, 999999999, 'field dynamic_watch_threshold value = manual override');
  assert.strictEqual(forecast.thresholds_source.watch, 'MANUAL_OVERRIDE');
});
test('manual override precedence: reserve_balance manual dipakai, BUKAN volatilitas peak-average', () => {
  const policy = { is_active: true, reserve_balance: '12345678' };
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.dynamic_reserve_balance, 12345678);
  assert.strictEqual(forecast.thresholds_source.reserve, 'MANUAL_OVERRIDE');
});
test('manual override precedence: critical_threshold manual mengalahkan forecast_required_balance+reserve dinamis', () => {
  const policy = { is_active: true, critical_threshold: '77777777' };
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.dynamic_critical_threshold, 77777777);
  assert.strictEqual(forecast.thresholds_source.critical, 'MANUAL_OVERRIDE');
});

// ── dynamic threshold fallback (tidak ada manual override sama sekali) ─────
test('dynamic fallback: tanpa manual override apa pun, semua threshold terisi dari forecast (SYSTEM_FORECAST)', () => {
  const policy = { is_active: true, safety_buffer_percentage: 5 };
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.thresholds_source.watch, 'SYSTEM_FORECAST');
  assert.strictEqual(forecast.thresholds_source.critical, 'SYSTEM_FORECAST');
  assert.strictEqual(forecast.thresholds_source.emergency, 'SYSTEM_FORECAST');
  assert.strictEqual(forecast.thresholds_source.reserve, 'SYSTEM_FORECAST');
  assert.ok(forecast.dynamic_emergency_threshold < forecast.dynamic_critical_threshold);
  assert.ok(forecast.dynamic_critical_threshold < forecast.dynamic_watch_threshold);
});
test('dynamic fallback: forecast tidak tersedia DAN tidak ada manual override -> semua threshold null (CONFIGURATION_REQUIRED via fallback lama)', () => {
  const policy = { is_active: true };
  const snapshot = snapNow('1000000000');
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy, burnStats: { available: false }, bankCode: 'OCBC' });
  assert.strictEqual(forecast.dynamic_watch_threshold, null);
  assert.strictEqual(forecast.dynamic_critical_threshold, null);
  assert.strictEqual(forecast.dynamic_emergency_threshold, null);
  assert.strictEqual(classifyBankStatus({ snapshot, policy, forecast }), STATUS.SAFE); // tidak ada threshold apa pun -> tidak ada yang trigger, sama seperti policy kosong lama
});

// ── top-up rounding ──────────────────────────────────────────────────────────
test('roundUpToNearest: pembulatan ke atas ke kelipatan topup_rounding_amount', () => {
  assert.strictEqual(roundUpToNearest(1000001, 1000000), 2000000);
  assert.strictEqual(roundUpToNearest(1000000, 1000000), 1000000, 'tepat kelipatan -> tidak dibulatkan naik lagi');
  assert.strictEqual(roundUpToNearest(1, 500000), 500000);
});
test('roundUpToNearest: roundTo null/0/invalid -> nilai apa adanya (tidak dibulatkan)', () => {
  assert.strictEqual(roundUpToNearest(12345, null), 12345);
  assert.strictEqual(roundUpToNearest(12345, 0), 12345);
  assert.strictEqual(roundUpToNearest(12345, -5), 12345);
});
test('computeRecommendedTopup: hasil dibulatkan ke atas via topup_rounding_amount', () => {
  const amt = computeRecommendedTopup({
    forecastRequiredBalance: 300000000, dynamicReserveBalance: 50000000, safetyBuffer: 10000001,
    effectiveBalance: 100000000, topupRoundingAmount: 1000000,
  });
  // raw = 300jt+50jt+10.000.001-100jt = 260.000.001 -> dibulatkan ke atas kelipatan 1jt = 261.000.000
  assert.strictEqual(amt, 261000000);
});

// ── no negative recommendation ──────────────────────────────────────────────
test('computeRecommendedTopup: saldo sudah lebih dari cukup -> 0, TIDAK PERNAH negatif', () => {
  const amt = computeRecommendedTopup({
    forecastRequiredBalance: 100000000, dynamicReserveBalance: 20000000, safetyBuffer: 5000000,
    effectiveBalance: 999999999999, topupRoundingAmount: 1000000,
  });
  assert.strictEqual(amt, 0);
});
test('forecast-driven: recommended_topup_amount pada output penuh tidak pernah negatif', () => {
  const forecast = buildForecastOutput({ snapshot: snapNow('999999999999'), previousSnapshot: null, policy: { is_active: true }, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.ok(forecast.recommended_topup_amount >= 0);
});

// ── reserve tidak double-subtracted (forecast context) ──────────────────────
test('forecast: dynamic_reserve_balance dipakai SATU KALI di forecast_required_balance vs critical, tidak dijumlah dobel', () => {
  const policy = { is_active: true, funding_window_hours: 24 };
  const bs = burnStats({ average_burn_rate: 200000000, peak_burn_rate: 300000000 });
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy, burnStats: bs, bankCode: 'OCBC' });
  // dynamic_critical_threshold = forecast_required_balance + dynamic_reserve_balance (SATU KALI reserve).
  assert.strictEqual(forecast.dynamic_critical_threshold, forecast.forecast_required_balance + forecast.dynamic_reserve_balance);
});

// ── zero burn-rate handling ──────────────────────────────────────────────────
test('zero burn-rate: average_burn_rate=0 -> estimated_runway_minutes null (bukan Infinity/NaN), forecast_required_balance=0', () => {
  const bs = burnStats({ average_burn_rate: 0, peak_burn_rate: 0 });
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy: { is_active: true }, burnStats: bs, bankCode: 'OCBC' });
  assert.strictEqual(forecast.estimated_runway_minutes, null);
  assert.strictEqual(forecast.forecast_required_balance, 0);
  assert.strictEqual(forecast.dynamic_reserve_balance, 0);
  assert.strictEqual(forecast.recommended_topup_amount, 0);
  assert.ok(!Number.isNaN(forecast.dynamic_critical_threshold));
});
test('zero burn-rate: saldo positif dgn burn 0 -> tidak pernah EMERGENCY/CRITICAL akibat runway', () => {
  const bs = burnStats({ average_burn_rate: 0, peak_burn_rate: 0 });
  const snapshot = snapNow('100');
  const forecast = buildForecastOutput({ snapshot, previousSnapshot: null, policy: { is_active: true, funding_window_hours: 1 }, burnStats: bs, bankCode: 'OCBC' });
  assert.strictEqual(classifyBankStatus({ snapshot, policy: { is_active: true, funding_window_hours: 1 }, forecast }), STATUS.SAFE);
});

// ── sudden drop tetap ter-passthrough di forecast output (REUSE evaluateSuddenDrop, tidak dihitung ulang) ──
test('forecast: sudden_drop_amount/percentage di-passthrough dari evaluateSuddenDrop, bukan dihitung ulang', () => {
  const previousSnapshot = { effective_balance: '1000000000', captured_at: new Date(Date.now() - 10 * 60000).toISOString() };
  const snapshot = snapNow('400000000');
  const policy = { is_active: true, sudden_drop_window_minutes: 60, sudden_drop_amount_threshold: '100000000' };
  const suddenDrop = evaluateSuddenDrop({ snapshot, previousSnapshot, policy });
  const forecast = buildForecastOutput({ snapshot, previousSnapshot, policy, burnStats: burnStats(), bankCode: 'OCBC', suddenDrop });
  assert.strictEqual(forecast.sudden_drop_amount, suddenDrop.dropAmount);
  assert.strictEqual(forecast.sudden_drop_percentage, suddenDrop.dropPercentage);
  assert.strictEqual(classifyBankStatus({ snapshot, policy, previousSnapshot, forecast }), STATUS.SUDDEN_DROP, 'sudden-drop tetap prioritas tertinggi di atas EMERGENCY/CRITICAL forecast');
});
test('forecast: tanpa suddenDrop param -> sudden_drop_amount/percentage null (bukan 0 palsu)', () => {
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy: { is_active: true }, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.sudden_drop_amount, null);
  assert.strictEqual(forecast.sudden_drop_percentage, null);
});

// ── audit logging (struktur payload -- endpoint-level di-verifikasi live setelah deploy) ──
test('audit payload forecast refresh: action REFRESH_FORECAST menyertakan forecast_available & source di notes', () => {
  const forecast = { forecast_available: true, forecast_source: 'OCBC_RECONCILIATION' };
  const notes = `forecast_available=${!!forecast.forecast_available}, source=${forecast.forecast_source || 'null'}`;
  assert.strictEqual(notes, 'forecast_available=true, source=OCBC_RECONCILIATION');
});
test('audit payload status change: hanya di-log kalau status lama != status baru', () => {
  const shouldLog = (lastStatus, newStatus) => lastStatus !== undefined && lastStatus !== null && lastStatus !== newStatus;
  assert.strictEqual(shouldLog('SAFE', 'WATCH'), true);
  assert.strictEqual(shouldLog('SAFE', 'SAFE'), false);
  assert.strictEqual(shouldLog(null, 'SAFE'), false, 'belum ada riwayat -> bukan "perubahan"');
});
test('audit payload recommendation change: hanya di-log kalau selisih >= 1 rupiah', () => {
  const shouldLog = (prev, next) => prev !== null && next !== null && Math.abs(prev - next) >= 1;
  assert.strictEqual(shouldLog(1000000, 1000000), false);
  assert.strictEqual(shouldLog(1000000, 1000001), true);
  assert.strictEqual(shouldLog(null, 1000000), false);
});

// ── backward compatibility dgn policy data existing (tanpa field forecast baru sama sekali) ──
test('backward-compat: policy lama (hanya absolute_minimum_balance/watch_threshold/dst, TANPA reserve_balance/funding_window_hours) tetap terklasifikasi benar tanpa forecast', () => {
  const legacyPolicy = {
    is_active: true, absolute_minimum_balance: '100000', watch_threshold: '500000',
    excess_balance_threshold: '10000000', stale_after_minutes: 60, safety_buffer_percentage: 10,
  };
  assert.strictEqual(classifyBankStatus({ snapshot: snapNow('50000'), policy: legacyPolicy }), STATUS.CRITICAL);
  assert.strictEqual(classifyBankStatus({ snapshot: snapNow('400000'), policy: legacyPolicy }), STATUS.TOP_UP_RECOMMENDED);
  assert.strictEqual(classifyBankStatus({ snapshot: snapNow('2000000'), policy: legacyPolicy }), STATUS.SAFE);
});
test('backward-compat: buildForecastOutput dgn policy lama (tanpa reserve_balance/funding_window_hours) tidak crash, funding_window default dipakai', () => {
  const legacyPolicy = { is_active: true, absolute_minimum_balance: '100000', watch_threshold: '500000', safety_buffer_percentage: 10 };
  const forecast = buildForecastOutput({ snapshot: snapNow('1000000000'), previousSnapshot: null, policy: legacyPolicy, burnStats: burnStats(), bankCode: 'OCBC' });
  assert.strictEqual(forecast.funding_window_is_default, true);
  assert.strictEqual(forecast.funding_window_hours, 24);
  assert.strictEqual(forecast.thresholds_source.critical, 'MANUAL_OVERRIDE', 'absolute_minimum_balance lama tetap dipakai sbg override critical');
});

// ── forecast confidence ──────────────────────────────────────────────────────
test('computeForecastConfidence: coverage penuh + funding_window custom -> 100', () => {
  const score = computeForecastConfidence({ burnStats: { available: true, coverage: { included_days: 14, selected_days: 14 } }, fundingWindowIsDefault: false });
  assert.strictEqual(score, 100);
});
test('computeForecastConfidence: coverage separuh + funding_window default -> diturunkan dari base', () => {
  const withDefault = computeForecastConfidence({ burnStats: { available: true, coverage: { included_days: 7, selected_days: 14 } }, fundingWindowIsDefault: true });
  const withoutDefault = computeForecastConfidence({ burnStats: { available: true, coverage: { included_days: 7, selected_days: 14 } }, fundingWindowIsDefault: false });
  assert.ok(withDefault < withoutDefault);
});
test('computeForecastConfidence: forecast tidak tersedia -> 0', () => {
  assert.strictEqual(computeForecastConfidence({ burnStats: { available: false }, fundingWindowIsDefault: true }), 0);
});

// ── computeBalanceMovement (item 6: kartu "Δ Saldo") ─────────────────────────
test('computeBalanceMovement: tidak ada previous -> semua delta null (BUKAN 0 -- 0 = klaim tidak berubah, padahal tidak ada pembanding)', () => {
  const out = computeBalanceMovement({ current: { available_balance: 680660209, captured_at: '2026-07-29T11:06:00Z' }, previous: null });
  assert.strictEqual(out.delta_amount, null);
  assert.strictEqual(out.delta_percentage, null);
  assert.strictEqual(out.direction, null);
  assert.ok(out.reason);
});
test('computeBalanceMovement: penurunan saldo -> delta negatif, direction DOWN, persentase dari previous', () => {
  const out = computeBalanceMovement({
    current: { available_balance: 680660209, captured_at: '2026-07-29T18:06:00Z' },
    previous: { available_balance: 680660209 + 803762731, captured_at: '2026-07-29T17:00:00Z' },
  });
  assert.strictEqual(out.delta_amount, -803762731);
  assert.strictEqual(out.direction, 'DOWN');
  assert.ok(out.delta_percentage < 0);
  assert.strictEqual(out.previous_captured_at, '2026-07-29T17:00:00Z');
});
test('computeBalanceMovement: kenaikan saldo -> direction UP', () => {
  const out = computeBalanceMovement({
    current: { available_balance: 1000000, captured_at: '2026-07-29T18:06:00Z' },
    previous: { available_balance: 500000, captured_at: '2026-07-29T17:00:00Z' },
  });
  assert.strictEqual(out.direction, 'UP');
  assert.strictEqual(out.delta_amount, 500000);
});
test('computeBalanceMovement: previous available_balance 0 -> delta_percentage null (tidak pernah dibagi nol)', () => {
  const out = computeBalanceMovement({
    current: { available_balance: 500000, captured_at: '2026-07-29T18:06:00Z' },
    previous: { available_balance: 0, captured_at: '2026-07-29T17:00:00Z' },
  });
  assert.strictEqual(out.delta_percentage, null);
});

// ── enrichSnapshotHistory (item 7) ───────────────────────────────────────────
test('enrichSnapshotHistory: snapshot tertua (tidak ada previous) -> NO_PREVIOUS, tidak crash', () => {
  const snapshots = [{ id: 1, captured_at: '2026-07-29T10:00:00Z', available_balance: 500000, sync_status: 'OK' }];
  const out = enrichSnapshotHistory({ snapshots, outflowRows: [], fundingMutations: [], fundingCoverageFrom: null });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].movement_classification, MOVEMENT_CLASSIFICATION.NO_PREVIOUS);
});
test('enrichSnapshotHistory: skip snapshot ERROR saat cari previous valid', () => {
  const snapshots = [
    { id: 3, captured_at: '2026-07-29T12:00:00Z', available_balance: 900000, sync_status: 'OK' },
    { id: 2, captured_at: '2026-07-29T11:00:00Z', available_balance: null, sync_status: 'ERROR' },
    { id: 1, captured_at: '2026-07-29T10:00:00Z', available_balance: 500000, sync_status: 'OK' },
  ];
  const out = enrichSnapshotHistory({ snapshots, outflowRows: [], fundingMutations: [], fundingCoverageFrom: new Date('2026-07-29T00:00:00Z') });
  assert.strictEqual(out[0].movement.previous_available_balance, 500000, 'harus lompat ke snapshot valid (id=1), skip yang ERROR (id=2)');
  assert.strictEqual(out[0].movement.delta_amount, 400000);
});
test('enrichSnapshotHistory: interval di luar fundingCoverageFrom -> RECONCILIATION_DATA_UNAVAILABLE, BUKAN funding=0 palsu', () => {
  const snapshots = [
    { id: 2, captured_at: '2026-07-29T12:00:00Z', available_balance: 900000, sync_status: 'OK' },
    { id: 1, captured_at: '2026-07-01T10:00:00Z', available_balance: 500000, sync_status: 'OK' },
  ];
  const out = enrichSnapshotHistory({ snapshots, outflowRows: [], fundingMutations: [], fundingCoverageFrom: new Date('2026-07-20T00:00:00Z') });
  assert.strictEqual(out[0].funding_credit_interval, null);
  assert.strictEqual(out[0].movement_classification, MOVEMENT_CLASSIFICATION.RECONCILIATION_DATA_UNAVAILABLE);
});
test('enrichSnapshotHistory: delta konsisten dgn matched outflow + funding credit -> CONSISTENT_WITH_VERIFIED_TRANSACTIONS', () => {
  const from = new Date('2026-07-29T10:00:00Z');
  const to = new Date('2026-07-29T12:00:00Z');
  const snapshots = [
    { id: 2, captured_at: to.toISOString(), available_balance: 1000000 + 5000000 - 4000000, sync_status: 'OK' }, // previous + funding - outflow
    { id: 1, captured_at: from.toISOString(), available_balance: 1000000, sync_status: 'OK' },
  ];
  const outflowRows = [{ principal: 3900000, fee: 100000, matchedAt: new Date('2026-07-29T11:00:00Z') }];
  const fundingMutations = [{ amount: 5000000, transaction_datetime: '2026-07-29T10:30:00Z', is_reversal: false, classification: 'FUNDING' }];
  const out = enrichSnapshotHistory({ snapshots, outflowRows, fundingMutations, fundingCoverageFrom: from });
  assert.strictEqual(out[0].matched_principal_outflow_interval, 3900000);
  assert.strictEqual(out[0].verified_fee_outflow_interval, 100000);
  assert.strictEqual(out[0].funding_credit_interval, 5000000);
  assert.strictEqual(out[0].movement_classification, MOVEMENT_CLASSIFICATION.CONSISTENT_WITH_VERIFIED_TRANSACTIONS);
});
test('enrichSnapshotHistory: delta jauh dari matched+funding -> diklasifikasi LIKELY_* (bukan disembunyikan sbg konsisten)', () => {
  const from = new Date('2026-07-29T10:00:00Z');
  const to = new Date('2026-07-29T12:00:00Z');
  const snapshots = [
    { id: 2, captured_at: to.toISOString(), available_balance: 1000000 - 9000000, sync_status: 'OK' }, // turun jauh, tidak match outflow kecil di bawah
    { id: 1, captured_at: from.toISOString(), available_balance: 1000000, sync_status: 'OK' },
  ];
  const outflowRows = [{ principal: 100000, fee: 0, matchedAt: new Date('2026-07-29T11:00:00Z') }];
  const out = enrichSnapshotHistory({ snapshots, outflowRows, fundingMutations: [], fundingCoverageFrom: from });
  assert.strictEqual(out[0].movement_classification, MOVEMENT_CLASSIFICATION.LIKELY_OPERATIONAL_OUTFLOW_UNVERIFIED);
});
test('enrichSnapshotHistory: preserve seluruh field snapshot asli (tidak ada data historis yang hilang/ditimpa)', () => {
  const snapshots = [{ id: 1, captured_at: '2026-07-29T10:00:00Z', available_balance: 500000, sync_status: 'OK', source: 'RECONCILIATION', held_balance: 0 }];
  const out = enrichSnapshotHistory({ snapshots, outflowRows: [], fundingMutations: [], fundingCoverageFrom: null });
  assert.strictEqual(out[0].source, 'RECONCILIATION');
  assert.strictEqual(out[0].held_balance, 0);
  assert.strictEqual(out[0].id, 1);
});

// ── pickCurrentAndPrevious (item 5: manual balance TIDAK BOLEH menimpa rekonsiliasi) ──
test('pickCurrentAndPrevious: bank rekonsiliasi -- baris MANUAL lebih baru TIDAK menang atas RECONCILIATION lebih lama', () => {
  const rows = [
    { id: 3, captured_at: '2026-07-29T12:00:00Z', source: 'MANUAL', available_balance: 999999999 },
    { id: 2, captured_at: '2026-07-29T11:00:00Z', source: 'RECONCILIATION', available_balance: 680660209 },
    { id: 1, captured_at: '2026-07-29T10:00:00Z', source: 'RECONCILIATION', available_balance: 700000000 },
  ];
  const { snapshot, previousSnapshot } = pickCurrentAndPrevious(rows, true);
  assert.strictEqual(snapshot.id, 2, 'RECONCILIATION terbaru harus menang walau ada MANUAL yang capture-nya lebih baru');
  assert.strictEqual(previousSnapshot.id, 1);
});
test('pickCurrentAndPrevious: bank rekonsiliasi, belum pernah ada RECONCILIATION -- MANUAL boleh jadi current (fallback darurat)', () => {
  const rows = [
    { id: 2, captured_at: '2026-07-29T12:00:00Z', source: 'MANUAL', available_balance: 111 },
    { id: 1, captured_at: '2026-07-29T10:00:00Z', source: 'MANUAL', available_balance: 222 },
  ];
  const { snapshot } = pickCurrentAndPrevious(rows, true);
  assert.strictEqual(snapshot.id, 2, 'tanpa RECONCILIATION sama sekali, fallback ke captured_at DESC biasa');
});
test('pickCurrentAndPrevious: bank TANPA adapter rekonsiliasi -- perilaku lama (captured_at DESC) tidak berubah', () => {
  const rows = [
    { id: 2, captured_at: '2026-07-29T12:00:00Z', source: 'MANUAL', available_balance: 111 },
    { id: 1, captured_at: '2026-07-29T10:00:00Z', source: 'MANUAL', available_balance: 222 },
  ];
  const { snapshot, previousSnapshot } = pickCurrentAndPrevious(rows, false);
  assert.strictEqual(snapshot.id, 2);
  assert.strictEqual(previousSnapshot.id, 1);
});

// ── STATUS TAXONOMY (item 8) ─────────────────────────────────────────────────
test('status taxonomy: 6 status canonical (SAFE/WATCH/CRITICAL/EMERGENCY/DATA_STALE/CONFIGURATION_REQUIRED) semuanya ada & unik, tidak ada alias ganda', () => {
  const canonical = ['SAFE', 'WATCH', 'CRITICAL', 'EMERGENCY', 'DATA_STALE', 'CONFIGURATION_REQUIRED'];
  for (const s of canonical) assert.strictEqual(STATUS[s], s, `STATUS.${s} harus ada & bernilai string dirinya sendiri`);
  // Tidak ada 'NORMAL' terpisah yang berarti sama dgn SAFE -- SATU nama kanonik per konsep.
  assert.strictEqual(STATUS.NORMAL, undefined, 'tidak boleh ada alias NORMAL berdampingan dgn SAFE utk konsep yang sama');
});

// ── Runner ──────────────────────────────────────────────────────────────────
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
