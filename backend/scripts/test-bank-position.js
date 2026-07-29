'use strict';

// Test manual pakai Node built-in `assert` — mengikuti pola
// backend/scripts/test-balance-control-tower.js (belum ada test
// framework/mocking DB di project ini).
// Run: node backend/scripts/test-bank-position.js
//
// Hanya mencakup logic PURE (tidak menyentuh DB): klasifikasi mutasi
// kredit archive OCBC (funding vs reversal), dan dispatch generic
// bank-position/funding-detection service (unsupported bank -> gagal aman).
// Skenario yang butuh DB sungguhan (refresh-on-read benar2 membuat/tidak
// membuat snapshot baru, dedup partial unique index) diverifikasi
// end-to-end lewat server sungguhan setelah deploy, sama seperti pola test
// balance-control-tower/rekonsiliasi lain di project ini.

const assert = require('assert');
const { classifyFundingCandidates, normalizeGroupKey } = require('../src/reconciliation/bankPosition/adapters/ocbcAdapter');
const { getLatestVerifiedBankPosition, isSupportedBank } = require('../src/reconciliation/bankPosition/bankPositionService');
const { getConfirmedFundingMutations, getConfirmedIncomingNotYetReflected } = require('../src/reconciliation/bankPosition/fundingDetectionService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── normalizeGroupKey ───────────────────────────────────────────────────────
test('normalizeGroupKey: reference_no diprioritaskan di atas description', () => {
  assert.strictEqual(normalizeGroupKey('REF123', 'some desc'), 'ref:REF123');
});
test('normalizeGroupKey: fallback ke description kalau reference_no kosong', () => {
  assert.strictEqual(normalizeGroupKey(null, 'BI FAST Transfer'), 'desc:bi fast transfer');
  assert.strictEqual(normalizeGroupKey('', '  Some Desc  '), 'desc:some desc');
});
test('normalizeGroupKey: keduanya kosong -> null', () => {
  assert.strictEqual(normalizeGroupKey(null, null), null);
  assert.strictEqual(normalizeGroupKey('', ''), null);
});

// ── classifyFundingCandidates — data REAL production OCBC (row_fingerprint disamarkan) ──
const REAL_ROWS = [
  { reference_no: null, description: '7996-BI FAST Transfer BIMASAKTI MULTI SINE', debit: null, credit: 1500000000, transaction_date_time: '2026-07-29T07:04:32Z', row_fingerprint: 'fp-bifast-1' },
  { reference_no: null, description: '7996-CASA INC BI FAST PT BIMASAKTI MULTI S', debit: null, credit: 500000000, transaction_date_time: '2026-07-28T17:00:00Z', row_fingerprint: 'fp-casa-1' },
  { reference_no: null, description: '9821-Dr GNC Cr CA REVERSAL BIFAST 280726', debit: null, credit: 357410, transaction_date_time: '2026-07-29T02:39:00Z', row_fingerprint: 'fp-revers-1' },
  { reference_no: null, description: '9821-Dr GNC Cr CA REVERSAL BIAYA BIFAST 280726', debit: null, credit: 50, transaction_date_time: '2026-07-29T02:38:56Z', row_fingerprint: 'fp-revers-2' },
];

test('classifyFundingCandidates: transfer masuk asli (reference_no NULL) tetap terdeteksi sbg FUNDING', () => {
  const out = classifyFundingCandidates(REAL_ROWS);
  const bifast = out.find(m => m.dedup_key === 'fp-bifast-1');
  assert.ok(bifast, 'baris BI FAST Transfer harus muncul di hasil');
  assert.strictEqual(bifast.classification, 'FUNDING');
  assert.strictEqual(bifast.is_reversal, false);
  assert.strictEqual(bifast.amount, 1500000000);
});
test('classifyFundingCandidates: total funding (non-reversal) = Rp 2.000.000.000, cocok dgn temuan investigasi live', () => {
  const out = classifyFundingCandidates(REAL_ROWS);
  const total = out.filter(m => !m.is_reversal).reduce((s, m) => s + m.amount, 0);
  assert.strictEqual(total, 2000000000);
});
test('classifyFundingCandidates: description mengandung "REVERSAL" -> is_reversal=true, TIDAK ikut total funding', () => {
  const out = classifyFundingCandidates(REAL_ROWS);
  const rev1 = out.find(m => m.dedup_key === 'fp-revers-1');
  const rev2 = out.find(m => m.dedup_key === 'fp-revers-2');
  assert.strictEqual(rev1.is_reversal, true);
  assert.strictEqual(rev1.classification, 'REVERSAL');
  assert.strictEqual(rev2.is_reversal, true);
});
test('classifyFundingCandidates: reversal tetap DIKEMBALIKAN (bukan dibuang) -- utk visibilitas audit', () => {
  const out = classifyFundingCandidates(REAL_ROWS);
  assert.strictEqual(out.length, REAL_ROWS.length, 'seluruh baris kredit harus tetap ada di output, hanya beda flag');
});

test('classifyFundingCandidates: same-group debit pairing (reference_no sama) -> credit dianggap reversal', () => {
  const rows = [
    { reference_no: 'REF999', description: 'Settlement principal', debit: 100000, credit: null, transaction_date_time: '2026-07-29T03:00:00Z', row_fingerprint: 'fp-debit' },
    { reference_no: 'REF999', description: 'Settlement reversal', debit: null, credit: 100000, transaction_date_time: '2026-07-29T03:05:00Z', row_fingerprint: 'fp-credit' },
  ];
  const out = classifyFundingCandidates(rows);
  assert.strictEqual(out.length, 1, 'hanya baris kredit yang muncul di output (baris debit bukan kandidat funding)');
  assert.strictEqual(out[0].is_reversal, true);
  assert.strictEqual(out[0].classification, 'REVERSAL');
});
test('classifyFundingCandidates: credit TANPA debit di group manapun & TANPA pola reversal -> FUNDING murni', () => {
  const rows = [
    { reference_no: 'TRF001', description: 'Transfer masuk dari rekening lain', debit: null, credit: 250000000, transaction_date_time: '2026-07-29T09:00:00Z', row_fingerprint: 'fp-clean' },
  ];
  const out = classifyFundingCandidates(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].is_reversal, false);
  assert.strictEqual(out[0].classification, 'FUNDING');
});
test('classifyFundingCandidates: baris debit-only (tanpa credit) tidak pernah muncul di output', () => {
  const rows = [{ reference_no: 'X', description: 'Debit murni', debit: 50000, credit: null, transaction_date_time: '2026-07-29T09:00:00Z', row_fingerprint: 'fp-debitonly' }];
  const out = classifyFundingCandidates(rows);
  assert.strictEqual(out.length, 0);
});
test('classifyFundingCandidates: dedup_key = row_fingerprint apa adanya (identitas stabil dari archive)', () => {
  const rows = [{ reference_no: 'X', description: 'Transfer', debit: null, credit: 1000, transaction_date_time: '2026-07-29T09:00:00Z', row_fingerprint: 'unique-fp-abc' }];
  const out = classifyFundingCandidates(rows);
  assert.strictEqual(out[0].dedup_key, 'unique-fp-abc');
});
test('classifyFundingCandidates: is_already_reflected_in_balance selalu true (archive = sudah posted)', () => {
  const out = classifyFundingCandidates(REAL_ROWS);
  assert.ok(out.every(m => m.is_already_reflected_in_balance === true));
});
test('classifyFundingCandidates: array kosong -> hasil kosong, tidak error', () => {
  assert.deepStrictEqual(classifyFundingCandidates([]), []);
});

// ── Dispatch generic service — unsupported bank gagal AMAN ──────────────────
test('getLatestVerifiedBankPosition: bank_code tidak didukung -> available:false, TIDAK throw', async () => {
  const r = await getLatestVerifiedBankPosition({ pool: null, bankCode: 'MANDIRI', bankAccountId: 1 });
  assert.strictEqual(r.available, false);
  assert.ok(r.reason);
});
test('getLatestVerifiedBankPosition: bank_code kosong/tidak dikenal -> available:false, TIDAK throw', async () => {
  const r = await getLatestVerifiedBankPosition({ pool: null, bankCode: 'TIDAK_ADA', bankAccountId: 1 });
  assert.strictEqual(r.available, false);
});
test('isSupportedBank: OCBC didukung, bank lain belum', () => {
  assert.strictEqual(isSupportedBank('OCBC'), true);
  assert.strictEqual(isSupportedBank('MANDIRI'), false);
  assert.strictEqual(isSupportedBank('BRI'), false);
  assert.strictEqual(isSupportedBank('BNI'), false);
  assert.strictEqual(isSupportedBank(''), false);
  assert.strictEqual(isSupportedBank(undefined), false);
});
test('isSupportedBank: case-insensitive', () => {
  assert.strictEqual(isSupportedBank('ocbc'), true);
});
test('getConfirmedFundingMutations: bank tidak didukung -> available:false, mutations kosong, TIDAK throw', async () => {
  const r = await getConfirmedFundingMutations({ pool: null, bankCode: 'BNI', bankAccountId: 1, from: '2026-01-01', to: '2026-01-02' });
  assert.strictEqual(r.available, false);
  assert.deepStrictEqual(r.mutations, []);
});

// ── confirmed_incoming_not_yet_reflected — rilis ini SELALU 0 (sengaja, lihat scope) ──
test('getConfirmedIncomingNotYetReflected: rilis ini selalu {total:0, items:[]} -- belum ada bank-mutation matching', async () => {
  const r = await getConfirmedIncomingNotYetReflected({ pool: null, bankCode: 'OCBC', bankAccountId: 1 });
  assert.deepStrictEqual(r, { total: 0, items: [] });
});

// ── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
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
})();
