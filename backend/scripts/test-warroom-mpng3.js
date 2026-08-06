'use strict';

/**
 * Test logic WAR-ROOM MPNG3 tanpa perlu koneksi DB — mengikuti pola
 * assert polos seperti test-qris-control-tower.js. Cakupan:
 *   1. toIsoDate() — konversi tanggal DD/MM/YYYY dari Apps Script.
 *   2. Dedup-by-id_outlet — sama seperti pola BUMDes/PA-LPD (Google Sheet
 *      kadang punya baris duplikat).
 *   3. Validasi payload sync (bulan format YYYY-MM, outlets array).
 *   4. Cross-check terhadap contoh data asli dari user (row "FA0086").
 *
 * Run: node backend/scripts/test-warroom-mpng3.js
 */

const assert = require('assert');
const { _internal } = require('../src/routes/warroom-mpng3');
const { toIsoDate } = _internal;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('=== WAR-ROOM MPNG3 — test logic (no DB) ===\n');

// ── 1. toIsoDate ─────────────────────────────────────────────────────
test('toIsoDate: DD/MM/YYYY -> ISO', () => {
  assert.strictEqual(toIsoDate('01/11/2010'), '2010-11-01');
  assert.strictEqual(toIsoDate('5/3/2026'), '2026-03-05');
});
test('toIsoDate: sudah ISO -> passthrough', () => {
  assert.strictEqual(toIsoDate('2026-08-01'), '2026-08-01');
});
test('toIsoDate: kosong/null -> null', () => {
  assert.strictEqual(toIsoDate(''), null);
  assert.strictEqual(toIsoDate(null), null);
  assert.strictEqual(toIsoDate(undefined), null);
});
test('toIsoDate: format tak dikenal -> null (bukan crash)', () => {
  assert.strictEqual(toIsoDate('bukan-tanggal'), null);
});

// ── 2. Dedup-by-id_outlet (replikasi logic syncHandler) ────────────────
function dedup(rows) {
  const seen = new Map();
  for (const o of rows) seen.set(String(o.id_outlet).trim(), o);
  return [...seen.values()];
}
test('dedup: baris id_outlet duplikat -> ambil yang terakhir', () => {
  const rows = [
    { id_outlet: 'FA0086', trx_curr: 1 },
    { id_outlet: 'FA0086', trx_curr: 3 }, // duplikat, versi terbaru
    { id_outlet: 'FA0002', trx_curr: 5 },
  ];
  const result = dedup(rows);
  assert.strictEqual(result.length, 2);
  const fa0086 = result.find(o => o.id_outlet === 'FA0086');
  assert.strictEqual(fa0086.trx_curr, 3);
});
test('dedup: id_outlet dengan whitespace tetap dianggap sama', () => {
  const rows = [
    { id_outlet: 'FA0086 ', trx_curr: 1 },
    { id_outlet: ' FA0086', trx_curr: 9 },
  ];
  assert.strictEqual(dedup(rows).length, 1);
});

// ── 3. Validasi payload sync ────────────────────────────────────────
function validateSyncBody(body) {
  const { bulan, outlets } = body;
  if (!bulan || !Array.isArray(outlets) || outlets.length === 0) return 'bulan dan outlets array required';
  if (!/^\d{4}-\d{2}$/.test(bulan)) return 'bulan harus format YYYY-MM';
  return null;
}
test('validasi: bulan format YYYY-MM valid', () => {
  assert.strictEqual(validateSyncBody({ bulan: '2026-08', outlets: [{ id_outlet: 'X' }] }), null);
});
test('validasi: bulan format salah ditolak', () => {
  assert.strictEqual(validateSyncBody({ bulan: 'Agustus', outlets: [{ id_outlet: 'X' }] }), 'bulan harus format YYYY-MM');
});
test('validasi: outlets kosong ditolak', () => {
  assert.strictEqual(validateSyncBody({ bulan: '2026-08', outlets: [] }), 'bulan dan outlets array required');
});

// ── 4. Cross-check contoh data asli dari user ───────────────────────
// Baris asli (screenshot + pasted table, sheet "Agustus", 14 kolom A-N):
// FA0002 FA0086 BEN ARMY 81288908854 AREA MANAGER Kota Tangerang Selatan
// 01/11/2010 01/11/2010 0 0 3 2100 3 2100
test('cross-check: contoh outlet FA0086 sesuai kolom A-N', () => {
  const row = ['FA0002', 'FA0086', 'BEN ARMY', '81288908854', 'AREA MANAGER',
    'Kota Tangerang Selatan', '01/11/2010', '01/11/2010', 0, 0, 3, 2100, 3, 2100];
  const outlet = {
    upline: row[0], id_outlet: row[1], nama_pemilik: row[2], notelp_pemilik: row[3],
    tipe_outlet: row[4], nama_kota: row[5],
    tanggal_registrasi: toIsoDate(row[6]), tanggal_aktifasi: toIsoDate(row[7]),
    trx_prev: row[8], rev_prev: row[9], trx_curr: row[10], rev_curr: row[11],
    dev_trx: row[12], dev_rev: row[13],
  };
  assert.strictEqual(outlet.id_outlet, 'FA0086');
  assert.strictEqual(outlet.upline, 'FA0002');
  assert.strictEqual(outlet.tanggal_registrasi, '2010-11-01');
  assert.strictEqual(outlet.trx_prev, 0);
  assert.strictEqual(outlet.trx_curr, 3);
  assert.strictEqual(outlet.dev_trx, 3);
  // Konsistensi: dev_trx harus sama dengan trx_curr - trx_prev (matematis, walau
  // di sheet nilainya dihitung sendiri oleh formula, bukan turunan di backend)
  assert.strictEqual(outlet.dev_trx, outlet.trx_curr - outlet.trx_prev);
  assert.strictEqual(outlet.dev_rev, outlet.rev_curr - outlet.rev_prev);
});

console.log(`\n${passed} test passed.`);
if (process.exitCode) {
  console.error('Ada test yang GAGAL.');
} else {
  console.log('Semua test OK.');
}
