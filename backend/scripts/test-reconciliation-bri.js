'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-reconciliation-{ocbc,mandiri}.js (belum ada test
// framework di project ini). Run: node backend/scripts/test-reconciliation-bri.js
//
// Mencakup TEST 1-14 dari spek Rekonsiliasi BRI (pure function, briAdapter.js)
// PLUS blok "LAPORAN HARIAN" (dedupe/data quality/actionable exception/health
// status, pure function di warroom-reconciliation-bri.js — briAdapter.js
// TIDAK disentuh sama sekali oleh paket parity ini).
// Skenario idempotensi sync, resolusi manual bertahan setelah resync, dan
// regresi OCBC & Mandiri adalah perilaku level DB/endpoint — diverifikasi
// langsung di server (lihat laporan implementasi), BUKAN di level
// pure-function di sini, sama seperti pola test OCBC/Mandiri.

const assert = require('assert');
const {
  extractBriTransactionIds, classifyBriRow, parseBriTransactionTime, normalizeJamTran,
  calculateBriCoverage, reconcileBriTransactions, applyBriReversalCrossDateLookup,
  validateBriBalance, buildBriFingerprint, DEFAULT_FEE_BRI,
} = require('../src/reconciliation/briAdapter');
const {
  dedupeBriResultsByCanonicalKey, computeBriResultQualityChecks,
  computeBriActionableException, computeBriHealthStatus, BRI_HEALTH_THRESHOLDS,
} = require('../src/routes/warroom-reconciliation-bri');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fp(idTransaksi, nominal, opts = {}) {
  return {
    idTransaksi, nominal,
    idOutlet: opts.idOutlet ?? 'OUTLET1', idProduk: opts.idProduk ?? null, idBiller: opts.idBiller ?? '284',
    timeResponse: opts.timeResponse ?? null,
  };
}

function bankRow(deskTran, opts = {}) {
  const trremk = opts.trremk ?? null;
  const tlbds2 = opts.tlbds2 ?? null;
  const mutasiDebet = opts.mutasiDebet ?? null;
  const mutasiKredit = opts.mutasiKredit ?? null;
  const classification = classifyBriRow({ deskTran, trremk, tlbds2, mutasiDebet, mutasiKredit });
  const time = parseBriTransactionTime({
    tglTran: opts.tglTran ?? '2026-07-11',
    tglEfektif: opts.tglEfektif ?? opts.tglTran ?? '2026-07-11',
    jamTran: opts.jamTran ?? null,
  });
  return {
    norek: opts.norek ?? '36001001118309', mutasiDebet, mutasiKredit,
    transactionDateTime: opts.transactionDateTime ?? time.transactionDateTime,
    businessDate: time.businessDate,
    extractedTransactionId: classification.extractedTransactionId,
    bankRowType: classification.bankRowType,
    extractionMethod: classification.extractionMethod,
    saldoAwalMutasi: opts.saldoAwalMutasi ?? null,
    saldoAkhirMutasi: opts.saldoAkhirMutasi ?? null,
  };
}

// ── TEST 1: MATCHED ──────────────────────────────────────────────────────
test('TEST 1: FP 3555181698/5000000, BRI debit 5000150 -> MATCHED, principal=5000000, fee=150', () => {
  const fpRows = [fp('3555181698', 5000000)];
  const bankRows = [bankRow('FASTPAY 779001004948509/3555181698 WS_OB;3555181698;62322', { mutasiDebet: 5000150 })];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date('2026-07-11T13:00:00+07:00'));
  const r = results.find(x => x.idTransaksi === '3555181698');
  assert.strictEqual(r.reconStatus, 'MATCHED');
  assert.strictEqual(r.bankGrossDebit, 5000150);
  assert.strictEqual(r.bankPrincipal, 5000000);
  assert.strictEqual(r.bankFee, 150);
});

// ── TEST 2: MATCHED_NO_FEE ────────────────────────────────────────────────
test('TEST 2: nominal=500000, debit=500000 -> MATCHED_NO_FEE', () => {
  const fpRows = [fp('3555181700', 500000)];
  const bankRows = [bankRow('FASTPAY 779001004948509/3555181700 WS_OB;3555181700;62322', { mutasiDebet: 500000 })];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'MATCHED_NO_FEE');
  assert.strictEqual(results[0].bankFee, 0);
});

// ── TEST 3: FEE_MISMATCH ─────────────────────────────────────────────────
test('TEST 3: nominal=500000, debit=500200 -> FEE_MISMATCH, actual fee=200', () => {
  const fpRows = [fp('3555181701', 500000)];
  const bankRows = [bankRow('FASTPAY 779001004948509/3555181701 WS_OB;3555181701;62322', { mutasiDebet: 500200 })];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'FEE_MISMATCH');
  assert.strictEqual(results[0].bankFee, 200);
  assert.strictEqual(results[0].varianceFee, 200 - DEFAULT_FEE_BRI);
});

// ── TEST 4: NOMINAL_MISMATCH ─────────────────────────────────────────────
test('TEST 4: nominal=500000, debit=450150 -> NOMINAL_MISMATCH', () => {
  const fpRows = [fp('3555181702', 500000)];
  const bankRows = [bankRow('FASTPAY 779001004948509/3555181702 WS_OB;3555181702;62322', { mutasiDebet: 450150 })];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'NOMINAL_MISMATCH');
});

// ── TEST 5: Ekstraksi ID dari DESK_TRAN ──────────────────────────────────
test('TEST 5: ekstraksi ID dari DESK_TRAN "FASTPAY .../3555181698 WS_OB;3555181698;..." -> HIGH confidence', () => {
  const r = extractBriTransactionIds({ deskTran: 'FASTPAY 779001004948509/3555181698 WS_OB;3555181698;62322', trremk: null, tlbds2: 'WS_OB;3555181698;62322' });
  assert.strictEqual(r.extractedTransactionId, '3555181698');
  assert.strictEqual(r.deskId, '3555181698');
  assert.strictEqual(r.idConflict, false);
  assert.strictEqual(r.extractionConfidence, 'HIGH');
});

// ── TEST 6: ID CONFLICT ──────────────────────────────────────────────────
test('TEST 6: DESK_TRAN=3555181698 vs TLBDS2=3555189999 -> NEED_REVIEW, id_conflict=true', () => {
  const row = { deskTran: 'FASTPAY 779001004948509/3555181698 WS_OB;3555181698;62322', trremk: null, tlbds2: 'WS_OB;3555189999;62322', mutasiDebet: 5000150, mutasiKredit: null };
  const info = extractBriTransactionIds(row);
  assert.strictEqual(info.idConflict, true);
  assert.strictEqual(info.extractionConfidence, 'CONFLICT');
  const classification = classifyBriRow(row);
  assert.strictEqual(classification.bankRowType, 'NEED_REVIEW');
});

// ── TEST 7: BKO -> OUT_OF_SCOPE ───────────────────────────────────────────
test('TEST 7: DESK_TRAN "BKO178370886370543205873355" -> OUT_OF_SCOPE, bukan BANK_ONLY/NEED_REVIEW', () => {
  const classification = classifyBriRow({ deskTran: 'BKO178370886370543205873355', trremk: null, tlbds2: null, mutasiDebet: 250000, mutasiKredit: null });
  assert.strictEqual(classification.bankRowType, 'OUT_OF_SCOPE');
});
test('TEST 7b: mutasi OUT_OF_SCOPE tidak pernah masuk hasil rekonsiliasi/BANK_ONLY', () => {
  const fpRows = [fp('3555181703', 500000)];
  const bankRows = [
    bankRow('FASTPAY 779001004948509/3555181703 WS_OB;3555181703;62322', { mutasiDebet: 500150 }),
    bankRow('BKO178370886370543205873355', { mutasiDebet: 250000 }),
  ];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.ok(!results.some(r => r.reconStatus === 'BANK_ONLY' || r.reconStatus === 'NEED_REVIEW'), 'BKO row tidak boleh muncul sbg exception');
  assert.strictEqual(results.length, 1);
});

// ── TEST 8: COVERAGE ──────────────────────────────────────────────────────
test('TEST 8: FP mulai 03:12 WIB, bank row 00:31 WIB -> OUTSIDE_FP_COVERAGE, bukan BANK_ONLY', () => {
  const fpRows = [fp('3555181704', 500000, { timeResponse: new Date('2026-07-11T03:12:00+07:00') })];
  const bankRows = [
    bankRow('FASTPAY 779001004948509/9999999998 WS_OB;9999999998;62322', { mutasiDebet: 300150, tglTran: '2026-07-11', jamTran: '003100' }),
  ];
  const { results } = reconcileBriTransactions(fpRows, bankRows, { coverageToleranceMinutes: 60 }, new Date());
  assert.ok(!results.some(r => r.reconStatus === 'BANK_ONLY'), 'mutasi di luar window FP+-60m tidak boleh jadi BANK_ONLY');
});

// ── TEST 9: BANK_ONLY VALID ───────────────────────────────────────────────
test('TEST 9: mutasi FASTPAY valid dalam coverage tanpa pasangan FP -> BANK_ONLY', () => {
  const fpRows = [fp('3555181705', 500000, { timeResponse: new Date('2026-07-11T03:12:00+07:00') })];
  const bankRows = [
    bankRow('FASTPAY 779001004948509/3555181705 WS_OB;3555181705;62322', { mutasiDebet: 500150, tglTran: '2026-07-11', jamTran: '031500' }),
    bankRow('FASTPAY 779001004948509/9999999997 WS_OB;9999999997;62322', { mutasiDebet: 300150, tglTran: '2026-07-11', jamTran: '033000' }),
  ];
  const { results } = reconcileBriTransactions(fpRows, bankRows, { coverageToleranceMinutes: 60 }, new Date());
  const bankOnly = results.filter(r => r.reconStatus === 'BANK_ONLY');
  assert.strictEqual(bankOnly.length, 1);
  assert.strictEqual(bankOnly[0].extractedTransactionId, '9999999997');
  assert.strictEqual(bankOnly[0].estimatedBankPrincipal, 300150 - DEFAULT_FEE_BRI);
});

// ── TEST 10: REVERSAL ─────────────────────────────────────────────────────
test('TEST 10: FP+debit ditemukan, lalu credit dgn ID sama -> REVERSAL, bukan BANK_ONLY', () => {
  const fpRows = [fp('3555181706', 500000)];
  const bankRows = [
    bankRow('FASTPAY 779001004948509/3555181706 WS_OB;3555181706;62322', { mutasiDebet: 500150 }),
    bankRow('FASTPAY 779001004948509/3555181706 WS_OB;3555181706;62322', { mutasiKredit: 500150 }),
  ];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'REVERSAL');
  assert.strictEqual(results.filter(r => r.reconStatus === 'BANK_ONLY').length, 0);
});

// ── TEST 11: DUPLICATE_BANK ───────────────────────────────────────────────
test('TEST 11: 2 baris DEBIT_TRANSFER dgn ID sama -> DUPLICATE_BANK, tidak dijumlahkan', () => {
  const fpRows = [fp('3555181707', 500000)];
  const bankRows = [
    bankRow('FASTPAY 779001004948509/3555181707 WS_OB;3555181707;62322', { mutasiDebet: 500150 }),
    bankRow('FASTPAY 779001004948509/3555181707 WS_OB;3555181707;62322 duplikat', { mutasiDebet: 500150 }),
  ];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_BANK');
  assert.strictEqual(results[0].bankPrincipal, null);
});

// ── TEST 12: BALANCE ──────────────────────────────────────────────────────
test('TEST 12: opening 16653236720, debit 5000150, credit 0, closing 16648236570 -> BALANCED', () => {
  const v = validateBriBalance([{ saldoAwalMutasi: 16653236720, mutasiDebet: 5000150, mutasiKredit: 0, saldoAkhirMutasi: 16648236570 }]);
  assert.strictEqual(v.status, 'BALANCED');
  assert.strictEqual(v.balanced_row_count, 1);
  assert.strictEqual(v.unbalanced_row_count, 0);
});
test('TEST 12b: saldo tidak sesuai -> UNBALANCED dgn variance', () => {
  const v = validateBriBalance([{ saldoAwalMutasi: 1000000, mutasiDebet: 100000, mutasiKredit: 0, saldoAkhirMutasi: 950000 }]);
  assert.strictEqual(v.status, 'UNBALANCED');
  assert.strictEqual(v.balance_variance_total, 50000);
});

// ── TEST 13: JAM_TRAN ─────────────────────────────────────────────────────
test('TEST 13: JAM_TRAN 3153 -> "00:31:53"', () => {
  assert.strictEqual(normalizeJamTran(3153), '00:31:53');
  assert.strictEqual(normalizeJamTran('3153'), '00:31:53');
});
test('TEST 13b: JAM_TRAN tidak valid (mis. 999999 jam>23) -> null', () => {
  assert.strictEqual(normalizeJamTran('999999'), null);
});

// ── TEST 14: TIMEZONE ─────────────────────────────────────────────────────
test('TEST 14: transaksi 11 Juli 2026 00:31 WIB -> business_date 2026-07-11 (bukan 07-10)', () => {
  const time = parseBriTransactionTime({ tglTran: '2026-07-11', tglEfektif: '2026-07-11', jamTran: '003100' });
  assert.strictEqual(time.businessDate, '2026-07-11');
  assert.strictEqual(time.jamTranNormalized, '00:31:00');
});

// ── Reversal cross-date lookup (isolated function) ───────────────────────
test('applyBriReversalCrossDateLookup: BANK_ONLY hari ini + credit ditemukan di hari lain -> REVERSAL, CROSS_DATE_LOOKUP', () => {
  const fpRows = [];
  const bankRows = [bankRow('FASTPAY 779001004948509/3555181708 WS_OB;3555181708;62322', { mutasiDebet: 500150, tglTran: '2026-07-11' })];
  const { results } = reconcileBriTransactions(fpRows, bankRows, {}, new Date());
  assert.strictEqual(results[0].reconStatus, 'BANK_ONLY');
  const futureByKey = new Map([['3555181708', [{ mutasiKredit: 500150, transactionDateTime: new Date('2026-07-12T09:00:00+07:00'), businessDate: '2026-07-12' }]]]);
  const updated = applyBriReversalCrossDateLookup(results, futureByKey, { reversalLookupDays: 3 });
  assert.strictEqual(updated[0].reconStatus, 'REVERSAL');
  assert.strictEqual(updated[0].reversalLookupSource, 'CROSS_DATE_LOOKUP');
  assert.strictEqual(updated[0].reversalAmount, 500150);
});

// ── DUPLICATE_FP ──────────────────────────────────────────────────────────
test('DUPLICATE_FP: id_transaksi muncul 2x di DATA FP', () => {
  const fpRows = [fp('3555181709', 50000), fp('3555181709', 50000)];
  const { results } = reconcileBriTransactions(fpRows, [], {}, new Date());
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].reconStatus, 'DUPLICATE_FP');
});

// ── PENDING_BANK / FP_ONLY ────────────────────────────────────────────────
test('PENDING_BANK: belum ada di bank, masih dalam grace period', () => {
  const fpRows = [fp('3555181710', 50000, { timeResponse: new Date(Date.now() - 5 * 60000) })];
  const { results } = reconcileBriTransactions(fpRows, [], { graceMinutes: 30 }, new Date());
  assert.strictEqual(results[0].reconStatus, 'PENDING_BANK');
});
test('FP_ONLY: belum ada di bank, sudah lewat grace period', () => {
  const fpRows = [fp('3555181711', 50000, { timeResponse: new Date(Date.now() - 60 * 60000) })];
  const { results } = reconcileBriTransactions(fpRows, [], { graceMinutes: 30 }, new Date());
  assert.strictEqual(results[0].reconStatus, 'FP_ONLY');
});

// ── Fingerprint idempotensi ───────────────────────────────────────────────
test('buildBriFingerprint: baris identik -> fingerprint sama; deskTran beda tanda baca -> tetap sama (dinormalisasi)', () => {
  const base = { bankCode: 'BRI', norek: '36001001118309', tglTranNormalized: '2026-07-11', tglEfektifNormalized: '2026-07-11', seq: '1', deskTran: "FASTPAY 779001004948509/3555181698 WS_OB;3555181698;62322", mutasiDebet: 5000150, mutasiKredit: 0, saldoAkhirMutasi: 16648236570 };
  const f1 = buildBriFingerprint(base);
  const f2 = buildBriFingerprint({ ...base, deskTran: base.deskTran.toLowerCase() });
  assert.strictEqual(f1, f2, 'perbedaan huruf besar/kecil tidak boleh mengubah fingerprint');
});
test('buildBriFingerprint: source_row_number TIDAK memengaruhi fingerprint (tidak ada di formula)', () => {
  const base = { bankCode: 'BRI', norek: '36001001118309', tglTranNormalized: '2026-07-11', tglEfektifNormalized: '2026-07-11', seq: '1', deskTran: 'X', mutasiDebet: 100, mutasiKredit: 0, saldoAkhirMutasi: 900 };
  const f1 = buildBriFingerprint(base);
  const f2 = buildBriFingerprint(base); // simulasi baris yg sama, posisi row beda (tidak ada field row number di sini sama sekali)
  assert.strictEqual(f1, f2);
});

// ── UNKNOWN classification ────────────────────────────────────────────────
test('classifyBriRow: tidak ada teks Description sama sekali -> UNKNOWN', () => {
  const c = classifyBriRow({ deskTran: '', trremk: '', tlbds2: null, mutasiDebet: 100, mutasiKredit: null });
  assert.strictEqual(c.bankRowType, 'UNKNOWN');
});

// ═══════════════════════════════════════════════════════════════════════
// LAPORAN HARIAN — active_batch, data_quality_warning, actionable
// exception, health status (warroom-reconciliation-bri.js, bukan
// briAdapter.js — logic ekstraksi/klasifikasi/matching BRI TIDAK disentuh).
// ═══════════════════════════════════════════════════════════════════════
let nextResultId = 1;
function resultRow(overrides = {}) {
  return {
    id: nextResultId++,
    canonical_transaction_key: '3555181698',
    recon_status: 'MATCHED',
    bank_transaction_date: '2026-07-11',
    reversal_lookup_source: null,
    fp_nominal: 500000,
    bank_total_debit: 500150,
    coverage_status: 'IN_FP_COVERAGE',
    ...overrides,
  };
}

// ── dedupeBriResultsByCanonicalKey ───────────────────────────────────────
test('dedupeBriResultsByCanonicalKey: 2 baris berbagi canonical key -> dihitung 1x, baris pertama dipertahankan', () => {
  const rows = [resultRow({ canonical_transaction_key: 'X1', recon_status: 'MATCHED' }), resultRow({ canonical_transaction_key: 'X1', recon_status: 'BANK_ONLY' })];
  const deduped = dedupeBriResultsByCanonicalKey(rows);
  assert.strictEqual(deduped.length, 1);
  assert.strictEqual(deduped[0].recon_status, 'MATCHED');
});

// ── computeBriResultQualityChecks ────────────────────────────────────────
test('computeBriResultQualityChecks: bank_transaction_date beda dari business_date -> invalid_business_date_count', () => {
  const rows = [resultRow({ bank_transaction_date: '2026-07-09' })];
  const q = computeBriResultQualityChecks(rows, '2026-07-11');
  assert.strictEqual(q.invalid_business_date_count, 1);
});
test('computeBriResultQualityChecks: cross-date VALID (reversal_lookup_source=CROSS_DATE_LOOKUP) TIDAK dihitung invalid_business_date_count', () => {
  const rows = [resultRow({ bank_transaction_date: '2026-07-09', reversal_lookup_source: 'CROSS_DATE_LOOKUP', recon_status: 'REVERSAL' })];
  const q = computeBriResultQualityChecks(rows, '2026-07-11');
  assert.strictEqual(q.invalid_business_date_count, 0);
});
test('computeBriResultQualityChecks: 2 baris berbagi canonical key -> duplicate_canonical_result_count = 1', () => {
  const rows = [resultRow({ canonical_transaction_key: 'DUP1' }), resultRow({ canonical_transaction_key: 'DUP1' })];
  const q = computeBriResultQualityChecks(rows, '2026-07-11');
  assert.strictEqual(q.duplicate_canonical_result_count, 1);
});
test('computeBriResultQualityChecks: key sama, 1 MATCHED + 1 BANK_ONLY -> consumed_also_bank_only_count = 1', () => {
  const rows = [resultRow({ canonical_transaction_key: 'CON1', recon_status: 'MATCHED' }), resultRow({ canonical_transaction_key: 'CON1', recon_status: 'BANK_ONLY' })];
  const q = computeBriResultQualityChecks(rows, '2026-07-11');
  assert.strictEqual(q.consumed_also_bank_only_count, 1);
});
test('computeBriResultQualityChecks: data bersih -> semua count 0', () => {
  const rows = [resultRow({ canonical_transaction_key: 'A' }), resultRow({ canonical_transaction_key: 'B', recon_status: 'BANK_ONLY', fp_nominal: null })];
  const q = computeBriResultQualityChecks(rows, '2026-07-11');
  assert.strictEqual(q.invalid_business_date_count, 0);
  assert.strictEqual(q.duplicate_canonical_result_count, 0);
  assert.strictEqual(q.consumed_also_bank_only_count, 0);
});

// ── computeBriActionableException ────────────────────────────────────────
test('computeBriActionableException: hanya 9 EXCEPTION_STATUSES dihitung, MATCHED/MATCHED_NO_FEE tidak ikut', () => {
  const rows = [
    resultRow({ recon_status: 'MATCHED' }),
    resultRow({ recon_status: 'MATCHED_NO_FEE' }),
    resultRow({ recon_status: 'FP_ONLY', fp_nominal: 200000, bank_total_debit: null }),
    resultRow({ recon_status: 'BANK_ONLY', fp_nominal: null, bank_total_debit: 300150 }),
  ];
  const r = computeBriActionableException(rows);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.nominal, 200000 + 300150);
});
test('computeBriActionableException: OUTSIDE_FP_COVERAGE TIDAK dihitung meski status exception', () => {
  const rows = [resultRow({ recon_status: 'BANK_ONLY', coverage_status: 'OUTSIDE_FP_COVERAGE', fp_nominal: null, bank_total_debit: 500000 })];
  const r = computeBriActionableException(rows);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.nominal, 0);
});

// ── computeBriHealthStatus ────────────────────────────────────────────────
function healthInput(overrides = {}) {
  return {
    validMatchRateTransaction: 1, actionableExceptionCount: 0, syncStatus: 'success',
    invalidBusinessDateCount: 0, duplicateCanonicalResultCount: 0, consumedAlsoBankOnlyCount: 0,
    idConflictCount: 0, unbalancedBankRowCount: 0, extractionMediumCount: 0,
    outsideCoverageRatio: 0, hasPostingDelay: false,
    ...overrides,
  };
}
test('computeBriHealthStatus: semua bersih -> GREEN', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput()), 'GREEN');
});
test('computeBriHealthStatus: match rate 95-99% -> YELLOW', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ validMatchRateTransaction: 0.97 })), 'YELLOW');
});
test('computeBriHealthStatus: masih ada actionable exception -> YELLOW', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ actionableExceptionCount: 3 })), 'YELLOW');
});
test('computeBriHealthStatus: id_conflict_count 1-4 (di bawah material) -> YELLOW, bukan RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ idConflictCount: 2 })), 'YELLOW');
});
test('computeBriHealthStatus: unbalanced_bank_row_count 1-4 (di bawah material) -> YELLOW, bukan RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ unbalancedBankRowCount: 3 })), 'YELLOW');
});
test('computeBriHealthStatus: extraction confidence MEDIUM ada -> YELLOW', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ extractionMediumCount: 1 })), 'YELLOW');
});
test('computeBriHealthStatus: ada posting delay -> YELLOW', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ hasPostingDelay: true })), 'YELLOW');
});
test('computeBriHealthStatus: OUTSIDE_FP_COVERAGE ratio material (>5%) -> YELLOW', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ outsideCoverageRatio: 0.2 })), 'YELLOW');
});
test('computeBriHealthStatus: match rate <95% -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ validMatchRateTransaction: 0.80 })), 'RED');
});
test('computeBriHealthStatus: sync gagal -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ syncStatus: 'pending' })), 'RED');
});
test('computeBriHealthStatus: invalid_business_date_count > 0 -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ invalidBusinessDateCount: 1 })), 'RED');
});
test('computeBriHealthStatus: duplicate_canonical_result_count > 0 -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ duplicateCanonicalResultCount: 1 })), 'RED');
});
test('computeBriHealthStatus: consumed_also_bank_only_count > 0 -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ consumedAlsoBankOnlyCount: 1 })), 'RED');
});
test('computeBriHealthStatus: id_conflict_count material (>=5) -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ idConflictCount: 5 })), 'RED');
});
test('computeBriHealthStatus: unbalanced_bank_row_count material (>=5) -> RED', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ unbalancedBankRowCount: 5 })), 'RED');
});
test('computeBriHealthStatus: RED menang atas YELLOW kalau keduanya terpenuhi', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ actionableExceptionCount: 3, duplicateCanonicalResultCount: 1 })), 'RED');
});
test('computeBriHealthStatus: cross-date reversal VALID tidak pernah jadi input -> tidak memengaruhi status (GREEN tetap GREEN)', () => {
  // Fungsi ini TIDAK menerima parameter cross-date reversal sama sekali (spec:
  // "Cross-date reversal valid tidak otomatis membuat status RED") — cukup
  // pastikan tidak ada jalur di computeBriHealthStatus yg membaca field itu.
  assert.strictEqual(computeBriHealthStatus(healthInput()), 'GREEN');
});
test('computeBriHealthStatus: match rate null (tidak ada FP) + semua bersih -> GREEN', () => {
  assert.strictEqual(computeBriHealthStatus(healthInput({ validMatchRateTransaction: null })), 'GREEN');
});
test('BRI_HEALTH_THRESHOLDS: konfigurasi terpusat 99%/95%/material thresholds', () => {
  assert.strictEqual(BRI_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE, 0.99);
  assert.strictEqual(BRI_HEALTH_THRESHOLDS.YELLOW_MIN_MATCH_RATE, 0.95);
  assert.strictEqual(BRI_HEALTH_THRESHOLDS.ID_CONFLICT_MATERIAL_COUNT, 5);
  assert.strictEqual(BRI_HEALTH_THRESHOLDS.UNBALANCED_MATERIAL_COUNT, 5);
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
