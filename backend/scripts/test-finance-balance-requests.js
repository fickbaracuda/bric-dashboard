'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-reconciliation-{ocbc,mandiri,bri}.js (belum ada
// test framework/mocking DB di project ini).
// Run: node backend/scripts/test-finance-balance-requests.js
//
// Hanya mencakup logic PURE (validateRequesterName, VALID_BANK_CODES) —
// tidak menyentuh DB. Skenario yang butuh DB sungguhan (create/pending/
// acknowledge, race condition 2 user FA, double-submit 10 detik, FA-only
// enforcement di endpoint) diverifikasi end-to-end lewat server sungguhan
// (lihat laporan implementasi), sama seperti pola test rekonsiliasi.

const assert = require('assert');
const { validateRequesterName, VALID_BANK_CODES } = require('../src/routes/finance-balance-requests');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── requester_name validation ────────────────────────────────────────────
test('TEST 4: requester_name kosong -> ditolak', () => {
  const r = validateRequesterName('');
  assert.ok(r.error, 'harus ada error');
});
test('TEST 4b: requester_name undefined -> ditolak', () => {
  const r = validateRequesterName(undefined);
  assert.ok(r.error);
});
test('TEST 5: requester_name hanya spasi -> ditolak', () => {
  const r = validateRequesterName('     ');
  assert.ok(r.error);
});
test('TEST 6: requester_name > 100 karakter -> ditolak', () => {
  const r = validateRequesterName('A'.repeat(101));
  assert.ok(r.error);
});
test('requester_name valid (trim, 2-100 char) -> diterima, hasil ter-trim', () => {
  const r = validateRequesterName('  Nabila  ');
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.value, 'Nabila');
});
test('requester_name 1 karakter (di bawah minimal 2) -> ditolak', () => {
  const r = validateRequesterName('A');
  assert.ok(r.error);
});
test('requester_name tepat 100 karakter (batas atas) -> diterima', () => {
  const r = validateRequesterName('A'.repeat(100));
  assert.strictEqual(r.error, undefined);
});
test('requester_name mengandung tag HTML (<script>) -> ditolak', () => {
  const r = validateRequesterName('<script>alert(1)</script>');
  assert.ok(r.error, 'nama dgn karakter < atau > harus ditolak');
});
test('requester_name mengandung karakter < atau > apa pun -> ditolak', () => {
  assert.ok(validateRequesterName('Budi <b>').error);
  assert.ok(validateRequesterName('Budi > Santoso').error);
});

// ── bank_code validation ─────────────────────────────────────────────────
test('TEST 1-3: VALID_BANK_CODES memuat persis OCBC, MANDIRI, BRI', () => {
  assert.deepStrictEqual(VALID_BANK_CODES, ['OCBC', 'MANDIRI', 'BRI']);
});
test('TEST 7: bank_code tidak dikenal (mis. BCA) -> tidak termasuk VALID_BANK_CODES', () => {
  assert.strictEqual(VALID_BANK_CODES.includes('BCA'), false);
});

// ── Runner ────────────────────────────────────────────────────────────────
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
