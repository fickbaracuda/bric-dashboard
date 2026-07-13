'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (cek package.json), jadi tidak menambah dependency baru.
// Run: node backend/scripts/test-reconciliation-ocbc.js

const assert = require('assert');
const {
  reconcileTransactions, parseDescriptionFallback, cleanNum, numEq,
} = require('../src/routes/warroom-reconciliation');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, nominal, opts = {}) {
  return { idTransaksi, nominal, idOutlet: opts.idOutlet || 'HH82915', idProduk: opts.idProduk || null, idBiller: opts.idBiller || null, timeResponse: opts.timeResponse || null };
}
function bankRow(referenceNo, { debit = null, credit = null, description = null, transactionDate = '2026-07-10' } = {}) {
  return { referenceNo, debit, credit, description, transactionDate };
}

// ── cleanNum — angka aman ──────────────────────────────────────────────
test('cleanNum: number langsung dipakai, tidak diproses string (insiden Speedcash)', () => {
  assert.strictEqual(cleanNum(74200), 74200);
  assert.strictEqual(cleanNum(408146.85), 408146.85);
});
test('cleanNum: string dengan pemisah ribuan', () => {
  assert.strictEqual(cleanNum('74,200'), 74200);
  assert.strictEqual(cleanNum('4.095.000'), 4095000);
  assert.strictEqual(cleanNum('Rp 25'), 25);
});
test('cleanNum: kosong/"-" -> null', () => {
  assert.strictEqual(cleanNum(''), null);
  assert.strictEqual(cleanNum('-'), null);
  assert.strictEqual(cleanNum(null), null);
});

// ── parseDescriptionFallback ────────────────────────────────────────────
test('parseDescriptionFallback: pola outlet+id_transaksi dikenali', () => {
  const r = parseDescriptionFallback('BI-FAST TRSF/HH829153556344215');
  assert.deepStrictEqual(r, { idOutlet: 'HH82915', idTransaksi: '3556344215' });
});
test('parseDescriptionFallback: pola tidak dikenali -> null (di luar scope)', () => {
  assert.strictEqual(parseDescriptionFallback('BUNGA TABUNGAN BULANAN'), null);
  assert.strictEqual(parseDescriptionFallback(''), null);
  assert.strictEqual(parseDescriptionFallback(null), null);
});

// ── Acceptance Test 1: MATCHED dengan fee normal ────────────────────────
test('AT1: reference 3556344215 — MATCHED, principal 74200, fee 25, total debit 74225', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow('3556344215', { debit: 74200 }),
    bankRow('3556344215', { debit: 25 }),
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'MATCHED');
  assert.strictEqual(r.bankPrincipal, 74200);
  assert.strictEqual(r.bankFee, 25);
  assert.strictEqual(r.bankTotalDebit, 74225);
  assert.strictEqual(r.matchingMethod, 'reference_exact');
});

// ── Acceptance Test 2 ────────────────────────────────────────────────────
test('AT2: reference 3556344516 — MATCHED', () => {
  const fpRows = [fp('3556344516', 4095000)];
  const bankRows = [
    bankRow('3556344516', { debit: 4095000 }),
    bankRow('3556344516', { debit: 25 }),
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'MATCHED');
  assert.strictEqual(r.bankPrincipal, 4095000);
  assert.strictEqual(r.bankFee, 25);
});

// ── Acceptance Test 3: PENDING_BANK dalam grace period ──────────────────
test('AT3: FP belum muncul di bank, umur <30 menit -> PENDING_BANK', () => {
  const now = new Date('2026-07-10T10:00:00.000Z');
  const timeResponse = new Date('2026-07-10T09:45:00.000Z'); // 15 menit lalu
  const fpRows = [fp('9999999999', 50000, { timeResponse })];
  const [r] = reconcileTransactions(fpRows, [], {}, now);
  assert.strictEqual(r.reconStatus, 'PENDING_BANK');
});

// ── Acceptance Test 4: FP_ONLY setelah grace period ─────────────────────
test('AT4: FP tidak muncul setelah grace period -> FP_ONLY', () => {
  const now = new Date('2026-07-10T10:00:00.000Z');
  const timeResponse = new Date('2026-07-10T09:00:00.000Z'); // 60 menit lalu
  const fpRows = [fp('8888888888', 50000, { timeResponse })];
  const [r] = reconcileTransactions(fpRows, [], {}, now);
  assert.strictEqual(r.reconStatus, 'FP_ONLY');
});

// ── Acceptance Test 5: hanya debit fee, tanpa principal ─────────────────
test('AT5: reference hanya punya debit Rp25 (tanpa principal) -> NOMINAL_MISMATCH', () => {
  const fpRows = [fp('7777777777', 74200)];
  const bankRows = [bankRow('7777777777', { debit: 25 })];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.ok(['NOMINAL_MISMATCH', 'NEED_REVIEW'].includes(r.reconStatus));
  assert.notStrictEqual(r.reconStatus, 'MATCHED');
});

// ── Acceptance Test 6: dua principal sama pada reference sama ───────────
test('AT6: 2 debit principal identik pada reference sama -> DUPLICATE_BANK', () => {
  const fpRows = [fp('6666666666', 100000)];
  const bankRows = [
    bankRow('6666666666', { debit: 100000 }),
    bankRow('6666666666', { debit: 100000 }),
    bankRow('6666666666', { debit: 25 }),
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'DUPLICATE_BANK');
});

// ── Acceptance Test 7: credit dengan reference sama ─────────────────────
test('AT7: credit pada reference sama -> REVERSAL', () => {
  const fpRows = [fp('5555555555', 100000)];
  const bankRows = [
    bankRow('5555555555', { debit: 100000 }),
    bankRow('5555555555', { debit: 25 }),
    bankRow('5555555555', { credit: 100000 }),
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'REVERSAL');
});

// ── Acceptance Test 8: kolom bantuan tidak memengaruhi hasil ────────────
// (dijamin secara desain — parser FP/bank di warroom-reconciliation.js dan
// Apps Script sama sekali tidak membaca kolom G di DATA FP atau I/J di
// DATA BANK OCBC; tidak ada field tersebut yang dipetakan ke engine.)
test('AT8: engine tidak pernah membaca field kolom bantuan (helperCheckBank/helperI/helperJ)', () => {
  const fpRows = [{ idTransaksi: '1231231231', nominal: 1000, idOutlet: 'HH00001', helperCheckBank: 'SUDAH CEK' }];
  const bankRows = [
    { referenceNo: '1231231231', debit: 1000, helperI: 'x', helperJ: 'y' },
    { referenceNo: '1231231231', debit: 25, helperI: 'x', helperJ: 'y' },
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'MATCHED');
});

// ── DUPLICATE_FP ──────────────────────────────────────────────────────────
test('DUPLICATE_FP: id_transaksi muncul 2x di FP', () => {
  const fpRows = [fp('4444444444', 50000), fp('4444444444', 50000)];
  const bankRows = [bankRow('4444444444', { debit: 50000 }), bankRow('4444444444', { debit: 25 })];
  const results = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results.length, 1); // 1 baris hasil per id unik
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP');
});

// ── MATCHED_NO_FEE ────────────────────────────────────────────────────────
test('MATCHED_NO_FEE: principal cocok, tidak ada baris fee sama sekali', () => {
  const fpRows = [fp('3333333333', 20000)];
  const bankRows = [bankRow('3333333333', { debit: 20000 })];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'MATCHED_NO_FEE');
  assert.strictEqual(r.bankFee, 0);
});

// ── FEE_MISMATCH ──────────────────────────────────────────────────────────
test('FEE_MISMATCH: principal cocok, fee beda dari konfigurasi (default 25)', () => {
  const fpRows = [fp('2222222222', 30000)];
  const bankRows = [bankRow('2222222222', { debit: 30000 }), bankRow('2222222222', { debit: 50 })];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.reconStatus, 'FEE_MISMATCH');
  assert.strictEqual(r.varianceFee, 25);
});

// ── Fee configurable ──────────────────────────────────────────────────────
test('Konfigurasi expectedFee dapat diubah (bukan hardcode 25)', () => {
  const fpRows = [fp('1112223334', 40000)];
  const bankRows = [bankRow('1112223334', { debit: 40000 }), bankRow('1112223334', { debit: 50 })];
  const [r] = reconcileTransactions(fpRows, bankRows, { expectedFee: 50 }, new Date());
  assert.strictEqual(r.reconStatus, 'MATCHED');
});

// ── Fallback description dipakai HANYA kalau tidak ada exact reference ──
test('Matching prioritaskan reference_exact drpd description_fallback', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow('3556344215', { debit: 74200 }), // exact reference
    bankRow('3556344215', { debit: 25 }),
    bankRow(null, { debit: 999999, description: 'BI-FAST TRSF/HH829153556344215' }), // fallback candidate, harus diabaikan
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.matchingMethod, 'reference_exact');
  assert.strictEqual(r.bankPrincipal, 74200);
});

test('Matching pakai description_fallback kalau reference kosong/tidak match', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow(null, { debit: 74200, description: 'BI-FAST TRSF/HH829153556344215' }),
    bankRow(null, { debit: 25, description: 'BI-FAST TRSF/HH829153556344215' }),
  ];
  const [r] = reconcileTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(r.matchingMethod, 'description_fallback');
  assert.strictEqual(r.reconStatus, 'MATCHED');
});

// ── BANK_ONLY hanya untuk row yang "in scope" ────────────────────────────
test('BANK_ONLY: reference dalam scope tapi tidak ada di FP', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow('3556344215', { debit: 74200 }), bankRow('3556344215', { debit: 25 }),
    bankRow('9990001112', { debit: 15000 }), // tidak ada di FP manapun, tapi reference numerik (in scope)
  ];
  const results = reconcileTransactions(fpRows, bankRows, {}, new Date());
  const bankOnly = results.find(r => r.reconStatus === 'BANK_ONLY');
  assert.ok(bankOnly, 'harus ada 1 baris BANK_ONLY');
  assert.strictEqual(bankOnly.referenceNo, '9990001112');
});

test('Mutasi bank di luar scope (bukan pola outlet+id_transaksi, tanpa reference) TIDAK jadi BANK_ONLY', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow('3556344215', { debit: 74200 }), bankRow('3556344215', { debit: 25 }),
    bankRow(null, { debit: 500000, description: 'BUNGA TABUNGAN BULANAN' }), // di luar scope, harus diabaikan
  ];
  const results = reconcileTransactions(fpRows, bankRows, {}, new Date());
  const bankOnlyCount = results.filter(r => r.reconStatus === 'BANK_ONLY').length;
  assert.strictEqual(bankOnlyCount, 0);
});

// ── Regresi: 2 BANK_ONLY dari description_fallback (tanpa reference_no)
// TIDAK boleh saling menimpa (harus punya referenceNo unik masing-masing,
// diisi dari candidateId hasil parse — bukan null berdua) ──
test('2 BANK_ONLY via description_fallback (tanpa reference asli) tetap 2 baris terpisah', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [
    bankRow('3556344215', { debit: 74200 }), bankRow('3556344215', { debit: 25 }),
    bankRow(null, { debit: 15000, description: 'BI-FAST TRSF/HH829169990001112' }),
    bankRow(null, { debit: 20000, description: 'BI-FAST TRSF/HH829179990002223' }),
  ];
  const results = reconcileTransactions(fpRows, bankRows, {}, new Date());
  const bankOnlyRows = results.filter(r => r.reconStatus === 'BANK_ONLY');
  assert.strictEqual(bankOnlyRows.length, 2);
  const refs = bankOnlyRows.map(r => r.referenceNo).sort();
  assert.deepStrictEqual(refs, ['9990001112', '9990002223']);
  assert.ok(bankOnlyRows.every(r => r.referenceNo !== null), 'referenceNo tidak boleh null utk fallback BANK_ONLY');
});

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
