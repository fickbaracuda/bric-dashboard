'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-reconciliation-mandiri.js (belum ada test framework
// di project ini). Run: node backend/scripts/test-reconciliation-bca.js
//
// Sample deskripsi & angka di bawah adalah DATA NYATA yang dibaca langsung
// dari spreadsheet BCA saat discovery (1BkHetxYcM4FzrZIljPER5QRzTHIjRffuQ15IdyZNe3k,
// sheet "Data Bank BCA", 2026-07-09) — bukan data rekaan.
//
// Catatan: idempotensi sync ("sync ulang batch yang sama tidak boleh
// menggandakan row") adalah perilaku level DB (delete raw + upsert
// recon_results via unique index canonical_transaction_key), bukan sesuatu
// yang dites di level pure-function di sini — sama seperti pola test
// OCBC/Mandiri/BNI. Diverifikasi langsung lewat endpoint sync di server
// (lihat laporan implementasi).

const assert = require('assert');
const {
  extractBcaFpTransactionId, parseBcaAmountAndDirection, classifyBcaCreditType,
  parseBcaBankRow, reconcileBcaTransactions, validateBcaBalance,
} = require('../src/reconciliation/bcaAdapter');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, nominal, opts = {}) {
  return {
    idTransaksi, nominal,
    idOutlet: opts.idOutlet ?? 'HH82915', idProduk: opts.idProduk ?? 'BLTRFAG', idBiller: opts.idBiller ?? '11997',
    timeResponse: opts.timeResponse ?? null,
  };
}
function bankRow(description, jumlah, opts = {}) {
  const parsed = parseBcaBankRow(description, jumlah);
  return {
    transactionDate: opts.transactionDate ?? new Date('2026-07-09'),
    description, debit: parsed.debit, credit: parsed.credit, direction: parsed.direction,
    balance: opts.balance ?? null, sourceRowNumber: opts.sourceRowNumber ?? null,
    extractedTransactionId: parsed.extractedTransactionId, bankRowType: parsed.bankRowType,
    extractionMethod: parsed.extractionMethod, creditClassification: parsed.creditClassification,
  };
}

// ── B. BCA Description Parser ──────────────────────────────────────────────
test('extract: contoh nyata "/3553980633" (10 digit)', () => {
  const id = extractBcaFpTransactionId('TRSF E-BANKING DB 0807/FTSCY/WS95051 25000.00 FASTPAY 1300436630 /3553980633 LULUS BUDI SAMPURN');
  assert.strictEqual(id, '3553980633');
});
test('extract: contoh nyata "/947219930" (9 digit, skema berbeda)', () => {
  const id = extractBcaFpTransactionId('TRSF E-BANKING DB 0807/FTSCY/WS95051 4334445.00 FASTPAY 4590001665 /947219930 MELINDA CRISTIANI');
  assert.strictEqual(id, '947219930');
});
test('extract: mengabaikan nama penerima setelah ID', () => {
  const id = extractBcaFpTransactionId('.../3553981026 IBNU NUR SALIM');
  assert.strictEqual(id, '3553981026');
});
test('extract: whitespace di awal/akhir tidak mempengaruhi hasil', () => {
  const id = extractBcaFpTransactionId('   .../3553981167 UNDANG KUSMANA   ');
  assert.strictEqual(id, '3553981167');
});
test('extract: slash lain di deskripsi (bukan diikuti angka murni) tidak salah tertangkap', () => {
  const id = extractBcaFpTransactionId('TRSF E-BANKING DB 0807/FTSCY/WS95051 25000.00 FASTPAY 1300436630 /3553980633 LULUS BUDI SAMPURN');
  // "0807/FTSCY" dan "FTSCY/WS95051" TIDAK boleh ke-ambil -- harus slash TERAKHIR.
  assert.notStrictEqual(id, '0807');
  assert.strictEqual(id, '3553980633');
});
test('extract: multiple slash+digit -- ambil yang TERAKHIR (bukan yang pertama)', () => {
  const id = extractBcaFpTransactionId('X 111/222 FASTPAY 333 /444555666 NAMA');
  assert.strictEqual(id, '444555666');
});
test('extract: deskripsi kredit internal (tanpa pola "/<digit> nama") -> null (unparseable)', () => {
  const id = extractBcaFpTransactionId('TRSF E-BANKING CR 0907/FTSCY/WS95051 7500000000.00 PB KE BCA API BIMASAKTI MULTI SI');
  assert.strictEqual(id, null);
});
test('extract: deskripsi kosong/null -> null', () => {
  assert.strictEqual(extractBcaFpTransactionId(''), null);
  assert.strictEqual(extractBcaFpTransactionId(null), null);
});
test('extract: non-FASTPAY description tanpa slash -> null', () => {
  assert.strictEqual(extractBcaFpTransactionId('BIAYA ADM BULANAN'), null);
});

// ── C. Amount Parser ────────────────────────────────────────────────────────
test('amount: "25,000.00 DB" -> 25000, DB', () => {
  const r = parseBcaAmountAndDirection('25,000.00 DB');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.amount, 25000);
  assert.strictEqual(r.direction, 'DB');
});
test('amount: "7,500,000,000.00 CR" -> 7500000000, CR (nyata dari sample kredit tunggal)', () => {
  const r = parseBcaAmountAndDirection('7,500,000,000.00 CR');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.amount, 7500000000);
  assert.strictEqual(r.direction, 'CR');
});
test('amount: desimal 1 digit tetap valid', () => {
  const r = parseBcaAmountAndDirection('100.5 DB');
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.amount, 100.5);
});
test('amount: TIDAK ada floating-point precision loss utk nominal besar', () => {
  const r = parseBcaAmountAndDirection('7,500,000,000.00 CR');
  assert.strictEqual(Number.isInteger(r.amount), true);
  assert.strictEqual(r.amount, 7500000000);
});
test('amount: arah hilang -> invalid (MISSING_DIRECTION)', () => {
  const r = parseBcaAmountAndDirection('25,000.00');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'MISSING_DIRECTION');
});
test('amount: format rusak -> invalid (MALFORMED_AMOUNT)', () => {
  const r = parseBcaAmountAndDirection('duapuluh ribu DB');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'MALFORMED_AMOUNT');
});
test('amount: dua token arah -> invalid (MULTIPLE_DIRECTION_TOKENS)', () => {
  const r = parseBcaAmountAndDirection('25,000.00 DB CR');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'MULTIPLE_DIRECTION_TOKENS');
});
test('amount: string kosong -> invalid (EMPTY)', () => {
  const r = parseBcaAmountAndDirection('');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'EMPTY');
});

// ── Credit classification ──────────────────────────────────────────────────
test('credit: "PB KE BCA API..." -> FUNDING', () => {
  assert.strictEqual(classifyBcaCreditType('TRSF E-BANKING CR 0907/FTSCY/WS95051 7500000000.00 PB KE BCA API BIMASAKTI MULTI SI'), 'FUNDING');
});
test('credit: tidak ada pola dikenal -> UNKNOWN_CREDIT (bukan otomatis FUNDING)', () => {
  assert.strictEqual(classifyBcaCreditType('SETORAN TUNAI CABANG'), 'UNKNOWN_CREDIT');
});

// ── parseBcaBankRow: DB/CR routing end-to-end ──────────────────────────────
test('parseBcaBankRow: baris DB principal -> bankRowType PRINCIPAL, debit terisi, credit 0', () => {
  const r = parseBcaBankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB');
  assert.strictEqual(r.bankRowType, 'PRINCIPAL');
  assert.strictEqual(r.debit, 25000);
  assert.strictEqual(r.credit, 0);
  assert.strictEqual(r.extractedTransactionId, '3553980633');
});
test('parseBcaBankRow: baris CR -> bankRowType CREDIT, TIDAK mencoba ekstraksi ID sama sekali', () => {
  const r = parseBcaBankRow('PB KE BCA API BIMASAKTI MULTI SI', '7,500,000,000.00 CR');
  assert.strictEqual(r.bankRowType, 'CREDIT');
  assert.strictEqual(r.credit, 7500000000);
  assert.strictEqual(r.debit, 0);
  assert.strictEqual(r.extractedTransactionId, null);
  assert.strictEqual(r.creditClassification, 'FUNDING');
});
test('parseBcaBankRow: DB tanpa ID terekstrak -> bankRowType UNKNOWN, parseWarning UNPARSEABLE_REFERENCE', () => {
  const r = parseBcaBankRow('BIAYA ADM BULANAN', '15,000.00 DB');
  assert.strictEqual(r.bankRowType, 'UNKNOWN');
  assert.strictEqual(r.parseWarning, 'UNPARSEABLE_REFERENCE');
});

// ── D. Matching ─────────────────────────────────────────────────────────────
test('matching: ID & amount exact match -> MATCHED', () => {
  const results = reconcileBcaTransactions(
    [fp('3553980633', 25000)],
    [bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB')],
  );
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'MATCHED');
});
test('matching: ID match tapi amount beda -> AMOUNT_MISMATCH', () => {
  const results = reconcileBcaTransactions(
    [fp('3553980633', 30000)],
    [bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB')],
  );
  assert.strictEqual(results[0].reconStatus, 'AMOUNT_MISMATCH');
});
test('matching: FP-only (tidak ada padanan bank) -> FP_NOT_FOUND_IN_BANK', () => {
  const results = reconcileBcaTransactions([fp('9999999999', 1000)], []);
  assert.strictEqual(results[0].reconStatus, 'FP_NOT_FOUND_IN_BANK');
});
test('matching: bank-only (tidak ada padanan FP) -> BANK_NOT_FOUND_IN_FP', () => {
  const results = reconcileBcaTransactions(
    [],
    [bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB')],
  );
  const r = results.find(x => x.referenceNo === '3553980633');
  assert.strictEqual(r.reconStatus, 'BANK_NOT_FOUND_IN_FP');
});
test('matching: duplicate FP id -> DUPLICATE_FP_TRANSACTION_ID', () => {
  const results = reconcileBcaTransactions(
    [fp('3553980633', 25000), fp('3553980633', 25000)],
    [bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB')],
  );
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP_TRANSACTION_ID');
});
test('matching: duplicate bank id (2 baris bank id sama) -> DUPLICATE_BANK_TRANSACTION_ID', () => {
  const results = reconcileBcaTransactions(
    [fp('3553980633', 25000)],
    [
      bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB', { sourceRowNumber: 1 }),
      bankRow('.../3553980633 LULUS BUDI SAMPURN LAGI', '25,000.00 DB', { sourceRowNumber: 2 }),
    ],
  );
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_BANK_TRANSACTION_ID');
});
test('matching: ID 9-digit ("947...") tidak ada di FP -> tetap BANK_NOT_FOUND_IN_FP transparan (TIDAK ditebak)', () => {
  const results = reconcileBcaTransactions(
    [],
    [bankRow('.../947219930 MELINDA CRISTIANI', '4,334,445.00 DB')],
  );
  const r = results.find(x => x.referenceNo === '947219930');
  assert.strictEqual(r.reconStatus, 'BANK_NOT_FOUND_IN_FP');
});
test('matching: unparseable reference bank row -> UNPARSEABLE_REFERENCE, TIDAK dibuang', () => {
  const results = reconcileBcaTransactions([], [bankRow('BIAYA ADM BULANAN', '15,000.00 DB')]);
  const r = results.find(x => x.reconStatus === 'UNPARSEABLE_REFERENCE');
  assert.ok(r, 'baris unparseable harus tetap muncul di hasil utk review');
});
test('matching: credit EXCLUDED dari matching FP normal -> selalu CREDIT_TRANSACTION', () => {
  const results = reconcileBcaTransactions(
    [fp('7500000000', 7500000000)], // seandainya ada FP dgn nominal sama -> TETAP tidak match ke credit
    [bankRow('PB KE BCA API BIMASAKTI MULTI SI', '7,500,000,000.00 CR')],
  );
  const creditResult = results.find(r => r.reconStatus === 'CREDIT_TRANSACTION');
  assert.ok(creditResult, 'baris kredit harus muncul sbg CREDIT_TRANSACTION');
  const fpResult = results.find(r => r.idTransaksi === '7500000000');
  assert.strictEqual(fpResult.reconStatus, 'FP_NOT_FOUND_IN_BANK', 'FP tidak boleh matched ke baris kredit');
});

// ── E. Balance continuity (data nyata: ascending, verified via footer Saldo Awal/Akhir) ──
test('balance: urutan ASCENDING terdeteksi otomatis & OK (data nyata baris 8-10)', () => {
  const rows = [
    bankRow('.../3553980633 LULUS BUDI SAMPURN', '25,000.00 DB', { sourceRowNumber: 8, balance: 14780171783.96 }),
    bankRow('.../3553981026 IBNU NUR SALIM', '118,646.00 DB', { sourceRowNumber: 9, balance: 14780053137.96 }),
    bankRow('.../3553981167 UNDANG KUSMANA', '50,000.00 DB', { sourceRowNumber: 10, balance: 14780003137.96 }),
  ];
  const result = validateBcaBalance(rows);
  assert.strictEqual(result.direction, 'ASC');
  assert.strictEqual(result.status, 'BALANCE_CONTINUITY_OK');
  assert.strictEqual(result.mismatch_count, 0);
});
test('balance: kredit menambah saldo (bukan mengurangi)', () => {
  const rows = [
    bankRow('.../111 A', '100.00 DB', { sourceRowNumber: 1, balance: 900 }),
    bankRow('PB KE BCA API', '500.00 CR', { sourceRowNumber: 2, balance: 1400 }),
  ];
  const result = validateBcaBalance(rows);
  assert.strictEqual(result.status, 'BALANCE_CONTINUITY_OK');
});
test('balance: mismatch terdeteksi (selisih tidak masuk akal)', () => {
  const rows = [
    bankRow('.../111 A', '100.00 DB', { sourceRowNumber: 1, balance: 1000 }),
    bankRow('.../222 B', '100.00 DB', { sourceRowNumber: 2, balance: 500 }), // seharusnya 900, bukan 500
    bankRow('.../333 C', '100.00 DB', { sourceRowNumber: 3, balance: 400 }),
    bankRow('.../444 D', '100.00 DB', { sourceRowNumber: 4, balance: 300 }),
  ];
  const result = validateBcaBalance(rows);
  assert.strictEqual(result.mismatch_count > 0, true);
});
test('balance: data tidak cukup (<2 baris ber-saldo) -> INSUFFICIENT_DATA', () => {
  const result = validateBcaBalance([bankRow('.../111 A', '100.00 DB', { sourceRowNumber: 1, balance: 900 })]);
  assert.strictEqual(result.status, 'INSUFFICIENT_DATA');
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
