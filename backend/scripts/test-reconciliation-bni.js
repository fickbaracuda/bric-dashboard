'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (cek package.json), jadi tidak menambah dependency baru. Pola
// SAMA dgn test-reconciliation-bri-bifast.js/test-reconciliation-ocbc.js.
// Run: node backend/scripts/test-reconciliation-bni.js

const assert = require('assert');
const {
  isBniFpCandidate, extractBniIdentifiers, classifyBniBankRow, parseBniDateTime, formatDateJakartaBni,
  computeBniCoverage, classifyBniCoverageStatus, reconcileBniTransactions, buildBniBankFingerprint,
} = require('../src/reconciliation/bniAdapter');
const {
  buildTransactionsQuery,
} = require('../src/routes/warroom-reconciliation-bni');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Helpers ────────────────────────────────────────────────────────────
function fp(idTransaksi, nominal, opts = {}) {
  return {
    idTransaksi, nominal, idOutlet: opts.idOutlet || 'FA823159', idProduk: opts.idProduk || 'BLSTR',
    idBiller: opts.idBiller !== undefined ? opts.idBiller : '141', timeResponse: opts.timeResponse || null,
  };
}
function rawBankRow(opts = {}) {
  return {
    bankCode: 'BNI', businessDate: opts.businessDate || '2026-07-22',
    description: opts.description || null, debit: opts.debit !== undefined ? opts.debit : null,
    credit: opts.credit !== undefined ? opts.credit : null,
    transactionDateTime: opts.transactionDateTime || null,
    postDateRaw: opts.postDateRaw || null, valueDateRaw: opts.valueDateRaw || null,
    branch: opts.branch || '0246', journalNo: opts.journalNo || 'JRN001',
  };
}
/** Preprocess mentah -> siap dipakai reconcileBniTransactions() -- MIRROR
 * urutan yang dilakukan syncHandler produksi (extract -> coverage -> classify). */
function preprocessBankRows(rawRows, fpRows, toleranceBefore = 5, toleranceAfter = 5) {
  const coverage = computeBniCoverage(fpRows, toleranceBefore, toleranceAfter);
  return rawRows.map(row => {
    const extraction = extractBniIdentifiers(row.description);
    const coverageStatus = classifyBniCoverageStatus(row.transactionDateTime, coverage);
    const bankRowType = classifyBniBankRow(row, extraction, coverageStatus);
    const bankFingerprint = buildBniBankFingerprint(row);
    return { ...row, ...extraction, bankRowType, coverageStatus, bankFingerprint };
  });
}
function jkt(dateTimeStr) { return new Date(`${dateTimeStr}+07:00`); }
function fastpayDesc(id, opts = {}) {
  const refToken = (opts.refPrefix || '35') + id;
  const beneficiary = opts.beneficiary || '0246405258';
  return `TRANSFER KE | BMS_SNAP API #${id} FASTPAY ${beneficiary}/${refToken} | ${opts.recipient || 'KOPERASI KREDIT HANDAYANI BAJAWA'}`;
}

// ── TEST 1: id_biller selain 141 tidak menjadi kandidat FP ──────────────
test('TEST 1: id_biller selain 141 tidak menjadi kandidat FP', () => {
  assert.strictEqual(isBniFpCandidate(fp('3562421092', 300000, { idBiller: '141' })), true);
  assert.strictEqual(isBniFpCandidate(fp('3562421092', 300000, { idBiller: '999' })), false);
  assert.strictEqual(isBniFpCandidate(fp('3562421092', 300000, { idBiller: null })), false);
});

// ── TEST 2: ID setelah BMS_SNAP API # berhasil diekstrak ────────────────
test('TEST 2: ID setelah BMS_SNAP API # berhasil diekstrak', () => {
  const desc = 'TRANSFER KE | BMS_SNAP API #3562421092 FASTPAY 0246405258/353562421092 | KOPERASI KREDIT HANDAYANI BAJAWA';
  const info = extractBniIdentifiers(desc);
  assert.strictEqual(info.transactionIdFromHash, '3562421092');
});

// ── TEST 3: Reference slash menghasilkan 10 digit terakhir ──────────────
test('TEST 3: reference slash 353562421092 -> 10 digit terakhir 3562421092', () => {
  const info1 = extractBniIdentifiers('FASTPAY 0246405258/353562421092');
  assert.strictEqual(info1.transactionIdFromReference, '3562421092');
  const info2 = extractBniIdentifiers('FASTPAY 846948293/3563562425311');
  assert.strictEqual(info2.transactionIdFromReference, '3562425311');
});

// ── TEST 4: dua sumber sama -> HIGH ──────────────────────────────────────
test('TEST 4: hash & reference sama -> HIGH, extractedTransactionId terisi', () => {
  const desc = fastpayDesc('3562421092');
  const info = extractBniIdentifiers(desc);
  assert.strictEqual(info.transactionIdFromHash, '3562421092');
  assert.strictEqual(info.transactionIdFromReference, '3562421092');
  assert.strictEqual(info.extractionConfidence, 'HIGH');
  assert.strictEqual(info.extractedTransactionId, '3562421092');
  assert.strictEqual(info.idConflict, false);
});

// ── TEST 5: hanya satu sumber -> MEDIUM ──────────────────────────────────
test('TEST 5: hanya hash tersedia -> MEDIUM', () => {
  const info = extractBniIdentifiers('BMS_SNAP API #3562421092 (tanpa reference slash)');
  assert.strictEqual(info.extractionConfidence, 'MEDIUM');
  assert.strictEqual(info.extractedTransactionId, '3562421092');
});
test('TEST 5b: hanya reference tersedia -> MEDIUM', () => {
  const info = extractBniIdentifiers('FASTPAY 0246405258/353562421092 (tanpa hash)');
  assert.strictEqual(info.extractionConfidence, 'MEDIUM');
  assert.strictEqual(info.extractedTransactionId, '3562421092');
});

// ── TEST 6: dua sumber berbeda -> CONFLICT ───────────────────────────────
test('TEST 6: hash & reference berbeda -> CONFLICT, extractedTransactionId null', () => {
  const desc = 'BMS_SNAP API #3562421092 FASTPAY 0246405258/359999999999';
  const info = extractBniIdentifiers(desc);
  assert.strictEqual(info.transactionIdFromHash, '3562421092');
  assert.strictEqual(info.transactionIdFromReference, '9999999999');
  assert.strictEqual(info.extractionConfidence, 'CONFLICT');
  assert.strictEqual(info.idConflict, true);
  assert.strictEqual(info.extractedTransactionId, null, 'CONFLICT tidak boleh diam-diam memilih salah satu');
});

// ── TEST 7: leading zero beneficiary account tetap utuh ──────────────────
test('TEST 7: leading zero beneficiary_account dipertahankan (BUKAN Number())', () => {
  const info = extractBniIdentifiers(fastpayDesc('3562421092', { beneficiary: '0012345678' }));
  assert.strictEqual(info.beneficiaryAccount, '0012345678');
  assert.strictEqual(typeof info.beneficiaryAccount, 'string');
});

// ── TEST 8: format DD/MM/YY HH.mm.ss diparse Jakarta dgn benar ───────────
test('TEST 8: parseBniDateTime "22/07/26 08.39.01" -> 2026-07-22T08:39:01+07:00', () => {
  const dt = parseBniDateTime('22/07/26 08.39.01');
  assert.ok(dt instanceof Date && !Number.isNaN(dt.getTime()));
  assert.strictEqual(formatDateJakartaBni(dt), '2026-07-22');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(dt).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  assert.strictEqual(`${parts.hour}:${parts.minute}:${parts.second}`, '08:39:01');
});
test('TEST 8b: parseBniDateTime tidak fallback ke Date.parse native (format sampah -> null)', () => {
  assert.strictEqual(parseBniDateTime('bukan tanggal'), null);
});

// ── TEST 9: exact ID dan nominal -> MATCHED ──────────────────────────────
test('TEST 9: exact ID + nominal sama (expected_fee=0) -> MATCHED', () => {
  const fpRows = [fp('3562421092', 300000, { timeResponse: jkt('2026-07-22T08:39:01') })];
  const rawBank = [rawBankRow({ description: fastpayDesc('3562421092'), debit: 300000, transactionDateTime: jkt('2026-07-22T08:39:01') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'MATCHED');
  assert.strictEqual(results[0].bankPrincipal, 300000);
});

// ── TEST 10: exact ID tapi nominal beda -> NOMINAL_MISMATCH ──────────────
test('TEST 10: exact ID, nominal bank beda dari FP -> NOMINAL_MISMATCH', () => {
  const fpRows = [fp('3562421093', 300000, { timeResponse: jkt('2026-07-22T08:40:00') })];
  const rawBank = [rawBankRow({ description: fastpayDesc('3562421093'), debit: 250000, transactionDateTime: jkt('2026-07-22T08:40:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results[0].reconStatus, 'NOMINAL_MISMATCH');
});

// ── TEST 11: duplicate FP -> DUPLICATE_FP ────────────────────────────────
test('TEST 11: id_transaksi muncul 2x di DATA FP -> DUPLICATE_FP', () => {
  const fpRows = [fp('3562421094', 100000, { timeResponse: jkt('2026-07-22T08:00:00') }), fp('3562421094', 100000, { timeResponse: jkt('2026-07-22T08:00:00') })];
  const results = reconcileBniTransactions(fpRows, [], { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP');
});

// ── TEST 12: duplicate debit ID -> DUPLICATE_BANK ────────────────────────
test('TEST 12: >1 baris debit dgn transaction ID sama -> DUPLICATE_BANK', () => {
  const fpRows = [fp('3562421095', 100000, { timeResponse: jkt('2026-07-22T08:00:00') })];
  const rawBank = [
    rawBankRow({ description: fastpayDesc('3562421095'), debit: 100000, transactionDateTime: jkt('2026-07-22T08:00:00') }),
    rawBankRow({ description: fastpayDesc('3562421095'), debit: 100000, transactionDateTime: jkt('2026-07-22T08:00:05'), journalNo: 'JRN002' }),
  ];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_BANK');
});

// ── TEST 13: belum lewat grace -> PENDING_BANK ───────────────────────────
test('TEST 13: FP belum ada bank match, umur < grace period -> PENDING_BANK', () => {
  const fpRows = [fp('3562421096', 100000, { timeResponse: jkt('2026-07-22T09:50:00') })];
  const results = reconcileBniTransactions(fpRows, [], { expectedFee: 0, graceMinutes: 30 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results[0].reconStatus, 'PENDING_BANK');
});

// ── TEST 14: lewat grace -> FP_ONLY ──────────────────────────────────────
test('TEST 14: FP belum ada bank match, umur >= grace period -> FP_ONLY', () => {
  const fpRows = [fp('3562421097', 100000, { timeResponse: jkt('2026-07-22T09:00:00') })];
  const results = reconcileBniTransactions(fpRows, [], { expectedFee: 0, graceMinutes: 30 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results[0].reconStatus, 'FP_ONLY');
});

// ── TEST 15: valid unmatched debit di dalam coverage -> BANK_ONLY ────────
test('TEST 15: FASTPAY_DEBIT valid tanpa pasangan FP, DALAM coverage -> BANK_ONLY', () => {
  // 2 FP row dgn rentang waktu supaya "core" coverage window (fpMinTime..
  // fpMaxTime) tidak zero-width -- baris bank standalone diletakkan PERSIS
  // di tengah rentang itu supaya INSIDE_FP_COVERAGE (bukan BOUNDARY_PARTIAL).
  const fpRows = [
    fp('3562421098', 100000, { timeResponse: jkt('2026-07-22T08:35:00') }),
    fp('3562421198', 150000, { timeResponse: jkt('2026-07-22T08:45:00') }),
  ];
  const rawBank = [rawBankRow({ description: fastpayDesc('9999999999'), debit: 50000, transactionDateTime: jkt('2026-07-22T08:39:30') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  const bankOnly = results.find(r => r.idTransaksi === null);
  assert.ok(bankOnly, 'harus ada hasil BANK_ONLY sintetis');
  assert.strictEqual(bankOnly.reconStatus, 'BANK_ONLY');
});

// ── TEST 16: debit di luar coverage -> TIDAK BANK_ONLY ───────────────────
test('TEST 16: FASTPAY_DEBIT valid tanpa pasangan FP, LUAR coverage -> TIDAK ada BANK_ONLY', () => {
  const fpRows = [fp('3562421099', 100000, { timeResponse: jkt('2026-07-22T08:39:00') })];
  // FP coverage window ~ 08:34-08:44 (+-5mnt default). Bank row jam 11:56 -> jauh di luar.
  const rawBank = [rawBankRow({ description: fastpayDesc('8888888888'), debit: 50000, transactionDateTime: jkt('2026-07-22T11:56:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  assert.strictEqual(bankRows[0].coverageStatus, 'OUTSIDE_FP_COVERAGE');
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T12:30:00'));
  const bankOnly = results.find(r => r.idTransaksi === null);
  assert.strictEqual(bankOnly, undefined, 'debit di luar coverage TIDAK boleh menghasilkan BANK_ONLY sintetis');
});

// ── TEST 17 & 18: funding credit bukan BANK_ONLY/REVERSAL ────────────────
test('TEST 17 & 18: FUNDING_CREDIT tidak menjadi BANK_ONLY maupun REVERSAL', () => {
  const fpRows = [fp('3562421100', 100000, { timeResponse: jkt('2026-07-22T08:39:00') })];
  const rawBank = [rawBankRow({ description: 'TRANSFER DARI | PB KE BNI MULTIBILLER | BIMASAKTI MULTI SINERGI', credit: 120000000, transactionDateTime: jkt('2026-07-22T08:39:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  assert.strictEqual(bankRows[0].bankRowType, 'FUNDING_CREDIT');
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  const synthetic = results.filter(r => r.idTransaksi === null);
  assert.strictEqual(synthetic.length, 0, 'FUNDING_CREDIT tidak boleh menghasilkan recon_results sama sekali');
});

// ── TEST 19: credit Fastpay exact ID -> REVERSAL ─────────────────────────
test('TEST 19: FASTPAY debit + credit exact ID sama hari -> REVERSAL', () => {
  const fpRows = [fp('3562421101', 300000, { timeResponse: jkt('2026-07-22T08:39:00') })];
  const rawBank = [
    rawBankRow({ description: fastpayDesc('3562421101'), debit: 300000, transactionDateTime: jkt('2026-07-22T08:39:00') }),
    rawBankRow({ description: fastpayDesc('3562421101'), credit: 300000, transactionDateTime: jkt('2026-07-22T09:00:00'), journalNo: 'JRN-REV' }),
  ];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'REVERSAL');
  assert.strictEqual(results[0].reversalAmount, 300000);
});

// ── TEST 20: malformed ID di coverage -> NEED_REVIEW ─────────────────────
test('TEST 20: deskripsi FASTPAY tapi ID malformed, DALAM coverage -> NEED_REVIEW', () => {
  const fpRows = [
    fp('3562421102', 100000, { timeResponse: jkt('2026-07-22T08:35:00') }),
    fp('3562421202', 120000, { timeResponse: jkt('2026-07-22T08:45:00') }),
  ];
  const rawBank = [rawBankRow({ description: 'TRANSFER KE | BMS_SNAP API #3562 FASTPAY tanpa referensi valid', debit: 50000, transactionDateTime: jkt('2026-07-22T08:40:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  assert.strictEqual(bankRows[0].bankRowType, 'NEED_REVIEW');
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  const review = results.find(r => r.idTransaksi === null);
  assert.ok(review);
  assert.strictEqual(review.reconStatus, 'NEED_REVIEW');
});
test('TEST 20b: deskripsi FASTPAY malformed ID, LUAR coverage -> OUT_OF_SCOPE (bukan actionable)', () => {
  const fpRows = [fp('3562421103', 100000, { timeResponse: jkt('2026-07-22T08:39:00') })];
  const rawBank = [rawBankRow({ description: 'TRANSFER KE | BMS_SNAP API #99 FASTPAY tanpa referensi valid', debit: 50000, transactionDateTime: jkt('2026-07-22T12:00:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  assert.strictEqual(bankRows[0].bankRowType, 'OUT_OF_SCOPE');
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T13:00:00'));
  assert.strictEqual(results.filter(r => r.idTransaksi === null).length, 0, 'di luar coverage tidak boleh jadi actionable exception');
});

// ── TEST 21: consumed bank row tidak menjadi BANK_ONLY ───────────────────
test('TEST 21: bank group yang sudah match ke FP TIDAK muncul lagi sbg BANK_ONLY', () => {
  const fpRows = [fp('3562421104', 300000, { timeResponse: jkt('2026-07-22T08:39:00') })];
  const rawBank = [rawBankRow({ description: fastpayDesc('3562421104'), debit: 300000, transactionDateTime: jkt('2026-07-22T08:39:00') })];
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T10:00:00'));
  assert.strictEqual(results.length, 1, 'HARUS cuma 1 result (MATCHED), bukan MATCHED + BANK_ONLY terpisah');
  assert.strictEqual(results[0].reconStatus, 'MATCHED');
});

// ── TEST 22: fingerprint stabil saat row sheet berpindah (source_row TIDAK dipakai) ──
test('TEST 22: buildBniBankFingerprint TIDAK dipengaruhi source_row (posisi baris sheet)', () => {
  const rowA = { bankCode: 'BNI', postDateRaw: '22/07/26 08.39.01', valueDateRaw: '22/07/26', branch: '0246', journalNo: 'JRN001', description: fastpayDesc('3562421105'), debit: 300000, credit: null, sourceRow: 15 };
  const rowB = { ...rowA, sourceRow: 42 }; // sheet bergeser, baris SAMA persis kecuali posisi
  assert.strictEqual(buildBniBankFingerprint(rowA), buildBniBankFingerprint(rowB));
});
test('TEST 22b: fingerprint BEDA kalau debit berbeda', () => {
  const rowA = { bankCode: 'BNI', postDateRaw: '22/07/26 08.39.01', valueDateRaw: '22/07/26', branch: '0246', journalNo: 'JRN001', description: fastpayDesc('3562421105'), debit: 300000, credit: null };
  const rowB = { ...rowA, debit: 300001 };
  assert.notStrictEqual(buildBniBankFingerprint(rowA), buildBniBankFingerprint(rowB));
});

// ── TEST 23 & 24: idempotensi resync & manual resolve bertahan ──────────
// CATATAN: TEST 23 (resync tidak menggandakan raw bank) dan TEST 24 (manual
// resolve bertahan setelah resync) BERGANTUNG pada UNIQUE index DB
// (row_fingerprint utk recon_bank_transactions, (batch_id,
// canonical_transaction_key) utk recon_results) + ON CONFLICT upsert di
// syncHandler -- TIDAK bisa di-unit-test murni tanpa DB (pola SAMA dgn
// runOcbcEngineAndPersist/runOcbcEngineAndPersist di OCBC, lihat catatan
// panjang di test-reconciliation-ocbc.js). Jaminan level fungsi PURE-nya
// sudah dicek TEST 22 (fingerprint deterministik/stabil) -- itu prasyarat
// supaya ON CONFLICT (row_fingerprint) DO NOTHING benar2 mencegah duplikat
// saat resync data identik. Diverifikasi end-to-end lewat server sungguhan
// (sync 2x berturut-turut, cek result_count/row count identik).

// ── TEST 25, 26, 27: sample acceptance 37 transaksi ──────────────────────
function buildSample37() {
  const fpRows = [];
  const rawBank = [];
  let totalNominal = 0;
  for (let i = 1; i <= 37; i++) {
    const id = String(3562421000 + i).padStart(10, '0');
    const nominal = i < 37 ? 730000 : (27023888 - 36 * 730000); // 36 x 730.000 + sisa = 27.023.888 persis
    totalNominal += nominal;
    const minute = 39 + Math.floor(i / 2);
    const second = (i % 60);
    const timeStr = `2026-07-22T${String(8 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    const t = jkt(timeStr);
    fpRows.push(fp(id, nominal, { timeResponse: t }));
    rawBank.push(rawBankRow({ description: fastpayDesc(id), debit: nominal, transactionDateTime: t }));
  }
  // 2 baris funding credit total Rp200.000.000
  rawBank.push(rawBankRow({ description: 'TRANSFER DARI | PB KE BNI MULTIBILLER | BIMASAKTI MULTI SINERGI', credit: 120000000, transactionDateTime: jkt('2026-07-22T07:00:00') }));
  rawBank.push(rawBankRow({ description: 'TRANSFER DARI | PB KE BNI MULTIBILLER | BIMASAKTI MULTI SINERGI', credit: 80000000, transactionDateTime: jkt('2026-07-22T07:30:00') }));
  return { fpRows, rawBank, totalNominal };
}

test('TEST 25: sample 37 transaksi FP exact match -> 37 MATCHED', () => {
  const { fpRows, rawBank } = buildSample37();
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T12:00:00'));
  const matched = results.filter(r => r.reconStatus === 'MATCHED');
  assert.strictEqual(matched.length, 37, `harus 37 MATCHED, got ${matched.length}. Statuses: ${JSON.stringify(results.map(r => r.reconStatus))}`);
});

test('TEST 26: total matched nominal sample = Rp27.023.888', () => {
  const { fpRows, rawBank, totalNominal } = buildSample37();
  assert.strictEqual(totalNominal, 27023888, 'fixture generator harus menghasilkan total persis Rp27.023.888');
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const results = reconcileBniTransactions(fpRows, bankRows, { expectedFee: 0 }, jkt('2026-07-22T12:00:00'));
  const matchedNominal = results.filter(r => r.reconStatus === 'MATCHED').reduce((s, r) => s + r.fpNominal, 0);
  assert.strictEqual(matchedNominal, 27023888);
});

test('TEST 27: funding credit sample = Rp200.000.000', () => {
  const { fpRows, rawBank } = buildSample37();
  const bankRows = preprocessBankRows(rawBank, fpRows);
  const fundingRows = bankRows.filter(r => r.bankRowType === 'FUNDING_CREDIT');
  assert.strictEqual(fundingRows.length, 2);
  const totalFunding = fundingRows.reduce((s, r) => s + r.credit, 0);
  assert.strictEqual(totalFunding, 200000000);
});

// ── TEST 28 & 29: active batch exact date, tidak fallback ────────────────
test('TEST 28: buildTransactionsQuery -- date diberikan -> WHERE menyertakan business_date exact', () => {
  const { whereClause, params } = buildTransactionsQuery({ query: { date: '2026-07-22' } });
  assert.ok(whereClause.includes('b.business_date ='), 'harus filter exact business_date, bukan fallback');
  assert.ok(params.includes('2026-07-22'));
});
test('TEST 29: buildTransactionsQuery -- tanpa date -> TIDAK ada filter business_date sama sekali (bukan diam-diam pilih batch lain)', () => {
  const { whereClause } = buildTransactionsQuery({ query: {} });
  assert.ok(!whereClause.includes('business_date'));
});

// TEST 30 (frontend build) & 31 (test BNI ini sendiri lulus) diverifikasi
// di luar file ini (npm run build di frontend/, dan exit code runner di
// bawah). TEST 32 (test shared reconciliation core tetap lulus)
// diverifikasi dgn menjalankan node backend/scripts/test-reconciliation-ocbc.js
// terpisah (TIDAK di-import ke sini supaya modul BNI tetap independen).

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
