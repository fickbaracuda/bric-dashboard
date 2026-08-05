'use strict';

/**
 * Test manual untuk perbaikan KPI MGM PA — TIDAK butuh DB, hanya menguji
 * normalizeIsActive() dan toNum() (pure functions) plus replikasi formula
 * conversion_rate / active_inactive_ratio yang dipakai di mgmAnalyticsHandler.
 * Jalankan dengan:
 *   node backend/scripts/test-mgm-pa-kpi.js
 */

const assert = require('assert');
const { normalizeIsActive, toNum } = require('../src/routes/warroom');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  [OK]   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
  }
}

console.log('=== MGM PA KPI — Test Suite ===\n');

console.log('-- normalizeIsActive: nilai valid --');
test('number 1 -> 1',      () => assert.strictEqual(normalizeIsActive(1), 1));
test('number 0 -> 0',      () => assert.strictEqual(normalizeIsActive(0), 0));
test('string "1" -> 1',    () => assert.strictEqual(normalizeIsActive('1'), 1));
test('string "0" -> 0',    () => assert.strictEqual(normalizeIsActive('0'), 0));
test('string " 1 " -> 1',  () => assert.strictEqual(normalizeIsActive(' 1 '), 1));

console.log('\n-- normalizeIsActive: string "0" TIDAK boleh truthy-collapse (insiden asli) --');
test('"0" bukan dianggap truthy/aktif', () => assert.notStrictEqual(normalizeIsActive('0'), 1));

console.log('\n-- normalizeIsActive: nilai unknown -> null (BUKAN 0) --');
test('null -> null',      () => assert.strictEqual(normalizeIsActive(null), null));
test('undefined -> null', () => assert.strictEqual(normalizeIsActive(undefined), null));
test('"" -> null',        () => assert.strictEqual(normalizeIsActive(''), null));
test('"yes" -> null',     () => assert.strictEqual(normalizeIsActive('yes'), null));
test('"2" -> null',       () => assert.strictEqual(normalizeIsActive('2'), null));

console.log('\n-- toNum --');
test('number 1582 -> 1582',   () => assert.strictEqual(toNum(1582), 1582));
test('string "1582" -> 1582', () => assert.strictEqual(toNum('1582'), 1582));
test('blank "" -> 0',         () => assert.strictEqual(toNum(''), 0));
test('null -> 0',             () => assert.strictEqual(toNum(null), 0));
test('garbage "abc" -> 0',    () => assert.strictEqual(toNum('abc'), 0));

console.log('\n-- Formula conversion_rate / active_inactive_ratio (replikasi SQL) --');
function conversionRate(regSudahAktif, totalRegistrasi) {
  if (totalRegistrasi <= 0) return null;
  return Math.round((regSudahAktif / totalRegistrasi) * 10000) / 100;
}
function activeInactiveRatio(regSudahAktif, regBelumAktif) {
  if (regBelumAktif <= 0) return null;
  return Math.round((regSudahAktif / regBelumAktif) * 10000) / 100;
}
test('conversion_rate 480/931 = 51.56%', () => {
  assert.strictEqual(conversionRate(480, 931), 51.56);
});
test('active_inactive_ratio 480/451 = 106.43%', () => {
  assert.strictEqual(activeInactiveRatio(480, 451), 106.43);
});
test('conversion_rate aman saat denominator 0 (null, bukan Infinity)', () => {
  assert.strictEqual(conversionRate(0, 0), null);
});
test('active_inactive_ratio aman saat reg_belum_aktif 0 (null, bukan Infinity)', () => {
  assert.strictEqual(activeInactiveRatio(10, 0), null);
});

console.log(`\n=== Selesai: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
