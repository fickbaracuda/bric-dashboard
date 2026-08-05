'use strict';

// Test manual pakai Node built-in `assert`, pool di-mock (spec section 54:
// "Do not make tests depend on production DB"). Run:
// node backend/scripts/test-balance-funding-adapters.js

const assert = require('assert');
const {
  getOcbcBalance, getBcaBalance, getMandiriBalance, getBriLikeBalance, getBniBalance, getActualBankBalance,
  resolveDateOnlyPosition, resolveTimePosition,
} = require('../src/balanceFunding/bankBalanceAdapters');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// `now` tetap (bukan new Date() per-run) supaya deterministik -- semua
// fixture business_date/timestamp di file ini ada di masa lalu relatif ke
// titik ini.
const NOW = new Date('2026-08-05T12:00:00Z');

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
test('OCBC: available_balance ada -> HIGH confidence, position_time DATE-precision dari business_date', async () => {
  const pool = mockPool([{ rows: [{ id: 1, business_date: '2026-08-04', synced_at: new Date('2026-08-04T12:30:00Z'), account_no: '123', raw_summary: { available_balance: 2494196877 } }] }]);
  const r = await getOcbcBalance(pool, NOW);
  assert.strictEqual(r.balance, 2494196877);
  assert.strictEqual(r.confidence, 'HIGH');
  assert.strictEqual(r.bank_code, 'OCBC');
  assert.strictEqual(r.balance_position_precision, 'DATE');
  assert.strictEqual(r.balance_position_time.toISOString(), '2026-08-03T17:00:00.000Z'); // 00:00 WIB 2026-08-04
  assert.strictEqual(r.last_sync_at.toISOString(), '2026-08-04T12:30:00.000Z'); // BEDA dari balance_position_time
  assert.strictEqual(r.balance_source, 'recon_sync_batches.raw_summary.available_balance');
});
test('OCBC: business_date di masa depan (anomali parsing) -> position_time null, confidence turun ke MEDIUM', async () => {
  const pool = mockPool([{ rows: [{ id: 1, business_date: '2026-09-07', synced_at: new Date('2026-07-30T08:00:00Z'), account_no: '123', raw_summary: { available_balance: 100 } }] }]);
  const r = await getOcbcBalance(pool, NOW); // NOW = 2026-08-05, business_date 2026-09-07 = masa depan
  assert.strictEqual(r.balance, 100); // saldo tetap tampil (bukan block seluruhnya)
  assert.strictEqual(r.balance_position_time, null);
  assert.strictEqual(r.confidence, 'MEDIUM'); // diturunkan dari HIGH
  assert.ok(r.warnings.some(w => w.includes('masa depan')));
});
test('OCBC: tidak ada batch sukses -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [] }]);
  const r = await getOcbcBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.balance, null);
  assert.strictEqual(r.balance_position_time, null);
});
test('OCBC: raw_summary tanpa available_balance -> UNAVAILABLE (bukan mengarang 0)', async () => {
  const pool = mockPool([{ rows: [{ id: 1, business_date: '2026-08-04', synced_at: new Date(), raw_summary: {} }] }]);
  const r = await getOcbcBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── BCA ──
test('BCA: footer sheet_footer -> HIGH, position_time DATE-precision', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date('2026-08-04T09:00:00Z'), raw_summary: { current_balance: { saldo_akhir: 999000000, source: 'sheet_footer' } } }] }]);
  const r = await getBcaBalance(pool, NOW);
  assert.strictEqual(r.balance, 999000000);
  assert.strictEqual(r.confidence, 'HIGH');
  assert.strictEqual(r.balance_position_precision, 'DATE');
  assert.strictEqual(r.balance_position_time.toISOString(), '2026-08-03T17:00:00.000Z');
});
test('BCA: row_order_fallback -> MEDIUM + warning', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: { current_balance: { saldo_akhir: 999000000, source: 'row_order_fallback' } } }] }]);
  const r = await getBcaBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'MEDIUM');
  assert.ok(r.warnings.length > 0);
});
test('BCA: footer kosong, fallback ke balance_continuity OK -> MEDIUM', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: { current_balance: {}, balance_continuity: { status: 'BALANCE_CONTINUITY_OK', latest_balance_from_order: 500000000 } } }] }]);
  const r = await getBcaBalance(pool, NOW);
  assert.strictEqual(r.balance, 500000000);
  assert.strictEqual(r.confidence, 'MEDIUM');
});
test('BCA: tidak ada apa pun -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-08-04', synced_at: new Date(), raw_summary: {} }] }]);
  const r = await getBcaBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('BCA: business_date di masa depan (bug nyata ditemukan di produksi: 2026-09-07) -> position_time null, confidence LOW', async () => {
  const pool = mockPool([{ rows: [{ id: 5, business_date: '2026-09-07', synced_at: new Date('2026-07-30T08:13:40Z'), raw_summary: { current_balance: { saldo_akhir: 8742.96, source: 'sheet_footer' } } }] }]);
  const r = await getBcaBalance(pool, NOW);
  assert.strictEqual(r.balance, 8742.96);
  assert.strictEqual(r.balance_position_time, null);
  assert.strictEqual(r.confidence, 'LOW');
  assert.ok(r.warnings.some(w => w.includes('masa depan')));
});

// ── MANDIRI (integrasi dgn validateMandiriBalance asli, bukan mock) ──
test('MANDIRI: baris balanced ASC -> ambil close_balance TERAKHIR (source_row_number terbesar), MEDIUM, position_time = post_date_time baris itu', async () => {
  const pool = mockPool([
    { rows: [{ id: 7, business_date: '2026-08-04', synced_at: new Date('2026-08-04T12:32:00Z'), account_no: '456' }] }, // daftar batch (LIMIT 30, disini cuma 1)
    { rows: [
      { close_balance: 100, source_row_number: 1, debit: 0, credit: 0, post_date_time: new Date('2026-08-04T10:00:00Z') },
      { close_balance: 150, source_row_number: 2, debit: 0, credit: 50, post_date_time: new Date('2026-08-04T11:00:00Z') },
      { close_balance: 130, source_row_number: 3, debit: 20, credit: 0, post_date_time: new Date('2026-08-04T11:30:00Z') },
    ] },
  ]);
  const r = await getMandiriBalance(pool, NOW);
  assert.strictEqual(r.balance, 130); // ASC -> terbaru = row terakhir (source_row_number=3)
  assert.strictEqual(r.confidence, 'MEDIUM');
  assert.strictEqual(r.balance_position_precision, 'MINUTE');
  assert.strictEqual(r.balance_position_time.toISOString(), '2026-08-04T11:30:00.000Z'); // post_date_time baris terpilih
  assert.strictEqual(r.last_sync_at.toISOString(), '2026-08-04T12:32:00.000Z'); // BEDA dari balance_position_time (sync time)
  assert.notStrictEqual(r.balance_position_time.getTime(), r.last_sync_at.getTime());
});
test('MANDIRI: tidak ada baris close_balance sama sekali -> UNAVAILABLE', async () => {
  const pool = mockPool([
    { rows: [{ id: 7, business_date: '2026-08-04', synced_at: new Date() }] },
    { rows: [] },
  ]);
  const r = await getMandiriBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('MANDIRI: batch terbaru close_balance 0 di SEMUA baris (sync rusak) -> lewati, pakai batch valid berikutnya, position_time dari batch valid', async () => {
  const pool = mockPool([
    { rows: [
      { id: 20, business_date: '2026-08-04', synced_at: new Date('2026-08-04T10:00:00Z'), account_no: null }, // rusak (semua 0)
      { id: 19, business_date: '2026-07-27', synced_at: new Date('2026-07-27T10:00:00Z'), account_no: null }, // valid
    ] },
    { rows: [ // batch 20 -- semua close_balance 0
      { close_balance: 0, source_row_number: 1, debit: 10000, credit: 0, post_date_time: new Date('2026-08-04T09:00:00Z') },
      { close_balance: 0, source_row_number: 2, debit: 5000, credit: 0, post_date_time: new Date('2026-08-04T09:30:00Z') },
    ] },
    { rows: [ // batch 19 -- ada nonzero, dipercaya
      { close_balance: 500000000, source_row_number: 1, debit: 0, credit: 0, post_date_time: new Date('2026-07-27T08:00:00Z') },
      { close_balance: 480000000, source_row_number: 2, debit: 20000000, credit: 0, post_date_time: new Date('2026-07-27T09:00:00Z') },
    ] },
  ]);
  const r = await getMandiriBalance(pool, NOW);
  assert.strictEqual(r.balance, 480000000); // dari batch 19 (valid), bukan batch 20 (rusak)
  assert.strictEqual(r.business_date, '2026-07-27');
  assert.strictEqual(r.balance_position_time.toISOString(), '2026-07-27T09:00:00.000Z'); // dari batch 19, BUKAN batch 20
  assert.ok(r.warnings.some(w => w.includes('tidak terpercaya')));
});
test('MANDIRI: SEMUA batch dalam lookback close_balance 0 -> UNAVAILABLE, bukan Rp0 palsu', async () => {
  const pool = mockPool([
    { rows: [{ id: 20, business_date: '2026-08-04', synced_at: new Date() }] },
    { rows: [{ close_balance: 0, source_row_number: 1, debit: 100, credit: 0 }] },
  ]);
  const r = await getMandiriBalance(pool, NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.balance, null); // TIDAK PERNAH Rp0 palsu -- null + UNAVAILABLE
  assert.strictEqual(r.balance_position_time, null);
});
test('MANDIRI: post_date_time null pada baris terpilih -> position_time null, confidence turun ke LOW', async () => {
  const pool = mockPool([
    { rows: [{ id: 7, business_date: '2026-08-04', synced_at: new Date(), account_no: '456' }] },
    { rows: [{ close_balance: 130, source_row_number: 1, debit: 0, credit: 0, post_date_time: null }] },
  ]);
  const r = await getMandiriBalance(pool, NOW);
  assert.strictEqual(r.balance, 130); // saldo tetap tampil
  assert.strictEqual(r.balance_position_time, null);
  assert.strictEqual(r.confidence, 'LOW');
});

// ── BRI / BRI_BIFAST ──
test('BRI: balance_check_status BALANCED -> MEDIUM, position_time = effective_date_time (BUKAN synced_at)', async () => {
  const pool = mockPool([{ rows: [{ batch_id: 1, business_date: '2026-07-14', synced_at: new Date('2026-07-14T08:20:31Z'), account_no: null, balance: 5000000000, balance_check_status: 'BALANCED', effective_date_time: new Date('2026-07-10T17:00:00Z'), sequence_no: '1' }] }]);
  const r = await getBriLikeBalance(pool, 'BRI', NOW);
  assert.strictEqual(r.bank_code, 'BRI');
  assert.strictEqual(r.balance, 5000000000);
  assert.strictEqual(r.confidence, 'MEDIUM');
  assert.strictEqual(r.balance_position_precision, 'MINUTE');
  assert.strictEqual(r.balance_position_time.toISOString(), '2026-07-10T17:00:00.000Z'); // dari effective_date_time riil
  assert.strictEqual(r.last_sync_at.toISOString(), '2026-07-14T08:20:31.000Z'); // sync 4 hari SETELAH posisi saldo aslinya -- konfirmasi data produksi nyata
  assert.notStrictEqual(r.balance_position_time.getTime(), r.last_sync_at.getTime());
});
test('BRI_BIFAST: balance_check_status UNBALANCED -> LOW', async () => {
  const pool = mockPool([{ rows: [{ batch_id: 1, business_date: '2026-08-04', synced_at: new Date(), account_no: '36001999999306', balance: 100, balance_check_status: 'UNBALANCED', effective_date_time: new Date('2026-08-04T10:00:00Z') }] }]);
  const r = await getBriLikeBalance(pool, 'BRI_BIFAST', NOW);
  assert.strictEqual(r.bank_code, 'BRI_BIFAST');
  assert.strictEqual(r.confidence, 'LOW');
});
test('BRI: tidak ada baris balance -> UNAVAILABLE', async () => {
  const pool = mockPool([{ rows: [] }]);
  const r = await getBriLikeBalance(pool, 'BRI', NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('BRI: effective_date_time kosong -> position_time null, confidence turun ke LOW', async () => {
  const pool = mockPool([{ rows: [{ batch_id: 1, business_date: '2026-08-04', synced_at: new Date(), account_no: null, balance: 100, balance_check_status: 'BALANCED', effective_date_time: null }] }]);
  const r = await getBriLikeBalance(pool, 'BRI', NOW);
  assert.strictEqual(r.balance, 100);
  assert.strictEqual(r.balance_position_time, null);
  assert.strictEqual(r.confidence, 'LOW');
});

// ── BNI — SELALU UNAVAILABLE (struktural, bukan sementara) ──
test('BNI: selalu UNAVAILABLE, tidak pernah query DB utk cari saldo yang tidak ada', async () => {
  const r = await getBniBalance();
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
  assert.strictEqual(r.bank_code, 'BNI');
  assert.strictEqual(r.balance_position_time, null);
  assert.ok(r.warnings[0].includes('tidak memuat kolom saldo'));
});

// ── getActualBankBalance — dispatcher, bank_code tidak dikenal ──
test('getActualBankBalance: bank_code tidak dikenal -> UNAVAILABLE, bukan crash', async () => {
  const r = await getActualBankBalance(mockPool([]), 'XENDIT', NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('getActualBankBalance: error DB ditangani -> UNAVAILABLE, bukan throw ke caller', async () => {
  const pool = { query: async () => { throw new Error('connection lost'); } };
  const r = await getActualBankBalance(pool, 'OCBC', NOW);
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});
test('getActualBankBalance: now default (tidak dikirim) tidak crash', async () => {
  const r = await getActualBankBalance(mockPool([]), 'XENDIT');
  assert.strictEqual(r.confidence, 'UNAVAILABLE');
});

// ── resolveDateOnlyPosition / resolveTimePosition — helper murni ──
test('resolveDateOnlyPosition: business_date valid & masa lalu -> DATE precision', () => {
  const r = resolveDateOnlyPosition('2026-08-04', NOW);
  assert.strictEqual(r.precision, 'DATE');
  assert.strictEqual(r.downgrade, false);
});
test('resolveDateOnlyPosition: business_date kosong -> null + downgrade', () => {
  const r = resolveDateOnlyPosition(null, NOW);
  assert.strictEqual(r.position_time, null);
  assert.strictEqual(r.downgrade, true);
});
test('resolveTimePosition: timestamp masa lalu valid -> MINUTE precision', () => {
  const r = resolveTimePosition('2026-08-04T10:00:00Z', NOW);
  assert.strictEqual(r.precision, 'MINUTE');
  assert.strictEqual(r.downgrade, false);
});
test('resolveTimePosition: timestamp masa depan -> null + downgrade (no fake timestamp)', () => {
  const r = resolveTimePosition('2026-08-06T10:00:00Z', NOW);
  assert.strictEqual(r.position_time, null);
  assert.strictEqual(r.downgrade, true);
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
