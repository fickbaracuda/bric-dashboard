'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (cek package.json), jadi tidak menambah dependency baru.
// Run: node backend/scripts/test-reconciliation-ocbc.js

const assert = require('assert');
const {
  reconcileTransactions, parseDescriptionFallback, cleanNum, numEq, toIsoDate, isValidIdTransaksi,
  reconcileTransactionsWithCoverage, calculateOcbcCoverage, classifyFpCoverage, isCompleteOcbcGroup,
  buildOcbcBankArchiveRows, computeBankRowFingerprint,
  parseOcbcRawDateTimeFallback, resolveOcbcTransactionDateTime,
} = require('../src/routes/warroom-reconciliation');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, nominal, opts = {}) {
  return { idTransaksi, nominal, idOutlet: opts.idOutlet || 'HH82915', idProduk: opts.idProduk || null, idBiller: opts.idBiller || null, timeResponse: opts.timeResponse || null };
}
function bankRow(referenceNo, { debit = null, credit = null, description = null, transactionDate = '2026-07-10' } = {}) {
  return { referenceNo, debit, credit, description, transactionDate };
}
// Helper KHUSUS test coverage-aware — bankRow() biasa TIDAK punya
// transactionDateTime (dianggap "tanpa presisi jam", coverage tidak
// membatasi). bankRowT() dipakai test TEST 1-9 yang butuh presisi menit.
function bankRowT(referenceNo, { debit = null, credit = null, description = null, transactionDateTime = null } = {}) {
  return { referenceNo, debit, credit, description, transactionDateTime };
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

// ── toIsoDate — regresi: hari/bulan sempat tertukar (13/07/2026 jadi
// 2026-13-07, ditolak Postgres karena bulan 13 tidak valid) ──────────────
test('toIsoDate: DD/MM/YYYY tidak tertukar hari/bulan', () => {
  assert.strictEqual(toIsoDate('13/07/2026'), '2026-07-13');
  assert.strictEqual(toIsoDate('01/12/2026'), '2026-12-01');
});
test('toIsoDate: DD/MM/YYYY dgn waktu (format asli OCBC "Transaction Date") tetap benar', () => {
  assert.strictEqual(toIsoDate('13/07/2026 10:27'), '2026-07-13');
});
test('toIsoDate: ISO passthrough', () => {
  assert.strictEqual(toIsoDate('2026-07-13'), '2026-07-13');
  assert.strictEqual(toIsoDate('2026-07-13T10:27:00.000Z'), '2026-07-13');
});
test('toIsoDate: kosong/null -> null', () => {
  assert.strictEqual(toIsoDate(''), null);
  assert.strictEqual(toIsoDate(null), null);
});

// ── isValidIdTransaksi — regresi: baris header CSV ke-paste ke tengah
// data DATA FP ("id_transaksi,nominal,id_produk,...") sempat lolos jadi
// "transaksi hantu" di hasil rekonsiliasi ────────────────────────────────
test('isValidIdTransaksi: id_transaksi asli (murni digit) valid', () => {
  assert.strictEqual(isValidIdTransaksi('3556344215'), true);
  assert.strictEqual(isValidIdTransaksi(3556344215), true);
});
test('isValidIdTransaksi: baris sampah/header ke-paste ditolak', () => {
  assert.strictEqual(isValidIdTransaksi('id_transaksi,nominal,id_produk,time_response'), false);
  assert.strictEqual(isValidIdTransaksi('abc123'), false);
  assert.strictEqual(isValidIdTransaksi(''), false);
  assert.strictEqual(isValidIdTransaksi(null), false);
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

// ═══════════════════════════════════════════════════════════════════════
// COVERAGE-AWARE RECONCILIATION — DATA BANK OCBC dibatasi 5.000 baris
// mutasi TERBARU di Google Sheet. TEST 1-11 di bawah memverifikasi
// coverage_status (dimensi TERPISAH dari recon_status, BUKAN status ke-12)
// dan rolling bank archive (recon_bank_archive) tidak menghilangkan
// kemampuan matching walau window 5.000 baris bergeser antar sync.
// ═══════════════════════════════════════════════════════════════════════

// ── TEST 1: FP di luar coverage ─────────────────────────────────────────
test('TEST 1: FP lebih tua dari trusted_coverage_start -> OUTSIDE_BANK_COVERAGE, recon_status NULL, tidak actionable, tidak masuk match rate', () => {
  const fpRows = [fp('1000000001', 50000, { timeResponse: new Date('2026-07-13T08:00:00+07:00') })];
  const bankRows = [
    bankRowT('9999999991', { debit: 100000, transactionDateTime: new Date('2026-07-13T10:00:23+07:00') }),
    bankRowT('9999999992', { debit: 100000, transactionDateTime: new Date('2026-07-13T10:05:00+07:00') }),
  ];
  const { results, coverage } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 2 }, new Date('2026-07-13T12:00:00+07:00'));
  assert.strictEqual(coverage.isSourceTruncated, true);
  const r = results.find(x => x.idTransaksi === '1000000001');
  assert.strictEqual(r.coverageStatus, 'OUTSIDE_BANK_COVERAGE');
  assert.strictEqual(r.reconStatus, null);
  assert.strictEqual(r.isActionable, false);
  assert.strictEqual(r.eligibleForMatchRate, false);
});

// ── TEST 2: FP dalam coverage, tidak ditemukan ──────────────────────────
test('TEST 2: FP dalam trusted coverage, tidak ditemukan & lewat grace period -> IN_BANK_COVERAGE + FP_ONLY (actionable)', () => {
  const fpRows = [fp('1000000002', 50000, { timeResponse: new Date('2026-07-13T11:00:00+07:00') })];
  const bankRows = [
    bankRowT('9999999993', { debit: 100000, transactionDateTime: new Date('2026-07-13T09:00:10+07:00') }),
    bankRowT('9999999994', { debit: 100000, transactionDateTime: new Date('2026-07-13T09:05:00+07:00') }),
  ];
  const { results } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 2 }, new Date('2026-07-13T12:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === '1000000002');
  assert.strictEqual(r.coverageStatus, 'IN_BANK_COVERAGE');
  assert.strictEqual(r.reconStatus, 'FP_ONLY');
  assert.strictEqual(r.isActionable, true);
});

// ── TEST 3: exact match lengkap PERSIS di boundary minute ───────────────
test('TEST 3: exact match lengkap (principal+fee) PERSIS di boundary minute -> tetap MATCHED, bukan BOUNDARY_PARTIAL', () => {
  const fpRows = [fp('1000000003', 74200, { timeResponse: new Date('2026-07-13T10:00:15+07:00') })];
  const bankRows = [
    bankRowT('1000000003', { debit: 74200, transactionDateTime: new Date('2026-07-13T10:00:20+07:00') }),
    bankRowT('1000000003', { debit: 25, transactionDateTime: new Date('2026-07-13T10:00:25+07:00') }),
  ];
  const { results } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 2 }, new Date('2026-07-13T12:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === '1000000003');
  assert.strictEqual(r.coverageStatus, 'IN_BANK_COVERAGE');
  assert.strictEqual(r.reconStatus, 'MATCHED');
});

// ── TEST 4: fee saja pada boundary (principal terpotong) ────────────────
test('TEST 4a: hanya baris fee ditemukan pada boundary (principal ke-cutoff) -> BOUNDARY_PARTIAL, bukan NEED_REVIEW/NOMINAL_MISMATCH', () => {
  const fpRows = [fp('1000000004', 90000, { timeResponse: new Date('2026-07-13T10:00:30+07:00') })];
  const bankRows = [
    bankRowT('1000000004', { debit: 25, transactionDateTime: new Date('2026-07-13T10:00:05+07:00') }), // hanya fee
    bankRowT('9999999995', { debit: 50000, transactionDateTime: new Date('2026-07-13T10:05:00+07:00') }),
  ];
  const { results } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 2 }, new Date('2026-07-13T12:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === '1000000004');
  assert.strictEqual(r.coverageStatus, 'BOUNDARY_PARTIAL');
  assert.strictEqual(r.reconStatus, null);
});
test('TEST 4b: fee-only group TANPA FP match PERSIS di boundary minute -> TIDAK menjadi BANK_ONLY', () => {
  const fpRows = [fp('1000000005', 50000, { timeResponse: new Date('2026-07-13T10:05:00+07:00') })];
  const bankRows = [
    bankRowT('7770000001', { debit: 25, transactionDateTime: new Date('2026-07-13T10:00:05+07:00') }), // fee-only, tanpa FP, PERSIS boundary
    bankRowT('1000000005', { debit: 50000, transactionDateTime: new Date('2026-07-13T10:05:10+07:00') }),
  ];
  const { results } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 2 }, new Date('2026-07-13T12:00:00+07:00'));
  assert.strictEqual(results.filter(x => x.reconStatus === 'BANK_ONLY').length, 0);
});

// ── TEST 5: match rate valid HANYA dari FP dalam cakupan ────────────────
test('TEST 5: valid match rate dihitung dari FP DALAM cakupan saja, bukan seluruh DATA FP', () => {
  const now = new Date('2026-07-13T12:00:00+07:00');
  const bankRows = [
    bankRowT('AAAA000001', { debit: 10000, transactionDateTime: new Date('2026-07-13T10:00:10+07:00') }),
    bankRowT('AAAA000001', { debit: 25, transactionDateTime: new Date('2026-07-13T10:00:15+07:00') }),
    bankRowT('AAAA000002', { debit: 20000, transactionDateTime: new Date('2026-07-13T10:02:00+07:00') }),
    bankRowT('AAAA000002', { debit: 25, transactionDateTime: new Date('2026-07-13T10:02:05+07:00') }),
  ];
  const fpRows = [
    fp('AAAA000001', 10000, { timeResponse: new Date('2026-07-13T10:00:10+07:00') }),
    fp('AAAA000002', 20000, { timeResponse: new Date('2026-07-13T10:02:00+07:00') }),
    fp('BBBB000001', 5000, { timeResponse: new Date('2026-07-13T08:00:00+07:00') }),
    fp('BBBB000002', 5000, { timeResponse: new Date('2026-07-13T08:30:00+07:00') }),
    fp('BBBB000003', 5000, { timeResponse: new Date('2026-07-13T09:00:00+07:00') }),
  ];
  const { results } = reconcileTransactionsWithCoverage(fpRows, bankRows, { sourceLimit: 4 }, now);
  const inCoverage = results.filter(r => r.idTransaksi && r.coverageStatus === 'IN_BANK_COVERAGE');
  const outside = results.filter(r => r.idTransaksi && r.coverageStatus === 'OUTSIDE_BANK_COVERAGE');
  const matchedInCoverage = inCoverage.filter(r => r.reconStatus === 'MATCHED' || r.reconStatus === 'MATCHED_NO_FEE');
  assert.strictEqual(outside.length, 3);
  assert.strictEqual(inCoverage.length, 2);
  assert.strictEqual(matchedInCoverage.length, 2);
  const validMatchRate = (matchedInCoverage.length / inCoverage.length) * 100;
  assert.strictEqual(validMatchRate, 100);
  assert.notStrictEqual((matchedInCoverage.length / fpRows.length) * 100, validMatchRate);
});

// ── TEST 6: archive tidak kehilangan baris lama (fingerprint union) ─────
test('TEST 6: fingerprint stabil -> baris lama (A) tetap ada di archive walau sudah tergeser keluar snapshot baru (sync2 cuma B,C,D)', () => {
  const rowA = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:00:00+07:00'), valueDate: '2026-07-10', referenceNo: 'A', description: 'ref A', debit: 1000, credit: null, balance: 5000 };
  const rowB = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:05:00+07:00'), valueDate: '2026-07-10', referenceNo: 'B', description: 'ref B', debit: 2000, credit: null, balance: 4000 };
  const rowC = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:10:00+07:00'), valueDate: '2026-07-10', referenceNo: 'C', description: 'ref C', debit: 3000, credit: null, balance: 3000 };
  const rowD = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:15:00+07:00'), valueDate: '2026-07-10', referenceNo: 'D', description: 'ref D', debit: 4000, credit: null, balance: 2000 };

  const sync1 = buildOcbcBankArchiveRows([rowA, rowB, rowC], 1);
  const sync2 = buildOcbcBankArchiveRows([rowB, rowC, rowD], 2); // A sudah tergeser keluar window 5.000 baris

  const archive = new Map(); // simulasi UPSERT by row_fingerprint (recon_bank_archive), TIDAK PERNAH delete
  for (const r of sync1) archive.set(r.fingerprint, r);
  for (const r of sync2) archive.set(r.fingerprint, r);

  const refsInArchive = [...archive.values()].map(r => r.referenceNo).sort();
  assert.deepStrictEqual(refsInArchive, ['A', 'B', 'C', 'D']);
});

// ── TEST 7: resync idempotent (fingerprint deterministik) ───────────────
test('TEST 7: fingerprint deterministik -- data identik menghasilkan fingerprint SAMA meski snapshot_id beda (upsert, bukan duplikat)', () => {
  const row = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:00:00+07:00'), valueDate: '2026-07-10', referenceNo: 'X', description: 'ref X', debit: 1000, credit: null, balance: 5000 };
  const built1 = buildOcbcBankArchiveRows([row], 1);
  const built2 = buildOcbcBankArchiveRows([row], 2);
  assert.strictEqual(built1[0].fingerprint, built2[0].fingerprint);
  assert.strictEqual(built1[0].fingerprint, computeBankRowFingerprint({ ...row }));
});
test('TEST 7b: fingerprint BEDA kalau salah satu field (mis. debit) berbeda', () => {
  const rowX = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:00:00+07:00'), valueDate: '2026-07-10', referenceNo: 'X', description: 'ref X', debit: 1000, credit: null, balance: 5000 };
  const rowY = { ...rowX, debit: 1001 };
  assert.notStrictEqual(computeBankRowFingerprint(rowX), computeBankRowFingerprint(rowY));
});
test('TEST 7c: fingerprint SAMA meski balance berbeda -- running balance OCBC bisa berubah antar sync utk mutasi yang sama (regresi insiden DUPLICATE_BANK produksi)', () => {
  const rowX = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-10T09:00:00+07:00'), valueDate: '2026-07-10', referenceNo: 'X', description: 'ref X', debit: 1000, credit: null, balance: 5000 };
  const rowY = { ...rowX, balance: 4871 };
  assert.strictEqual(computeBankRowFingerprint(rowX), computeBankRowFingerprint(rowY));
});

// ── TEST 12: fallback jam presisi dari raw_data.A (regresi insiden FP_ONLY meledak) ──
test('TEST 12a: parseOcbcRawDateTimeFallback -- baca kolom A "DD/MM/YYYY HH:mm" WIB, hasil instant benar', () => {
  const dt = parseOcbcRawDateTimeFallback({ A: '13/07/2026 19:48', B: '13/07/2026', C: '3556773504' });
  assert.ok(dt instanceof Date && !Number.isNaN(dt.getTime()));
  // 19:48 WIB (+07:00) == 12:48 UTC
  assert.strictEqual(dt.toISOString(), '2026-07-13T12:48:00.000Z');
});
test('TEST 12b: parseOcbcRawDateTimeFallback -- tanggal>12 tidak salah tafsir MM/DD (insiden new Date() langsung)', () => {
  const dt = parseOcbcRawDateTimeFallback({ A: '25/12/2026 08:05' });
  assert.strictEqual(dt.toISOString(), '2026-12-25T01:05:00.000Z');
});
test('TEST 12c: parseOcbcRawDateTimeFallback -- raw_data kosong/tanpa kolom cocok -> null', () => {
  assert.strictEqual(parseOcbcRawDateTimeFallback(null), null);
  assert.strictEqual(parseOcbcRawDateTimeFallback({}), null);
  assert.strictEqual(parseOcbcRawDateTimeFallback({ B: '13/07/2026' }), null);
});
test('TEST 12d: resolveOcbcTransactionDateTime -- prioritas: transaction_date_time eksplisit > raw_data.A > date-only', () => {
  const explicit = resolveOcbcTransactionDateTime({ transaction_date_time: '2026-07-13T10:00:00+07:00', raw_data: { A: '13/07/2026 19:48' }, transaction_date: '13/07/2026' });
  assert.strictEqual(explicit.toISOString(), '2026-07-13T03:00:00.000Z');
  const viaRawData = resolveOcbcTransactionDateTime({ transaction_date_time: null, raw_data: { A: '13/07/2026 19:48' }, transaction_date: '13/07/2026' });
  assert.strictEqual(viaRawData.toISOString(), '2026-07-13T12:48:00.000Z');
  // tanpa raw_data.A yang cocok, jatuh ke parseTimeResponse(transaction_date) apa adanya
  // (perilaku lama, termasuk keterbatasannya utk string non-ISO -- bukan cakupan fallback ini)
  const dateOnly = resolveOcbcTransactionDateTime({ transaction_date_time: null, raw_data: {}, transaction_date: '2026-07-13' });
  assert.ok(dateOnly instanceof Date && !Number.isNaN(dateOnly.getTime()));
});

// ── TEST 8: resolution manual + audit log tetap ada lintas resync ───────
// (Perilaku upsert-by-natural-key SUDAH ADA sebelum perubahan ini --
// recon_results TIDAK PERNAH delete+insert, hanya upsert, jadi id & FK
// recon_action_logs stabil. Diverifikasi ulang scr end-to-end lewat live
// endpoint test di server, lihat laporan implementasi.)

// ── TEST 9: matching lama tetap berjalan (tidak truncated) ──────────────
test('TEST 9: reconcileTransactionsWithCoverage IDENTIK dgn reconcileTransactions lama utk data TIDAK truncated', () => {
  const fpRows = [fp('3556344215', 74200)];
  const bankRows = [bankRow('3556344215', { debit: 74200 }), bankRow('3556344215', { debit: 25 })];
  const oldResult = reconcileTransactions(fpRows, bankRows, {}, new Date())[0];
  const { results: newResults, coverage } = reconcileTransactionsWithCoverage(fpRows, bankRows, {}, new Date());
  const newResult = newResults[0];
  assert.strictEqual(coverage.isSourceTruncated, false);
  assert.strictEqual(newResult.reconStatus, oldResult.reconStatus);
  assert.strictEqual(newResult.reconStatus, 'MATCHED');
  assert.strictEqual(newResult.bankPrincipal, oldResult.bankPrincipal);
  assert.strictEqual(newResult.bankFee, oldResult.bankFee);
  assert.strictEqual(newResult.coverageStatus, 'IN_BANK_COVERAGE');
  assert.strictEqual(newResult.isActionable, true);
  assert.strictEqual(newResult.eligibleForMatchRate, true);
});

// ── TEST 10: Mandiri tidak terpengaruh ──────────────────────────────────
// (dijalankan terpisah: `node backend/scripts/test-reconciliation-mandiri.js`
// — file ini tidak meng-import apa pun dari modul Mandiri, dan tidak ada
// satu baris pun di warroom-reconciliation-mandiri.js/mandiriAdapter.js yang
// disentuh oleh perubahan coverage-aware ini.)

// ── TEST 11: timezone -- transaksi dini hari WIB tidak mundur 1 hari ────
test('TEST 11: transaksi 00:30 WIB -> business_date archive TIDAK mundur ke hari sebelumnya (bukan .toISOString().slice(0,10))', () => {
  const row = { bankCode: 'OCBC', accountNo: '123', transactionDateTime: new Date('2026-07-13T00:30:00+07:00'), valueDate: '2026-07-13', referenceNo: 'X', description: 'ref', debit: 1000, credit: null, balance: 5000 };
  const built = buildOcbcBankArchiveRows([row], 1);
  assert.strictEqual(built[0].businessDate, '2026-07-13');
});

// ── isCompleteOcbcGroup / calculateOcbcCoverage / classifyFpCoverage — unit langsung ──
test('isCompleteOcbcGroup: principal+fee sesuai -> true', () => {
  const group = [{ debit: 1000 }, { debit: 25 }];
  assert.strictEqual(isCompleteOcbcGroup(group, 1000, 25), true);
});
test('isCompleteOcbcGroup: tanpa fee -> false (konservatif, MATCHED_NO_FEE tetap dianggap tidak "lengkap" di boundary)', () => {
  const group = [{ debit: 1000 }];
  assert.strictEqual(isCompleteOcbcGroup(group, 1000, 25), false);
});
test('isCompleteOcbcGroup: 2 principal (duplicate) -> false', () => {
  const group = [{ debit: 1000 }, { debit: 1000 }, { debit: 25 }];
  assert.strictEqual(isCompleteOcbcGroup(group, 1000, 25), false);
});
test('calculateOcbcCoverage: bankRowCount < sourceLimit -> isSourceTruncated false, trustedCoverageStart null', () => {
  const coverage = calculateOcbcCoverage([bankRowT('A', { debit: 100, transactionDateTime: new Date('2026-07-13T09:00:00+07:00') })], { sourceLimit: 5000 });
  assert.strictEqual(coverage.isSourceTruncated, false);
  assert.strictEqual(coverage.trustedCoverageStart, null);
});
test('classifyFpCoverage: coverage tidak truncated -> selalu IN_BANK_COVERAGE', () => {
  const coverage = { isSourceTruncated: false };
  const r = classifyFpCoverage(fp('1', 1000, { timeResponse: new Date('2020-01-01T00:00:00Z') }), coverage, null, 25);
  assert.strictEqual(r.coverageStatus, 'IN_BANK_COVERAGE');
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
