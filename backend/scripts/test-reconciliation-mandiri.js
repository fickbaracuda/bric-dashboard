'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-reconciliation-ocbc.js (belum ada test framework di
// project ini). Run: node backend/scripts/test-reconciliation-mandiri.js
//
// Catatan: idempotensi sync (acceptance test 15 di spek — "sync ulang batch
// yang sama tidak boleh menggandakan row") adalah perilaku level DB (delete
// raw + upsert recon_results via unique index), bukan sesuatu yang dites di
// level pure-function di sini — sama seperti pola test OCBC. Diverifikasi
// langsung lewat endpoint sync di server (lihat laporan implementasi).

const assert = require('assert');
const {
  extractMandiriRow, reconcileMandiriTransactions, validateMandiriBalance,
} = require('../src/reconciliation/mandiriAdapter');
const { parseFlexibleDateTime, timeDelayBucket } = require('../src/routes/warroom-reconciliation-mandiri');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, nominal, opts = {}) {
  return {
    idTransaksi, nominal,
    idOutlet: opts.idOutlet ?? 'OUTLET1', idProduk: opts.idProduk ?? null, idBiller: opts.idBiller ?? null,
    timeResponse: opts.timeResponse ?? null,
  };
}

function bank(remarks, opts = {}) {
  const additionalDesc = opts.additionalDesc ?? null;
  const creditAmount = opts.creditAmount ?? null;
  const debitAmount = opts.debitAmount ?? null;
  const extraction = extractMandiriRow(remarks, additionalDesc, creditAmount);
  return {
    accountNo: opts.accountNo ?? 'ACC1', currency: 'IDR',
    postDate: opts.postDate ?? new Date('2026-07-10T10:00:00+07:00'),
    remarks, additionalDesc, creditAmount, debitAmount,
    closeBalance: opts.closeBalance ?? null, sourceRowNumber: opts.sourceRowNumber ?? null,
    extractedTransactionId: extraction.extractedTransactionId,
    bankRowType: extraction.bankRowType,
    extractionMethod: extraction.extractionMethod,
  };
}

// ── Extraction rules (section 5) ───────────────────────────────────────────
test('RULE A: baris yang DIMULAI "Transfer Fee" -> FEE, id diekstrak kontekstual', () => {
  const r = extractMandiriRow('Transfer Fee 3554586042 3554586042 Transfer Fee 99102', null, null);
  assert.strictEqual(r.bankRowType, 'FEE');
  assert.strictEqual(r.extractedTransactionId, '3554586042');
});
test('RULE B: baris principal, id diekstrak setelah slash', () => {
  const r = extractMandiriRow('1560021930625/3554586042 042 MCM InhouseTrf KE 1560021930625', null, null);
  assert.strictEqual(r.bankRowType, 'PRINCIPAL');
  assert.strictEqual(r.extractedTransactionId, '3554586042');
});
test('TEST 12: baris principal yang mengandung kata "Transfer Fee" di EKOR tetap PRINCIPAL (tidak dimulai dgn itu)', () => {
  const r = extractMandiriRow('1560021930625/3554586042 042 MCM InhouseTrf KE 1560021930625 Transfer Fee 355458604299102', null, null);
  assert.strictEqual(r.bankRowType, 'PRINCIPAL');
  assert.strictEqual(r.extractedTransactionId, '3554586042');
});
test('RULE C: Credit Amount > 0 menimpa jadi CREDIT_REVERSAL', () => {
  const r = extractMandiriRow('1560021930625/3554586042 042 MCM InhouseTrf', null, 690614);
  assert.strictEqual(r.bankRowType, 'CREDIT_REVERSAL');
});
test('RULE D: tidak ada pola cocok -> UNKNOWN', () => {
  const r = extractMandiriRow('BUNGA TABUNGAN BULANAN', null, null);
  assert.strictEqual(r.bankRowType, 'UNKNOWN');
  assert.strictEqual(r.extractedTransactionId, null);
});
test('Fallback ke AdditionalDesc HANYA kalau Remarks kosong/gagal', () => {
  const r1 = extractMandiriRow('', '1560021930625/3554586042 042 MCM InhouseTrf', null);
  assert.strictEqual(r1.extractedTransactionId, '3554586042');
  assert.strictEqual(r1.extractionMethod, 'ADDITIONAL_DESC_PRINCIPAL_PATTERN');
  const r2 = extractMandiriRow('1560021930625/3554586042 042 MCM InhouseTrf', '9999999999999/0000000000', null);
  assert.strictEqual(r2.extractedTransactionId, '3554586042', 'Remarks harus diprioritaskan di atas AdditionalDesc');
});
test('TEST 13: Remarks & AdditionalDesc berisi teks sama -> tetap 1 hasil ekstraksi (bukan 2)', () => {
  const text = '1560021930625/3554586042 042 MCM InhouseTrf';
  const r = extractMandiriRow(text, text, null);
  assert.strictEqual(r.extractedTransactionId, '3554586042');
  // satu panggilan = satu hasil -> baris statement tidak pernah dihitung 2x
});

// ── TEST 1-5: MATCHED ───────────────────────────────────────────────────────
function matchedCase(idTransaksi, nominal) {
  const fpRows = [fp(idTransaksi, nominal)];
  const bankRows = [
    bank(`1560021930625/${idTransaksi} 042 MCM InhouseTrf KE 1560021930625`, { debitAmount: nominal }),
    bank(`Transfer Fee ${idTransaksi} ${idTransaksi} Transfer Fee 99102`, { debitAmount: 100 }),
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date('2026-07-10T12:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === idTransaksi);
  assert.strictEqual(r.reconStatus, 'MATCHED');
  assert.strictEqual(r.bankPrincipal, nominal);
  assert.strictEqual(r.bankFee, 100);
  assert.strictEqual(r.bankTotalDebit, nominal + 100);
  return r;
}
test('TEST 1: 3554586042 / 690614 -> MATCHED', () => matchedCase('3554586042', 690614));
test('TEST 2: 3554586292 / 176240 -> MATCHED', () => matchedCase('3554586292', 176240));
test('TEST 3: 3554586762 / 510000 -> MATCHED', () => matchedCase('3554586762', 510000));
test('TEST 4: 3554587024 / 1125548 -> MATCHED', () => matchedCase('3554587024', 1125548));
test('TEST 5: 3554587661 / 2000000 -> MATCHED', () => matchedCase('3554587661', 2000000));

// ── TEST 6: MATCHED_NO_FEE ──────────────────────────────────────────────────
test('TEST 6: principal cocok, fee tidak ditemukan -> MATCHED_NO_FEE', () => {
  const fpRows = [fp('3554599001', 500000)];
  const bankRows = [bank('1560021930625/3554599001 042 MCM InhouseTrf', { debitAmount: 500000 })];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'MATCHED_NO_FEE');
});

// ── TEST 7: FEE_MISMATCH ────────────────────────────────────────────────────
test('TEST 7: principal cocok, fee 200 (expected 100) -> FEE_MISMATCH, varianceFee=100', () => {
  const fpRows = [fp('3554599002', 300000)];
  const bankRows = [
    bank('1560021930625/3554599002 042 MCM InhouseTrf', { debitAmount: 300000 }),
    bank('Transfer Fee 3554599002 3554599002 Transfer Fee 99102', { debitAmount: 200 }),
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'FEE_MISMATCH');
  assert.strictEqual(results[0].varianceFee, 100);
});

// ── TEST 8: NOMINAL_MISMATCH ────────────────────────────────────────────────
test('TEST 8: id cocok, principal beda dari nominal FP -> NOMINAL_MISMATCH', () => {
  const fpRows = [fp('3554599003', 100000)];
  const bankRows = [bank('1560021930625/3554599003 042 MCM InhouseTrf', { debitAmount: 90000 })];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'NOMINAL_MISMATCH');
});

// ── TEST 9: DUPLICATE_BANK ──────────────────────────────────────────────────
test('TEST 9: 2 baris principal dgn id sama -> DUPLICATE_BANK (bukan dijumlah)', () => {
  const fpRows = [fp('3554599004', 100000)];
  const bankRows = [
    bank('1560021930625/3554599004 042 MCM InhouseTrf', { debitAmount: 100000 }),
    bank('1560021930625/3554599004 042 MCM InhouseTrf duplikat', { debitAmount: 100000 }),
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_BANK');
});

// ── TEST 10: NEED_REVIEW (hanya fee, tanpa principal) ───────────────────────
test('TEST 10: hanya row Transfer Fee ditemukan tanpa principal -> NEED_REVIEW', () => {
  const fpRows = [fp('3554599005', 100000)];
  const bankRows = [bank('Transfer Fee 3554599005 3554599005 Transfer Fee 99102', { debitAmount: 100 })];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'NEED_REVIEW');
});

// ── TEST 11: REVERSAL ────────────────────────────────────────────────────────
test('TEST 11: Credit Amount ditemukan pada id yang sama -> REVERSAL (menimpa status lain)', () => {
  const fpRows = [fp('3554599006', 100000)];
  const bankRows = [
    bank('1560021930625/3554599006 042 MCM InhouseTrf', { debitAmount: 100000 }),
    bank('Transfer Fee 3554599006 3554599006 Transfer Fee 99102', { debitAmount: 100 }),
    bank('1560021930625/3554599006 042 MCM InhouseTrf reversal', { creditAmount: 100000 }),
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'REVERSAL');
});

// ── PENDING_BANK / FP_ONLY (grace period) ───────────────────────────────────
test('PENDING_BANK: belum ada di bank, masih dalam grace period', () => {
  const fpRows = [fp('3554599007', 50000, { timeResponse: new Date(Date.now() - 5 * 60000) })];
  const results = reconcileMandiriTransactions(fpRows, [], { graceMinutes: 30 }, new Date());
  assert.strictEqual(results[0].reconStatus, 'PENDING_BANK');
});
test('FP_ONLY: belum ada di bank, sudah lewat grace period', () => {
  const fpRows = [fp('3554599008', 50000, { timeResponse: new Date(Date.now() - 60 * 60000) })];
  const results = reconcileMandiriTransactions(fpRows, [], { graceMinutes: 30 }, new Date());
  assert.strictEqual(results[0].reconStatus, 'FP_ONLY');
});

// ── DUPLICATE_FP ─────────────────────────────────────────────────────────────
test('DUPLICATE_FP: id_transaksi muncul 2x di DATA FP', () => {
  const fpRows = [fp('3554599009', 50000), fp('3554599009', 50000)];
  const results = reconcileMandiriTransactions(fpRows, [], {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP');
});

// ── BANK_ONLY + scope mode ───────────────────────────────────────────────────
test('BANK_ONLY: principal bank ditemukan, id tidak ada di FP manapun (FULL_BUSINESS_DATE)', () => {
  const fpRows = [fp('3554599010', 50000, { timeResponse: new Date('2026-07-10T10:00:00+07:00') })];
  const bankRows = [
    bank('1560021930625/3554599010 042 MCM InhouseTrf', { debitAmount: 50000, postDate: new Date('2026-07-10T10:05:00+07:00') }),
    bank('1560021930625/9999999999 042 MCM InhouseTrf', { debitAmount: 20000, postDate: new Date('2026-07-10T10:10:00+07:00') }),
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, { scopeMode: 'FULL_BUSINESS_DATE' }, new Date());
  const bankOnly = results.filter(r => r.reconStatus === 'BANK_ONLY');
  assert.strictEqual(bankOnly.length, 1);
  assert.strictEqual(bankOnly[0].referenceNo, '9999999999');
});
test('BANK_ONLY: fee-only/credit-only group TIDAK dianggap kandidat BANK_ONLY (bukan transaksi berdiri sendiri)', () => {
  const fpRows = [fp('3554599011', 50000)];
  const bankRows = [
    bank('1560021930625/3554599011 042 MCM InhouseTrf', { debitAmount: 50000 }),
    bank('Transfer Fee 8888888888 8888888888 Transfer Fee 99102', { debitAmount: 100 }), // fee tanpa principal, id lain
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, {}, new Date());
  assert.ok(!results.some(r => r.reconStatus === 'BANK_ONLY'), 'fee-only group tidak boleh flood jadi BANK_ONLY');
});
test('FP_COVERAGE_WINDOW (default): mutasi bank JAUH di luar rentang waktu FP -> diabaikan (bukan BANK_ONLY)', () => {
  const fpRows = [fp('3554599012', 50000, { timeResponse: new Date('2026-07-10T10:00:00+07:00') })];
  const bankRows = [
    bank('1560021930625/3554599012 042 MCM InhouseTrf', { debitAmount: 50000, postDate: new Date('2026-07-10T10:05:00+07:00') }),
    bank('1560021930625/7777777777 042 MCM InhouseTrf', { debitAmount: 10000, postDate: new Date('2026-07-09T02:00:00+07:00') }), // >30 jam sebelum window
  ];
  const results = reconcileMandiriTransactions(fpRows, bankRows, { coverageToleranceMinutes: 60 }, new Date());
  assert.ok(!results.some(r => r.reconStatus === 'BANK_ONLY'), 'default scope FP_COVERAGE_WINDOW harus mengabaikan mutasi jauh di luar window');
});

// ── Validasi saldo (section 14) ──────────────────────────────────────────────
test('validateMandiriBalance: urutan ASCENDING konsisten -> BALANCED', () => {
  const rows = [
    { sourceRowNumber: 1, debitAmount: 0, creditAmount: 0, closeBalance: 1000000 },
    { sourceRowNumber: 2, debitAmount: 690614, creditAmount: 0, closeBalance: 309386 },
    { sourceRowNumber: 3, debitAmount: 100, creditAmount: 0, closeBalance: 309286 },
  ];
  const v = validateMandiriBalance(rows);
  assert.strictEqual(v.status, 'BALANCED');
  assert.strictEqual(v.direction, 'ASC');
});
test('validateMandiriBalance: urutan DESCENDING konsisten -> BALANCED, direction DESC', () => {
  const rows = [
    { sourceRowNumber: 1, debitAmount: 100, creditAmount: 0, closeBalance: 309286 },
    { sourceRowNumber: 2, debitAmount: 690614, creditAmount: 0, closeBalance: 309386 },
    { sourceRowNumber: 3, debitAmount: 0, creditAmount: 0, closeBalance: 1000000 },
  ];
  const v = validateMandiriBalance(rows);
  assert.strictEqual(v.status, 'BALANCED');
  assert.strictEqual(v.direction, 'DESC');
});
test('validateMandiriBalance: data tidak konsisten sama sekali -> UNDETERMINED/UNBALANCED, tidak error', () => {
  const rows = [
    { sourceRowNumber: 1, debitAmount: 5, creditAmount: 0, closeBalance: 999 },
    { sourceRowNumber: 2, debitAmount: 999999, creditAmount: 0, closeBalance: 12345 },
  ];
  const v = validateMandiriBalance(rows);
  assert.ok(['UNBALANCED', 'BALANCE_CHECK_UNDETERMINED'].includes(v.status));
});
test('validateMandiriBalance: kurang dari 2 baris -> UNDETERMINED', () => {
  const v = validateMandiriBalance([{ sourceRowNumber: 1, debitAmount: 0, creditAmount: 0, closeBalance: 1000 }]);
  assert.strictEqual(v.status, 'BALANCE_CHECK_UNDETERMINED');
});

// ── parseFlexibleDateTime (section 8) ────────────────────────────────────────
test('parseFlexibleDateTime: "YYYY-MM-DD H:mm:ss" & "HH:mm:ss" 1/2 digit jam', () => {
  const a = parseFlexibleDateTime('2026-07-10 3:19:11');
  const b = parseFlexibleDateTime('2026-07-10 03:19:11');
  assert.strictEqual(a.getTime(), b.getTime());
});
test('parseFlexibleDateTime: "DD/MM/YYYY H:mm" & "HH:mm" 1/2 digit jam', () => {
  const a = parseFlexibleDateTime('10/07/2026 3:20');
  const b = parseFlexibleDateTime('10/07/2026 03:20');
  assert.strictEqual(a.getTime(), b.getTime());
});
test('parseFlexibleDateTime: di-anchor ke Asia/Jakarta (+07:00), bukan timezone server', () => {
  const d = parseFlexibleDateTime('2026-07-10 10:00:00');
  assert.strictEqual(d.toISOString(), '2026-07-10T03:00:00.000Z');
});
test('parseFlexibleDateTime: kosong/null -> null', () => {
  assert.strictEqual(parseFlexibleDateTime(''), null);
  assert.strictEqual(parseFlexibleDateTime(null), null);
});

// ── timeDelayBucket (section 8) ──────────────────────────────────────────────
test('timeDelayBucket: kategori selisih waktu', () => {
  assert.strictEqual(timeDelayBucket(3), 'normal');
  assert.strictEqual(timeDelayBucket(5), 'normal');
  assert.strictEqual(timeDelayBucket(10), 'warning');
  assert.strictEqual(timeDelayBucket(20), 'delayed');
  assert.strictEqual(timeDelayBucket(45), 'exception');
  assert.strictEqual(timeDelayBucket(-45), 'exception');
  assert.strictEqual(timeDelayBucket(null), null);
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
