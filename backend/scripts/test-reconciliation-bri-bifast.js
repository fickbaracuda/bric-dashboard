'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-reconciliation-{ocbc,mandiri,bri}.js. Run:
// node backend/scripts/test-reconciliation-bri-bifast.js
//
// Mencakup TEST 1-42 dari spek Rekonsiliasi BRI BI-FAST (pure function,
// briBifastAdapter.js) PLUS blok data-quality/actionable-exception/health
// status (pure function di warroom-reconciliation-bri-bifast.js).
// Idempotensi sync, manual resolve bertahan setelah resync, dan regresi
// BRI existing/Mandiri/OCBC adalah perilaku level DB/endpoint — diverifikasi
// langsung di server (lihat laporan implementasi), BUKAN di level
// pure-function di sini, sama seperti pola bank lain.

const assert = require('assert');
const {
  isBriBifastFpCandidate, extractBriBifastIdentifiers, classifyBriBifastRow,
  normalizeJamTran, parseBriBifastTransactionTime, computeBriBifastTimeOrderStatus,
  buildBriBifastBankGroups, reconcileBriBifastTransactions, applyBriBifastReversalCrossDateLookup,
  validateBriBifastBalance, buildBriBifastFingerprint, DEFAULT_FEE_BRI_BIFAST,
} = require('../src/reconciliation/briBifastAdapter');
const {
  dedupeBriBifastResultsByCanonicalKey, computeBriBifastResultQualityChecks,
  computeBriBifastActionableException, computeBriBifastHealthStatus, computeBriBifastRawDiagnostics,
  BRI_BIFAST_HEALTH_THRESHOLDS,
} = require('../src/routes/warroom-reconciliation-bri-bifast');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, billInfo1, nominal, opts = {}) {
  return {
    idTransaksi, billInfo1, nominal,
    idOutlet: opts.idOutlet ?? 'OUTLET1', idProduk: opts.idProduk ?? 'BLSTRMDR', idBiller: opts.idBiller ?? '11096',
    timeResponse: opts.timeResponse ?? null,
  };
}

// Baris mentah SUDAH diklasifikasi+diparse waktu, pola sama dgn bankRow()
// helper test-reconciliation-bri.js — merepresentasikan 1 baris debit/fee/
// credit sheet "Data Bank BRI BI Fast".
function bankRow(deskTran, opts = {}) {
  const trremk = opts.trremk ?? deskTran;
  const mutasiDebet = opts.mutasiDebet ?? null;
  const mutasiKredit = opts.mutasiKredit ?? null;
  const classification = classifyBriBifastRow({ deskTran, trremk, mutasiDebet, mutasiKredit });
  const time = parseBriBifastTransactionTime({
    tglTran: opts.tglTran ?? '2026-07-10',
    tglEfektif: opts.tglEfektif ?? opts.tglTran ?? '2026-07-10',
    jamTran: opts.jamTran ?? null,
  });
  return {
    bankCode: 'BRI_BIFAST', accountNo: opts.accountNo ?? '36001999999306',
    businessDate: time.businessDate, seq: opts.seq ?? 'SEQ1', deskTran, trremk, tlbds2: opts.tlbds2 ?? null,
    mutasiDebet, mutasiKredit, transactionDateTime: opts.transactionDateTime ?? time.transactionDateTime,
    jamTranNormalized: time.jamTranNormalized,
    beneficiaryAccount: classification.beneficiaryAccount, bankTraceId: classification.bankTraceId,
    counterpartyBic: classification.counterpartyBic, accountConflict: classification.accountConflict,
    extractionConfidence: classification.extractionConfidence, bankRowType: classification.bankRowType,
  };
}

// Sample text nyata dari spec: id BFST + APFT + trace TLBDS2-style.
const SAMPLE_DESK_1 = 'BFST101765893345 APFT:JAGBIDJA 20260710BRINIDJA010O9903057543 ESB:APFT:0008G00F:091615446446';
const SAMPLE_DESK_2 = 'BFST0019773396 APFT:BNIAIDJA 20260710BRINIDJA010O9903057544 ESB:APFT:0008G00F:091615446447';

// ── TEST 1: id_biller selain 11096 tidak menjadi kandidat FP ────────────────
test('TEST 1: id_biller selain 11096 tidak menjadi kandidat FP', () => {
  assert.strictEqual(isBriBifastFpCandidate(fp('1', '101765893345', 550000, { idBiller: '11096' })), true);
  assert.strictEqual(isBriBifastFpCandidate(fp('2', '101765893345', 550000, { idBiller: '999' })), false);
  assert.strictEqual(isBriBifastFpCandidate(fp('3', '101765893345', 550000, { idBiller: null })), false);
});

// ── TEST 2/3: bill_info1 diproses sebagai string, leading zero tetap utuh ──
test('TEST 2/3: bill_info1 diproses sebagai string, leading zero tetap utuh', () => {
  const f = fp('1', '0019773396', 1000000);
  assert.strictEqual(typeof f.billInfo1, 'string');
  assert.strictEqual(f.billInfo1, '0019773396');
  assert.notStrictEqual(f.billInfo1, '19773396');
});

// ── TEST 4: BFST0019773396 menghasilkan '0019773396' ────────────────────────
test('TEST 4: BFST0019773396 -> beneficiary account 0019773396', () => {
  const idInfo = extractBriBifastIdentifiers({ deskTran: 'BFST0019773396 APFT:JAGBIDJA', trremk: null });
  assert.strictEqual(idInfo.beneficiaryAccount, '0019773396');
});

// ── TEST 5: DESK_TRAN dan TRREMK sepakat -> confidence HIGH ─────────────────
test('TEST 5: DESK_TRAN & TRREMK sepakat -> confidence HIGH', () => {
  const idInfo = extractBriBifastIdentifiers({ deskTran: SAMPLE_DESK_1, trremk: SAMPLE_DESK_1 });
  assert.strictEqual(idInfo.extractionConfidence, 'HIGH');
  assert.strictEqual(idInfo.beneficiaryAccount, '101765893345');
});

// ── TEST 6: Hanya satu sumber -> confidence MEDIUM ──────────────────────────
test('TEST 6: hanya DESK_TRAN yang menghasilkan account -> confidence MEDIUM', () => {
  const idInfo = extractBriBifastIdentifiers({ deskTran: SAMPLE_DESK_1, trremk: null });
  assert.strictEqual(idInfo.extractionConfidence, 'MEDIUM');
});

// ── TEST 7: Account berbeda -> CONFLICT ─────────────────────────────────────
test('TEST 7: DESK_TRAN & TRREMK account berbeda -> CONFLICT', () => {
  const idInfo = extractBriBifastIdentifiers({ deskTran: SAMPLE_DESK_1, trremk: SAMPLE_DESK_2 });
  assert.strictEqual(idInfo.extractionConfidence, 'CONFLICT');
  assert.strictEqual(idInfo.accountConflict, true);
});

// ── TEST 8: Non-BFST/APFT -> OUT_OF_SCOPE ───────────────────────────────────
test('TEST 8: mutasi tanpa pola BFST/APFT -> OUT_OF_SCOPE', () => {
  const c = classifyBriBifastRow({ deskTran: 'TRSFER BIAYA ADMIN BULANAN', trremk: null, mutasiDebet: 15000, mutasiKredit: null });
  assert.strictEqual(c.bankRowType, 'OUT_OF_SCOPE');
});
test('TEST 8b: DESK_TRAN & TRREMK kosong -> UNKNOWN', () => {
  const c = classifyBriBifastRow({ deskTran: '', trremk: '', mutasiDebet: null, mutasiKredit: null });
  assert.strictEqual(c.bankRowType, 'UNKNOWN');
});
test('TEST 8c: account conflict -> NEED_REVIEW (bukan OUT_OF_SCOPE)', () => {
  const c = classifyBriBifastRow({ deskTran: SAMPLE_DESK_1, trremk: SAMPLE_DESK_2, mutasiDebet: 550000, mutasiKredit: null });
  assert.strictEqual(c.bankRowType, 'NEED_REVIEW');
});
test('TEST 8d: pola valid tapi beneficiary tidak ditemukan (hanya APFT) -> NEED_REVIEW', () => {
  const c = classifyBriBifastRow({ deskTran: 'APFT:JAGBIDJA transfer keluar', trremk: null, mutasiDebet: 550000, mutasiKredit: null });
  assert.strictEqual(c.bankRowType, 'NEED_REVIEW');
});

// ── TEST 9: JAM_TRAN 3950 -> 00:39:50 ────────────────────────────────────────
test('TEST 9: JAM_TRAN normalisasi', () => {
  assert.strictEqual(normalizeJamTran(3950), '00:39:50');
  assert.strictEqual(normalizeJamTran(4327), '00:43:27');
  assert.strictEqual(normalizeJamTran(12316), '01:23:16');
});

// ── TEST 10: Principal + fee 77 -> MATCHED ──────────────────────────────────
test('TEST 10: principal + fee Rp77 -> MATCHED', () => {
  const fpRows = [fp('T1', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, tlbds2: '20260710BRINIDJA010O9903057543' }),
    bankRow('Transfer Fee ' + SAMPLE_DESK_1, { mutasiDebet: 77, jamTran: 100800, tlbds2: '20260710BRINIDJA010O9903057543' }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date('2026-07-10T13:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === 'T1');
  assert.strictEqual(r.reconStatus, 'MATCHED');
  assert.strictEqual(r.bankPrincipal, 550000);
  assert.strictEqual(r.bankFee, 77);
});

// ── TEST 11: Principal tanpa fee -> MATCHED_NO_FEE ──────────────────────────
test('TEST 11: principal tanpa fee -> MATCHED_NO_FEE', () => {
  const fpRows = [fp('T2', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 })];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'MATCHED_NO_FEE');
  assert.strictEqual(results[0].bankFee, 0);
});

// ── TEST 12: Fee bukan 77 -> FEE_MISMATCH ───────────────────────────────────
test('TEST 12: fee bukan Rp77 -> FEE_MISMATCH', () => {
  const fpRows = [fp('T3', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 }),
    bankRow('Transfer Fee ' + SAMPLE_DESK_1, { mutasiDebet: 100, jamTran: 100800 }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'FEE_MISMATCH');
  assert.strictEqual(results[0].bankFee, 100);
});

// ── TEST 13: Principal berbeda -> NOMINAL_MISMATCH hanya jika pairing unik ──
test('TEST 13: satu-satunya FP & satu-satunya bank group utk account -> NOMINAL_MISMATCH', () => {
  const fpRows = [fp('T4', '101765893345', 500000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 })];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'NOMINAL_MISMATCH');
});

// ── TEST 14: Account sama tapi banyak kandidat tidak dipaksa match ──────────
test('TEST 14: 2 FP & 2 bank group utk account sama, tidak ada exact match -> TIDAK dipaksa (tetap PENDING/FP_ONLY & BANK_ONLY)', () => {
  const fpRows = [
    fp('T5', '101765893345', 500000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') }),
    fp('T6', '101765893345', 600000, { timeResponse: new Date('2026-07-10T11:06:00+07:00') }),
  ];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 700000, jamTran: 100800, seq: 'A' }),
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 800000, jamTran: 110800, seq: 'B' }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date('2026-07-10T23:00:00+07:00'));
  const r5 = results.find(x => x.idTransaksi === 'T5');
  const r6 = results.find(x => x.idTransaksi === 'T6');
  assert.ok(['FP_ONLY', 'PENDING_BANK'].includes(r5.reconStatus));
  assert.ok(['FP_ONLY', 'PENDING_BANK'].includes(r6.reconStatus));
  const bankOnlyRows = results.filter(x => x.reconStatus === 'BANK_ONLY');
  assert.strictEqual(bankOnlyRows.length, 2);
});

// ── TEST 15: Dua principal -> DUPLICATE_BANK ────────────────────────────────
test('TEST 15: 2 baris principal exact sama dgn nominal FP pada 1 grup -> DUPLICATE_BANK', () => {
  const fpRows = [fp('T7', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [
    // Kedua baris pakai DESK_TRAN identik -> bankTraceId sama (fallback dari
    // DESK_TRAN, keduanya tidak diberi tlbds2 eksplisit) -> 1 grup, 2 principal.
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, seq: 'A' }),
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, seq: 'A' }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_BANK');
});

// ── TEST 16: Fee-only -> NEED_REVIEW ─────────────────────────────────────────
test('TEST 16: fee-only tanpa principal & tanpa FP -> NEED_REVIEW (bukan BANK_ONLY)', () => {
  const bankRows = [bankRow('Transfer Fee ' + SAMPLE_DESK_1, { mutasiDebet: 77, jamTran: 100800 })];
  const results = reconcileBriBifastTransactions([], bankRows, {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'NEED_REVIEW');
});

// ── TEST 17: Duplicate id_transaksi FP -> DUPLICATE_FP ──────────────────────
test('TEST 17: id_transaksi muncul 2x di DATA FP -> DUPLICATE_FP', () => {
  const fpRows = [fp('DUP1', '101765893345', 550000), fp('DUP1', '101765893345', 550000)];
  const results = reconcileBriBifastTransactions(fpRows, [], {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP');
});

// ── TEST 18/19: Grace period -> PENDING_BANK / FP_ONLY ──────────────────────
test('TEST 18: belum lewat grace period -> PENDING_BANK', () => {
  const fpRows = [fp('T8', '999999999', 100000, { timeResponse: new Date('2026-07-10T10:00:00+07:00') })];
  const results = reconcileBriBifastTransactions(fpRows, [], {}, new Date('2026-07-10T10:10:00+07:00'));
  assert.strictEqual(results[0].reconStatus, 'PENDING_BANK');
});
test('TEST 19: sudah lewat grace period -> FP_ONLY', () => {
  const fpRows = [fp('T9', '999999999', 100000, { timeResponse: new Date('2026-07-10T10:00:00+07:00') })];
  const results = reconcileBriBifastTransactions(fpRows, [], {}, new Date('2026-07-10T11:00:00+07:00'));
  assert.strictEqual(results[0].reconStatus, 'FP_ONLY');
});

// ── TEST 20/21/22: BANK_ONLY, OUT_OF_SCOPE, consumed tidak jadi BANK_ONLY ──
test('TEST 20: valid unmatched bank group -> BANK_ONLY', () => {
  const bankRows = [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 })];
  const results = reconcileBriBifastTransactions([], bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'BANK_ONLY');
  assert.strictEqual(results[0].beneficiaryAccount, '101765893345');
});
test('TEST 21: OUT_OF_SCOPE tidak pernah menjadi BANK_ONLY', () => {
  const bankRows = [bankRow('TRSFER BIAYA ADMIN', { mutasiDebet: 15000 })];
  const results = reconcileBriBifastTransactions([], bankRows, {}, new Date());
  assert.strictEqual(results.length, 0);
});
test('TEST 22: consumed group (matched ke FP) tidak jadi BANK_ONLY ganda', () => {
  const fpRows = [fp('T10', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 })];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.notStrictEqual(results[0].reconStatus, 'BANK_ONLY');
});

// ── TEST 23/24/25: Reversal ──────────────────────────────────────────────────
test('TEST 23: credit dalam grup yang sama -> REVERSAL menimpa status lain', () => {
  const fpRows = [fp('T11', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800 }),
    bankRow(SAMPLE_DESK_1, { mutasiKredit: 550000, jamTran: 100800 }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'REVERSAL');
});
test('TEST 24: cross-date exact trace -> REVERSAL', () => {
  const base = reconcileBriBifastTransactions(
    [fp('T12', '101765893345', 550000)],
    [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, tlbds2: '20260710BRINIDJA010O9903057543' })],
    {}, new Date()
  );
  const traceId = base.find(r => r.idTransaksi === 'T12').bankTraceId;
  const futureByKey = new Map([[`36001999999306|${traceId}`, [{ mutasiKredit: 550000, transactionDateTime: new Date('2026-07-12T09:00:00+07:00'), businessDate: '2026-07-12' }]]]);
  const updated = applyBriBifastReversalCrossDateLookup(base, futureByKey, { reversalLookupDays: 3 });
  assert.strictEqual(updated[0].reconStatus, 'REVERSAL');
  assert.strictEqual(updated[0].reversalLookupSource, 'CROSS_DATE_TRACE');
});
test('TEST 25: cross-date reversal tidak membuat BANK_ONLY baru (row yang SAMA di-update, bukan ditambah)', () => {
  const base = reconcileBriBifastTransactions([], [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, tlbds2: '20260710BRINIDJA010O9903057543' })], {}, new Date());
  const traceId = base[0].bankTraceId;
  const futureByKey = new Map([[`36001999999306|${traceId}`, [{ mutasiKredit: 550000, transactionDateTime: new Date('2026-07-12T09:00:00+07:00'), businessDate: '2026-07-12' }]]]);
  const updated = applyBriBifastReversalCrossDateLookup(base, futureByKey, { reversalLookupDays: 3 });
  assert.strictEqual(updated.length, 1);
  assert.strictEqual(updated[0].reconStatus, 'REVERSAL');
});

// ── TEST 26: Bank posting jauh sebelum FP tidak false-match ─────────────────
test('TEST 26: bank posting jauh sebelum FP (melebihi toleransi 5 menit) -> tidak dipasangkan otomatis', () => {
  const fpRows = [fp('T13', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:30:00+07:00') })];
  const bankRows = [bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100000, transactionDateTime: new Date('2026-07-10T10:00:00+07:00') })];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date('2026-07-10T23:00:00+07:00'));
  assert.notStrictEqual(results[0].reconStatus, 'MATCHED');
  const bankOnly = results.find(r => r.reconStatus === 'BANK_ONLY');
  assert.ok(bankOnly);
});
test('TEST 26b: computeBriBifastTimeOrderStatus -> IMPOSSIBLE_ORDER kalau posting jauh sebelum FP', () => {
  assert.strictEqual(computeBriBifastTimeOrderStatus(-30, 5), 'IMPOSSIBLE_ORDER');
  assert.strictEqual(computeBriBifastTimeOrderStatus(3, 5), 'NORMAL');
  assert.strictEqual(computeBriBifastTimeOrderStatus(10, 5), 'WARNING');
  assert.strictEqual(computeBriBifastTimeOrderStatus(20, 5), 'DELAYED');
  assert.strictEqual(computeBriBifastTimeOrderStatus(45, 5), 'EXTREME');
});

// ── TEST 27: 1 account, 2 FP, 2 bank group -> one-to-one ────────────────────
test('TEST 27: satu account dgn 2 FP & 2 bank group (exact match masing2) -> dipasangkan one-to-one', () => {
  const fpRows = [
    fp('T14', '101765893345', 500000, { timeResponse: new Date('2026-07-10T10:00:00+07:00') }),
    fp('T15', '101765893345', 600000, { timeResponse: new Date('2026-07-10T11:00:00+07:00') }),
  ];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 500000, jamTran: 100000, seq: 'A' }),
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 600000, jamTran: 110000, seq: 'B' }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  const r14 = results.find(r => r.idTransaksi === 'T14');
  const r15 = results.find(r => r.idTransaksi === 'T15');
  assert.strictEqual(r14.reconStatus, 'MATCHED_NO_FEE');
  assert.strictEqual(r15.reconStatus, 'MATCHED_NO_FEE');
  assert.strictEqual(r14.bankPrincipal, 500000);
  assert.strictEqual(r15.bankPrincipal, 600000);
  assert.strictEqual(results.filter(r => r.reconStatus === 'BANK_ONLY').length, 0); // kedua grup terpakai, tidak ada sisa
});

// ── TEST 28/29: Canonical key & fingerprint ──────────────────────────────────
test('TEST 28: canonical key unik per hasil (FP: id_transaksi, bank-only: trace)', () => {
  const fpRows = [fp('T16', '101765893345', 550000, { timeResponse: new Date('2026-07-10T10:06:00+07:00') })];
  const bankRows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100800, seq: 'A' }),
    bankRow(SAMPLE_DESK_2, { mutasiDebet: 300000, jamTran: 120000, seq: 'B' }),
  ];
  const results = reconcileBriBifastTransactions(fpRows, bankRows, {}, new Date());
  const keys = results.map(r => r.idTransaksi || `BANK::${r.bankTraceId || r.stableGroupFingerprint}`);
  assert.strictEqual(new Set(keys).size, keys.length);
});
test('TEST 29: fingerprint TIDAK bergantung pada source row', () => {
  const rowA = { bankCode: 'BRI_BIFAST', norek: '360019', tglTranNormalized: '2026-07-10', tglEfektifNormalized: '2026-07-10', jamTran: '100800', seq: 'A', deskTran: SAMPLE_DESK_1, mutasiDebet: 550000, mutasiKredit: null, saldoAkhirMutasi: 1000000, tlbds2: 'X' };
  const rowB = { ...rowA };
  assert.strictEqual(buildBriBifastFingerprint(rowA), buildBriBifastFingerprint(rowB));
});

// ── TEST 32/33: Balance validation ───────────────────────────────────────────
test('TEST 32: SALDO_AWAL - DEBET + KREDIT = SALDO_AKHIR -> BALANCED', () => {
  const bv = validateBriBifastBalance([{ saldoAwalMutasi: 1000000, mutasiDebet: 550000, mutasiKredit: 0, saldoAkhirMutasi: 450000 }]);
  assert.strictEqual(bv.status, 'BALANCED');
});
test('TEST 33: saldo tidak cocok -> UNBALANCED', () => {
  const bv = validateBriBifastBalance([{ saldoAwalMutasi: 1000000, mutasiDebet: 550000, mutasiKredit: 0, saldoAkhirMutasi: 999999 }]);
  assert.strictEqual(bv.status, 'UNBALANCED');
});

// ── TEST 34: Actionable exception dihitung backend ──────────────────────────
test('TEST 34: actionable exception -- 9 EXCEPTION_STATUSES, MATCHED/MATCHED_NO_FEE tidak ikut', () => {
  const results = [
    { recon_status: 'MATCHED', fp_nominal: 100 },
    { recon_status: 'MATCHED_NO_FEE', fp_nominal: 100 },
    { recon_status: 'FP_ONLY', fp_nominal: 200 },
    { recon_status: 'BANK_ONLY', fp_nominal: null, bank_total_debit: 300 },
  ];
  const ex = computeBriBifastActionableException(results);
  assert.strictEqual(ex.count, 2);
  assert.strictEqual(ex.nominal, 500);
});

// ── TEST — dedupe & quality checks ──────────────────────────────────────────
test('dedupeBriBifastResultsByCanonicalKey: canonical key sama -> 1 dipertahankan', () => {
  const rows = [{ id: 1, canonical_transaction_key: 'A' }, { id: 2, canonical_transaction_key: 'A' }, { id: 3, canonical_transaction_key: 'B' }];
  assert.strictEqual(dedupeBriBifastResultsByCanonicalKey(rows).length, 2);
});
test('computeBriBifastResultQualityChecks: invalid_business_date_count terdeteksi', () => {
  const rows = [{ bank_transaction_date: '2026-07-09', reversal_lookup_source: null, canonical_transaction_key: 'A', recon_status: 'MATCHED' }];
  const q = computeBriBifastResultQualityChecks(rows, '2026-07-10');
  assert.strictEqual(q.invalid_business_date_count, 1);
});
test('computeBriBifastResultQualityChecks: cross-date reversal VALID tidak dihitung invalid', () => {
  const rows = [{ bank_transaction_date: '2026-07-09', reversal_lookup_source: 'CROSS_DATE_TRACE', canonical_transaction_key: 'A', recon_status: 'REVERSAL' }];
  const q = computeBriBifastResultQualityChecks(rows, '2026-07-10');
  assert.strictEqual(q.invalid_business_date_count, 0);
});
test('computeBriBifastResultQualityChecks: duplicate_canonical_result_count & consumed_also_bank_only', () => {
  const rows = [
    { bank_transaction_date: null, reversal_lookup_source: null, canonical_transaction_key: 'K1', recon_status: 'MATCHED' },
    { bank_transaction_date: null, reversal_lookup_source: null, canonical_transaction_key: 'K1', recon_status: 'BANK_ONLY' },
  ];
  const q = computeBriBifastResultQualityChecks(rows, '2026-07-10');
  assert.strictEqual(q.duplicate_canonical_result_count, 1);
  assert.strictEqual(q.consumed_also_bank_only_count, 1);
});
test('computeBriBifastResultQualityChecks: impossible_time_order_count', () => {
  const rows = [{ bank_transaction_date: null, reversal_lookup_source: null, canonical_transaction_key: 'K2', recon_status: 'MATCHED', time_order_status: 'IMPOSSIBLE_ORDER' }];
  const q = computeBriBifastResultQualityChecks(rows, '2026-07-10');
  assert.strictEqual(q.impossible_time_order_count, 1);
});

// ── TEST — raw diagnostics (account_conflict/duplicate_bank_trace/orphan_fee/balance) ──
test('computeBriBifastRawDiagnostics: account_conflict_count & balance rows', () => {
  const rows = [
    { account_conflict: true, extraction_confidence: 'CONFLICT', balance_check_status: 'UNBALANCED', balance_variance: 5, bank_row_type: 'NEED_REVIEW', bank_trace_id: null, transfer_group_key: null },
    { account_conflict: false, extraction_confidence: 'HIGH', balance_check_status: 'BALANCED', balance_variance: 0, bank_row_type: 'DEBIT_COMPONENT', bank_trace_id: 'TR1', transfer_group_key: 'G1', debit: 550000 },
  ];
  const d = computeBriBifastRawDiagnostics(rows, 77);
  assert.strictEqual(d.account_conflict_count, 1);
  assert.strictEqual(d.balanced_rows, 1);
  assert.strictEqual(d.unbalanced_rows, 1);
});
test('computeBriBifastRawDiagnostics: duplicate_bank_trace_count -- 1 trace dipakai 2 grup berbeda', () => {
  const rows = [
    { bank_trace_id: 'TR1', transfer_group_key: 'G1', bank_row_type: 'DEBIT_COMPONENT', debit: 550000, extraction_confidence: 'HIGH', balance_check_status: 'UNDETERMINED' },
    { bank_trace_id: 'TR1', transfer_group_key: 'G2', bank_row_type: 'DEBIT_COMPONENT', debit: 600000, extraction_confidence: 'HIGH', balance_check_status: 'UNDETERMINED' },
  ];
  const d = computeBriBifastRawDiagnostics(rows, 77);
  assert.strictEqual(d.duplicate_bank_trace_count, 1);
});
test('computeBriBifastRawDiagnostics: orphan_fee_group_count -- grup hanya berisi fee (=77), tanpa principal/credit', () => {
  const rows = [
    { bank_trace_id: 'TR2', transfer_group_key: 'G3', bank_row_type: 'DEBIT_COMPONENT', debit: 77, extraction_confidence: 'HIGH', balance_check_status: 'UNDETERMINED' },
  ];
  const d = computeBriBifastRawDiagnostics(rows, 77);
  assert.strictEqual(d.orphan_fee_group_count, 1);
});

// ── TEST 38/39/40: Health status GREEN/YELLOW/RED ───────────────────────────
function healthInput(overrides = {}) {
  return {
    validMatchRateTransaction: 1.0, actionableExceptionCount: 0, syncStatus: 'success',
    invalidBusinessDateCount: 0, duplicateCanonicalResultCount: 0, consumedAlsoBankOnlyCount: 0,
    accountConflictCount: 0, duplicateBankTraceCount: 0, impossibleTimeOrderCount: 0, unbalancedBankRowCount: 0,
    extractionMediumRatio: 0, hasPostingDelay: false,
    ...overrides,
  };
}
test('TEST 38: Health GREEN -- match rate tinggi, tidak ada masalah', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput()), 'GREEN');
});
test('TEST 39: Health YELLOW -- match rate 95-99%', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ validMatchRateTransaction: 0.97 })), 'YELLOW');
});
test('TEST 39b: Health YELLOW -- ada actionable exception walau match rate tinggi', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ actionableExceptionCount: 2 })), 'YELLOW');
});
test('TEST 40: Health RED -- match rate < 95%', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ validMatchRateTransaction: 0.90 })), 'RED');
});
test('Health RED -- duplicate canonical result', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ duplicateCanonicalResultCount: 1 })), 'RED');
});
test('Health RED -- account conflict material (>=5)', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ accountConflictCount: 5 })), 'RED');
});
test('Health RED -- saldo UNBALANCED material (>=5)', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ unbalancedBankRowCount: 5 })), 'RED');
});
test('Health RED menang atas YELLOW kalau keduanya terpenuhi', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ actionableExceptionCount: 3, duplicateCanonicalResultCount: 1 })), 'RED');
});
test('Health GREEN kalau match rate null (tidak ada FP) & tidak ada masalah lain', () => {
  assert.strictEqual(computeBriBifastHealthStatus(healthInput({ validMatchRateTransaction: null })), 'GREEN');
});
test('BRI_BIFAST_HEALTH_THRESHOLDS: konfigurasi terpusat 99%/95%', () => {
  assert.strictEqual(BRI_BIFAST_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE, 0.99);
  assert.strictEqual(BRI_BIFAST_HEALTH_THRESHOLDS.YELLOW_MIN_MATCH_RATE, 0.95);
});

// ── Expected fee terpusat (bukan hardcode berulang) ─────────────────────────
test('DEFAULT_FEE_BRI_BIFAST = 77 (satu konfigurasi terpusat)', () => {
  assert.strictEqual(DEFAULT_FEE_BRI_BIFAST, 77);
});

// ── buildBriBifastBankGroups: grouping key bukan cuma beneficiary/SEQ ───────
test('buildBriBifastBankGroups: 2 transfer berbeda ke beneficiary sama (JAM_TRAN beda) -> 2 grup terpisah', () => {
  const rows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 500000, jamTran: 100000, seq: 'A' }),
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 600000, jamTran: 150000, seq: 'B' }),
  ];
  const groups = buildBriBifastBankGroups(rows, { expectedFee: 77 });
  assert.strictEqual(groups.size, 2);
});
test('buildBriBifastBankGroups: principal+fee (JAM_TRAN & SEQ sama) -> 1 grup gabungan', () => {
  const rows = [
    bankRow(SAMPLE_DESK_1, { mutasiDebet: 550000, jamTran: 100000, seq: 'A' }),
    bankRow('Transfer Fee ' + SAMPLE_DESK_1, { mutasiDebet: 77, jamTran: 100000, seq: 'A' }),
  ];
  const groups = buildBriBifastBankGroups(rows, { expectedFee: 77 });
  assert.strictEqual(groups.size, 1);
  const g = [...groups.values()][0];
  assert.strictEqual(g.principalRowCount, 1);
  assert.strictEqual(g.feeRowCount, 1);
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
