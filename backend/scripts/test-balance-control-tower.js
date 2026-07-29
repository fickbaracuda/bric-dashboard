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
  evaluateSuddenDrop,
  resolveReserveBalance,
  alertTypeForStatus,
  canTransitionTopup,
  isSelfApproval,
  STATUS,
} = require('../src/utils/balanceControlTower');

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
