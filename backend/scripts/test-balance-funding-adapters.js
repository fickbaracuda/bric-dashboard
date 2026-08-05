'use strict';

// Test manual pakai Node built-in `assert`, pool di-mock (spec section 54:
// "Do not make tests depend on production DB"). Run:
// node backend/scripts/test-balance-funding-adapters.js

const assert = require('assert');
const {
  getOcbcBalance, getBcaBalance, getMandiriBalance, getBriLikeBalance, getBniBalance, getActualBankBalance,
} = require('../src/balanceFunding/bankBalanceAdapters');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** Mock pool -- setiap query() dijawab berurutan dari `responses` (array of {rows}). */
function mockPool(responses) {
  let i = 0;
  return {
    query: async () => {
      if (i >= responses.length) throw new Error(`mockPool: query ke-${i + 1} tidak diskenariokan`);
      return responses[i++];
    },
  };
}

// ── OCBC ──
test('OCBC: available_balance ada -> HIGH confidence', async () => {
  const pool = mockPool([{ rows: [{ id: 1, business_date: '2026-08-04', synced_at: new Date(), account_no: '123', raw_summary: { available_balance: 2494196877 } }] }]);
  const r = await getOcbcBalance(pool);
  assert.strictEqual(r.balance, 2494196877);
  assert.strictEqual(r.confidence, 'HIGH');
  assert.strictEqual(r.bank_code, 'OCBC');
});
test('OCBC: tidak ada batch sukses -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [] }]);
  const r = await getOcbcBalance(pool);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.balance, null);
});
test('OCBC: raw_summary tanpa available_balance -> UNAVAILABLE (bukan mengarang 0)', async () => {
  const pool = mockPool([{ rows: [{ id: 1, business_date: '2026-08-04', synced_at: new Date(), raw_summary: {} }] }]);
  const r = await getOcbcBalance(pool);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── BCA ──
test('BCA: footer sheet_footer -> HIGH', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: { current_balance: { saldo_akhir: 999000000, source: 'sheet_footer' } } }] }]);
  const r = await getBcaBalance(pool);
  assert.strictEqual(r.balance, 999000000);
  assert.strictEqual(r.confidence, 'HIGH');
});
test('BCA: row_order_fallback -> MEDIUM + warning', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: { current_balance: { saldo_akhir: 999000000, source: 'row_order_fallback' } } }] }]);
  const r = await getBcaBalance(pool);
  assert.strictEqual(r.confidence, 'MEDIUM');
  assert.ok(r.warnings.length > 0);
});
test('BCA: footer kosong, fallback ke balance_continuity OK -> MEDIUM', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: { current_balance: {}, balance_continuity: { status: 'BALANCE_CONTINUITY_OK', latest_balance_from_order: 500000000 } } }] }]);
  const r = await getBcaBalance(pool);
  assert.strictEqual(r.balance, 500000000);
  assert.strictEqual(r.confidence, 'MEDIUM');
});
test('BCA: tidak ada apa pun -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: {} }] }]);
  const r = await getBcaBalance(pool);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── MANDIRI (integrasi dgn validateMandiriBalance asli, bukan mock) ──
test('MANDIRI: baris balanced ASC -> ambil close_balance TERAKHIR (source_row_number terbesar), MEDIUM', async () => {
  const pool = mockPool([
    { rows: [{ id: 7, business_date: '2026-08-04', synced_at: new Date(), account_no: '456' }] }, // daftar batch (LIMIT 30, disini cuma 1)
    { rows: [
      { close_balance: 100, source_row_number: 1, debit: 0, credit: 0 },
      { close_balance: 150, source_row_number: 2, debit: 0, credit: 50 },
      { close_balance: 130, source_row_number: 3, debit: 20, credit: 0 },
    ] },
  ]);
  const r = await getMandiriBalance(pool);
  assert.strictEqual(r.balance, 130); // ASC -> terbaru = row terakhir (source_row_number=3)
  assert.strictEqual(r.confidence, 'MEDIUM');
});
test('MANDIRI: tidak ada baris close_balance sama sekali -> UNAVAILABLE', async () => {
  const pool = mockPool([
    { rows: [{ id: 7, business_date: '2026-08-04', synced_at: new Date() }] },
    { rows: [] },
  ]);
  const r = await getMandiriBalance(pool);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('MANDIRI: batch terbaru close_balance 0 di SEMUA baris (sync rusak) -> lewati, pakai batch valid berikutnya', async () => {
  const pool = mockPool([
    { rows: [
      { id: 20, business_date: '2026-08-04', synced_at: new Date('2026-08-04T10:00:00Z'), account_no: null }, // rusak (semua 0)
      { id: 19, business_date: '2026-07-27', synced_at: new Date('2026-07-27T10:00:00Z'), account_no: null }, // valid
    ] },
    { rows: [ // batch 20 -- semua close_balance 0
      { close_balance: 0, source_row_number: 1, debit: 10000, credit: 0 },
      { close_balance: 0, source_row_number: 2, debit: 5000, credit: 0 },
    ] },
    { rows: [ // batch 19 -- ada nonzero, dipercaya
      { close_balance: 500000000, source_row_number: 1, debit: 0, credit: 0 },
      { close_balance: 480000000, source_row_number: 2, debit: 20000000, credit: 0 },
    ] },
  ]);
  const r = await getMandiriBalance(pool);
  assert.strictEqual(r.balance, 480000000); // dari batch 19 (valid), bukan batch 20 (rusak)
  assert.strictEqual(r.business_date, '2026-07-27');
  assert.ok(r.warnings.some(w => w.includes('tidak terpercaya')));
});
test('MANDIRI: SEMUA batch dalam lookback close_balance 0 -> UNAVAILABLE, bukan Rp0 palsu', async () => {
  const pool = mockPool([
    { rows: [{ id: 20, business_date: '2026-08-04', synced_at: new Date() }] },
    { rows: [{ close_balance: 0, source_row_number: 1, debit: 100, credit: 0 }] },
  ]);
  const r = await getMandiriBalance(pool);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.balance, null); // TIDAK PERNAH Rp0 palsu -- null + UNAVAILABLE
});

// ── BRI / BRI_BIFAST ──
test('BRI: balance_check_status BALANCED -> MEDIUM', async () => {
  const pool = mockPool([{ rows: [{ batch_id: 1, business_date: '2026-08-04', synced_at: new Date(), account_no: null, balance: 5000000000, balance_check_status: 'BALANCED', effective_date_time: new Date(), sequence_no: '1' }] }]);
  const r = await getBriLikeBalance(pool, 'BRI');
  assert.strictEqual(r.bank_code, 'BRI');
  assert.strictEqual(r.balance, 5000000000);
  assert.strictEqual(r.confidence, 'MEDIUM');
});
test('BRI_BIFAST: balance_check_status UNBALANCED -> LOW', async () => {
  const pool = mockPool([{ rows: [{ batch_id: 1, business_date: '2026-08-04', synced_at: new Date(), account_no: '36001999999306', balance: 100, balance_check_status: 'UNBALANCED' }] }]);
  const r = await getBriLikeBalance(pool, 'BRI_BIFAST');
  assert.strictEqual(r.bank_code, 'BRI_BIFAST');
  assert.strictEqual(r.confidence, 'LOW');
});
test('BRI: tidak ada baris balance -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [] }]);
  const r = await getBriLikeBalance(pool, 'BRI');
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── BNI — SELALU UNAVAILABLE (struktural, bukan sementara) ──
test('BNI: selalu UNAVAILABLE, tidak pernah query DB utk cari saldo yang tidak ada', async () => {
  const r = await getBniBalance();
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.bank_code, 'BNI');
  assert.ok(r.warnings[0].includes('tidak memuat kolom saldo'));
});

// ── getActualBankBalance — dispatcher, bank_code tidak dikenal ──
test('getActualBankBalance: bank_code tidak dikenal -> UNAVAILABLE, bukan crash', async () => {
  const r = await getActualBankBalance(mockPool([]), 'XENDIT');
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('getActualBankBalance: error DB ditangani -> UNAVAILABLE, bukan throw ke caller', async () => {
  const pool = { query: async () => { throw new Error('connection lost'); } };
  const r = await getActualBankBalance(pool, 'OCBC');
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── Runner ──────────────────────────────────────────────────────────────
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
