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
