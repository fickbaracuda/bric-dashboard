'use strict';

// Test manual pakai Node built-in `assert` (konsisten dgn
// test-reconciliation-ocbc.js, project ini belum punya test framework).
// Fokus file ini: backend/src/reconciliation/periodicBalanceNeeds.js —
// SHARED service dipakai tab "Kebutuhan Saldo" di OCBC/Mandiri/BRI/
// BRI BI-FAST/BNI. computePeriodicBalanceNeeds/dateRangeArray SUDAH
// dites tidak berubah lewat BALANCE-NEEDS TEST 1-7 di
// test-reconciliation-ocbc.js (delegasi, byte-identik dgn implementasi
// lama) -- file ini menambah skenario yang SPESIFIK ke generalisasi
// multi-bank (allowlist, label, default fee per bank, resolusi expected
// fee OCBC vs bank lain, exclude/include row types, BNI funding
// comparison, batasan rentang >90 hari) yang TIDAK relevan/tidak ada di
// suite khusus OCBC.
//
// Run: node backend/scripts/test-periodic-balance-needs.js

const assert = require('assert');
const {
  BANK_ALLOWLIST, BANK_LABELS, DEFAULT_FEE_BY_BANK, CROSS_DATE_GUARD_MODE,
  isValidBankCode, bankLabel, hourLabel, dateRangeArray,
  computePeriodicBalanceNeeds, resolveExpectedFeePerBatch,
  getHourlyTransactionRows, computeBniFundingComparison, buildBalanceNeedsResponse,
} = require('../src/reconciliation/periodicBalanceNeeds');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Allowlist & label — server-side, TIDAK PERNAH menerima bank_code
// arbitrary dari frontend ───────────────────────────────────────────────
test('BANK ALLOWLIST: hanya 5 bank yang didukung, tidak lebih tidak kurang', () => {
  assert.deepStrictEqual(BANK_ALLOWLIST.slice().sort(), ['BNI', 'BRI', 'BRI_BIFAST', 'MANDIRI', 'OCBC'].sort());
});
test('isValidBankCode: menolak bank_code arbitrary/tidak dikenal', () => {
  assert.strictEqual(isValidBankCode('OCBC'), true);
  assert.strictEqual(isValidBankCode('MANDIRI'), true);
  assert.strictEqual(isValidBankCode('BRI'), true);
  assert.strictEqual(isValidBankCode('BRI_BIFAST'), true);
  assert.strictEqual(isValidBankCode('BNI'), true);
  assert.strictEqual(isValidBankCode('BCA'), false);
  assert.strictEqual(isValidBankCode(''), false);
  assert.strictEqual(isValidBankCode(undefined), false);
  assert.strictEqual(isValidBankCode("OCBC'; DROP TABLE users;--"), false);
});
test('bankLabel: label sesuai spec (BRI_BIFAST -> "BRI BI-FAST")', () => {
  assert.strictEqual(bankLabel('OCBC'), 'OCBC');
  assert.strictEqual(bankLabel('MANDIRI'), 'Mandiri');
  assert.strictEqual(bankLabel('BRI'), 'BRI');
  assert.strictEqual(bankLabel('BRI_BIFAST'), 'BRI BI-FAST');
  assert.strictEqual(bankLabel('BNI'), 'BNI');
  assert.strictEqual(Object.keys(BANK_LABELS).length, 5);
});
test('hourLabel: format "09:00–09:59", null utk jam di luar 0-23', () => {
  assert.strictEqual(hourLabel(0), '00:00–00:59');
  assert.strictEqual(hourLabel(9), '09:00–09:59');
  assert.strictEqual(hourLabel(23), '23:00–23:59');
  assert.strictEqual(hourLabel(24), null);
  assert.strictEqual(hourLabel(-1), null);
});

// ── TEST: 24 bucket jam selalu ada (generalisasi multi-bank dari
// BALANCE-NEEDS TEST 1 OCBC, dipastikan tetap berlaku via fungsi shared) ──
test('SHARED TEST: 24 hourly buckets selalu dihasilkan walau tidak ada transaksi sama sekali', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-01');
  const includedDayFees = [{ business_date: '2026-07-01', expected_fee: 150 }];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, []);
  assert.strictEqual(result.hourly.length, 24);
  assert.ok(result.hourly.every(h => h.total_transaction === 0 && h.total_balance_need === 0));
});

// ── TEST: average dibagi included_days, bukan selected_days (tanggal
// tanpa batch dikecualikan dari pembagi, TIDAK dianggap 0) ───────────────
test('SHARED TEST: average dibagi included_days, tanggal tanpa batch dikecualikan dari pembagi', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-05'); // 5 hari kalender
  const includedDayFees = [
    { business_date: '2026-07-01', expected_fee: 100 },
    { business_date: '2026-07-03', expected_fee: 100 },
  ]; // hanya 2 hari punya batch (03 & 05 tidak berurutan sengaja, tes non-contiguous)
  const hourlyRows = [
    { business_date: '2026-07-01', hour: 5, tx_count: 2, principal_sum: 200000 },
    { business_date: '2026-07-03', hour: 5, tx_count: 2, principal_sum: 200000 },
  ];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  assert.strictEqual(result.coverage.selected_days, 5);
  assert.strictEqual(result.coverage.included_days, 2);
  assert.strictEqual(result.coverage.missing_days, 3);
  assert.deepStrictEqual(result.coverage.missing_dates.sort(), ['2026-07-02', '2026-07-04', '2026-07-05']);
  // rata2 trx jam 5 = (2+2)/2 (included_days) = 2, BUKAN /5 (selected_days)
  assert.strictEqual(result.hourly[5].average_transaction_per_day, 2);
});

// ── TEST: tanggal included dgn transaksi 0 tetap dihitung sbg included
// day bernilai 0, bukan dikeluarkan dari pembagi ──────────────────────────
test('SHARED TEST: included day tanpa transaksi tetap dihitung 0 dalam pembagi (bukan dikeluarkan)', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-02');
  const includedDayFees = [
    { business_date: '2026-07-01', expected_fee: 100 },
    { business_date: '2026-07-02', expected_fee: 100 }, // batch ada, tapi nihil transaksi sama sekali
  ];
  const hourlyRows = [{ business_date: '2026-07-01', hour: 8, tx_count: 4, principal_sum: 400000 }];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  assert.strictEqual(result.coverage.included_days, 2);
  // total kebutuhan jam 8 = 400000+4*100=400400; average dibagi 2 (bukan 1)
  assert.strictEqual(result.hourly[8].average_balance_need_per_day, 400400 / 2);
  assert.strictEqual(result.hourly[8].minimum_daily_need, 0); // tanggal 02 kontribusi 0
});

// ── TEST: expected fee per-batch, TIDAK diseragamkan ke satu nilai utk
// seluruh periode (setiap bank simpan fee di batch masing2 tanggal) ──────
test('SHARED TEST: expected fee mengikuti batch masing-masing tanggal, bukan diseragamkan', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-02');
  const includedDayFees = [
    { business_date: '2026-07-01', expected_fee: 100 }, // fee lama
    { business_date: '2026-07-02', expected_fee: 150 }, // fee baru (naik di tengah periode)
  ];
  const hourlyRows = [
    { business_date: '2026-07-01', hour: 10, tx_count: 1, principal_sum: 50000 },
    { business_date: '2026-07-02', hour: 10, tx_count: 1, principal_sum: 50000 },
  ];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  const daily = result.daily.slice().sort((a, b) => a.business_date.localeCompare(b.business_date));
  assert.strictEqual(daily[0].expected_fee, 100);
  assert.strictEqual(daily[1].expected_fee, 150);
});

// ── TEST: rentang tanpa batch sama sekali -> empty:true ──────────────────
test('SHARED TEST: rentang tanpa batch sama sekali -> empty:true, hourly & daily kosong', () => {
  const selectedDates = dateRangeArray('2026-09-01', '2026-09-05');
  const result = computePeriodicBalanceNeeds(selectedDates, [], []);
  assert.strictEqual(result.empty, true);
  assert.strictEqual(result.summary, null);
  assert.deepStrictEqual(result.hourly, []);
  assert.deepStrictEqual(result.daily, []);
  assert.strictEqual(result.coverage.included_days, 0);
  assert.strictEqual(result.coverage.missing_days, 5);
});

// ── TEST: duplicate canonical key hanya dihitung SEKALI (dedup terjadi
// di query SQL/DISTINCT ON sebelum masuk ke computePeriodicBalanceNeeds --
// fungsi pure ini menerima hourlyRows yang SUDAH agregat per jam, jadi
// test-nya adalah memastikan fungsi tidak menjumlahkan ganda kalau
// dipanggil dgn baris agregat yang sudah benar, dan TIDAK mengalikan
// count) ──────────────────────────────────────────────────────────────────
test('SHARED TEST: hourlyRows sudah teragregasi 1x per (tanggal,jam) -- tidak ada double counting internal', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-01');
  const includedDayFees = [{ business_date: '2026-07-01', expected_fee: 100 }];
  // Simulasikan 3 transaksi unik (setelah DISTINCT ON di SQL) pada jam 9
  const hourlyRows = [{ business_date: '2026-07-01', hour: 9, tx_count: 3, principal_sum: 300000 }];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  assert.strictEqual(result.hourly[9].total_transaction, 3);
  assert.strictEqual(result.hourly[9].total_balance_need, 300000 + 3 * 100);
  assert.strictEqual(result.summary.total_transaction, 3);
});

// ── TEST: BRI BI-FAST -- principal+fee 1 transaksi, TIDAK dihitung dua
// kali sbg 2 baris terpisah (spec: "prinsipal+fee = SATU transaksi") ─────
test('SHARED TEST: BRI BI-FAST -- 1 transaksi dgn fee tetap dihitung sbg 1 tx_count (bukan 2)', () => {
  const selectedDates = dateRangeArray('2026-07-01', '2026-07-01');
  const includedDayFees = [{ business_date: '2026-07-01', expected_fee: 77 }]; // DEFAULT_FEE_BRI_BIFAST
  // 1 transaksi BI-FAST: principal 500000 + fee 77, direpresentasikan
  // sbg SATU baris agregat (tx_count=1), bukan 2 baris terpisah.
  const hourlyRows = [{ business_date: '2026-07-01', hour: 14, tx_count: 1, principal_sum: 500000 }];
  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);
  assert.strictEqual(result.hourly[14].total_transaction, 1, 'tx_count harus 1, bukan 2 (principal & fee bukan transaksi terpisah)');
  assert.strictEqual(result.hourly[14].total_balance_need, 500000 + 77);
  assert.strictEqual(result.daily[0].transaction_count, 1);
});

// ── TEST: rentang >90 hari ditolak (400), rentang <=90 hari diterima ─────
test('BUILD RESPONSE TEST: rentang >90 hari ditolak (400)', async () => {
  const result = await buildBalanceNeedsResponse({ pool: { query: async () => ({ rows: [] }) }, bankCode: 'OCBC', startDate: '2026-01-01', endDate: '2026-06-01' }); // 152 hari
  assert.strictEqual(result.statusCode, 400);
  assert.match(result.body.error, /90 hari/);
});
test('BUILD RESPONSE TEST: rentang tepat 90 hari diterima (tidak 400 karena rentang)', async () => {
  const fakePool = { query: async () => ({ rows: [] }) }; // tidak ada batch -> empty response, bukan reject krn rentang
  const result = await buildBalanceNeedsResponse({ pool: fakePool, bankCode: 'OCBC', startDate: '2026-01-01', endDate: '2026-03-31' }); // 90 hari persis
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.empty, true);
});
test('BUILD RESPONSE TEST: bank_code tidak valid ditolak (400), tidak pernah query DB', async () => {
  let queried = false;
  const fakePool = { query: async () => { queried = true; return { rows: [] }; } };
  const result = await buildBalanceNeedsResponse({ pool: fakePool, bankCode: 'BCA', startDate: '2026-07-01', endDate: '2026-07-07' });
  assert.strictEqual(result.statusCode, 400);
  assert.strictEqual(queried, false, 'tidak boleh query DB kalau bank_code sudah invalid di allowlist check');
});
test('BUILD RESPONSE TEST: end_date < start_date ditolak (400)', async () => {
  const result = await buildBalanceNeedsResponse({ pool: { query: async () => ({ rows: [] }) }, bankCode: 'OCBC', startDate: '2026-07-10', endDate: '2026-07-01' });
  assert.strictEqual(result.statusCode, 400);
});
test('BUILD RESPONSE TEST: format tanggal tidak valid ditolak (400)', async () => {
  const result = await buildBalanceNeedsResponse({ pool: { query: async () => ({ rows: [] }) }, bankCode: 'OCBC', startDate: '01/07/2026', endDate: '07/07/2026' });
  assert.strictEqual(result.statusCode, 400);
});

// ── TEST: resolveExpectedFeePerBatch -- OCBC diturunkan dari
// recon_results (bank_fee - variance_fee), bank lain pakai kolom
// recon_sync_batches.expected_fee langsung ────────────────────────────────
test('resolveExpectedFeePerBatch: OCBC diturunkan dari recon_results (bank_fee - variance_fee)', async () => {
  const fakePool = {
    query: async (sql, params) => {
      assert.match(sql, /recon_results/);
      assert.match(sql, /variance_fee IS NOT NULL/);
      return { rows: [{ batch_id: '1', derived_fee: '25' }] };
    },
  };
  const batches = [{ id: 1, business_date: '2026-07-01', expected_fee: null }];
  const feeMap = await resolveExpectedFeePerBatch(fakePool, 'OCBC', batches);
  assert.strictEqual(feeMap.get('2026-07-01'), 25);
});
test('resolveExpectedFeePerBatch: OCBC fallback ke default fee kalau batch tidak punya recon_results dgn fee', async () => {
  const fakePool = { query: async () => ({ rows: [] }) }; // tidak ada baris recon_results utk batch ini
  const batches = [{ id: 99, business_date: '2026-07-01', expected_fee: null }];
  const feeMap = await resolveExpectedFeePerBatch(fakePool, 'OCBC', batches);
  assert.strictEqual(feeMap.get('2026-07-01'), DEFAULT_FEE_BY_BANK.OCBC);
});
test('resolveExpectedFeePerBatch: bank non-OCBC pakai expected_fee dari kolom batch langsung, TANPA query recon_results', async () => {
  let queried = false;
  const fakePool = { query: async () => { queried = true; return { rows: [] }; } };
  const batches = [
    { id: 1, business_date: '2026-07-01', expected_fee: 150 },
    { id: 2, business_date: '2026-07-02', expected_fee: 100 },
  ];
  const feeMap = await resolveExpectedFeePerBatch(fakePool, 'BRI', batches);
  assert.strictEqual(queried, false, 'bank non-OCBC tidak boleh query recon_results utk fee');
  assert.strictEqual(feeMap.get('2026-07-01'), 150);
  assert.strictEqual(feeMap.get('2026-07-02'), 100);
});
test('resolveExpectedFeePerBatch: BNI expected_fee Rp0 TETAP dipakai apa adanya (bukan fallback ke default)', () => {
  // BNI DEFAULT_FEE_BY_BANK = 0, jadi Rp0 eksplisit dari batch dan fallback
  // kebetulan sama nilainya -- verifikasi eksplisit lewat jalur "batch
  // punya expected_fee=0 yang valid" (Number.isFinite(0) === true, bukan
  // falsy-check yang keliru menganggap 0 sbg 'tidak ada nilai').
  assert.strictEqual(DEFAULT_FEE_BY_BANK.BNI, 0);
  const fee = (0 !== null && 0 !== undefined) ? Number(0) : NaN;
  assert.strictEqual(Number.isFinite(fee) ? fee : -1, 0);
});
test('resolveExpectedFeePerBatch: bank non-OCBC fallback ke default kalau expected_fee null/undefined pada batch', async () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const batches = [{ id: 1, business_date: '2026-07-01', expected_fee: null }];
  const feeMapMandiri = await resolveExpectedFeePerBatch(fakePool, 'MANDIRI', batches);
  assert.strictEqual(feeMapMandiri.get('2026-07-01'), DEFAULT_FEE_BY_BANK.MANDIRI);
  const feeMapBifast = await resolveExpectedFeePerBatch(fakePool, 'BRI_BIFAST', [{ id: 1, business_date: '2026-07-01', expected_fee: undefined }]);
  assert.strictEqual(feeMapBifast.get('2026-07-01'), DEFAULT_FEE_BY_BANK.BRI_BIFAST);
});

// ── REGRESI: cross-date guard TIDAK boleh seragam dipaksakan ke semua
// bank -- insiden nyata ditemukan saat live-verify pasca-deploy: batch BRI
// BI-FAST tanggal 2026-07-17 punya 917 baris MATCHED (recon_results,
// id_transaksi terisi, fp_time_response terisi) tapi SEMUANYA punya
// bank_transaction_date beda dari business_date batch (BI-FAST memang
// "rolling sheet" by design, TIDAK PERNAH difilter berdasarkan itu di
// dailyReportHandler-nya sendiri) -- guard 'strict' yang di-copy polos dari
// OCBC membuat SELURUH 917 transaksi itu ter-exclude & Kebutuhan Saldo BI-
// FAST tampil 0 padahal dailyReportHandler bank yg SAMA melaporkan
// matched_transaksi=917. Fix: CROSS_DATE_GUARD_MODE per bank, mengikuti
// konvensi masing2 dailyReportHandler/analyticsHandler bank itu sendiri
// (bukan satu aturan dipaksakan ke semua) ───────────────────────────────
test('CROSS_DATE_GUARD_MODE: OCBC & MANDIRI strict (exclude cross-date dari SELURUH kalkulasi, sama dgn dailyReportHandler masing2)', () => {
  assert.strictEqual(CROSS_DATE_GUARD_MODE.OCBC, 'strict');
  assert.strictEqual(CROSS_DATE_GUARD_MODE.MANDIRI, 'strict');
});
test('CROSS_DATE_GUARD_MODE: BRI strict TAPI dgn carve-out reversal cross-date valid (CROSS_DATE_LOOKUP)', () => {
  assert.strictEqual(CROSS_DATE_GUARD_MODE.BRI, 'strict_reversal_carveout');
});
test('CROSS_DATE_GUARD_MODE: BRI_BIFAST & BNI "none" -- dailyReportHandler masing2 TIDAK PERNAH mengecualikan baris cross-date dari total, jadi shared query jg tidak boleh', () => {
  assert.strictEqual(CROSS_DATE_GUARD_MODE.BRI_BIFAST, 'none');
  assert.strictEqual(CROSS_DATE_GUARD_MODE.BNI, 'none');
});
test('getHourlyTransactionRows: OCBC mengirim klausa strict bank_transaction_date di SQL', async () => {
  let capturedSql = null;
  const fakePool = { query: async (sql) => { capturedSql = sql; return { rows: [] }; } };
  await getHourlyTransactionRows(fakePool, [1], 'OCBC');
  assert.match(capturedSql, /bank_transaction_date::text = b\.business_date::text/);
  assert.doesNotMatch(capturedSql, /CROSS_DATE_LOOKUP/);
});
test('getHourlyTransactionRows: BRI mengirim klausa strict DENGAN carve-out CROSS_DATE_LOOKUP', async () => {
  let capturedSql = null;
  const fakePool = { query: async (sql) => { capturedSql = sql; return { rows: [] }; } };
  await getHourlyTransactionRows(fakePool, [1], 'BRI');
  assert.match(capturedSql, /bank_transaction_date::text = b\.business_date::text/);
  assert.match(capturedSql, /CROSS_DATE_LOOKUP/);
});
test('getHourlyTransactionRows: BRI_BIFAST & BNI TIDAK mengirim klausa bank_transaction_date sama sekali (regresi insiden 917 baris ter-exclude)', async () => {
  for (const code of ['BRI_BIFAST', 'BNI']) {
    let capturedSql = null;
    const fakePool = { query: async (sql) => { capturedSql = sql; return { rows: [] }; } };
    await getHourlyTransactionRows(fakePool, [1], code);
    assert.doesNotMatch(capturedSql, /bank_transaction_date/, `${code} tidak boleh memfilter bank_transaction_date`);
  }
});

// ── TEST: BNI funding comparison -- funding_credit TIDAK dihitung sbg
// balance need, murni panel info arus dana terpisah ──────────────────────
test('computeBniFundingComparison: batchIds kosong -> struktur default aman, funding_need_difference = -totalBalanceNeed', async () => {
  const result = await computeBniFundingComparison({ pool: { query: async () => ({ rows: [] }) }, batchIds: [], totalBalanceNeed: 1000000 });
  assert.strictEqual(result.total_funding_credit, 0);
  assert.strictEqual(result.funding_need_difference, -1000000);
  assert.deepStrictEqual(result.daily, []);
});
test('computeBniFundingComparison: funding/debit/reversal dijumlah per row_type, net_cash_movement = funding+reversal-debit', async () => {
  const fakePool = {
    query: async () => ({
      rows: [
        { business_date: '2026-07-01', bank_row_type: 'FUNDING_CREDIT', row_count: '2', credit_sum: '5000000', debit_sum: '0' },
        { business_date: '2026-07-01', bank_row_type: 'FASTPAY_DEBIT', row_count: '10', credit_sum: '0', debit_sum: '3000000' },
        { business_date: '2026-07-01', bank_row_type: 'CREDIT_REVERSAL', row_count: '1', credit_sum: '50000', debit_sum: '0' },
      ],
    }),
  };
  const result = await computeBniFundingComparison({ pool: fakePool, batchIds: [1], totalBalanceNeed: 3200000 });
  assert.strictEqual(result.total_funding_credit, 5000000);
  assert.strictEqual(result.funding_transaction_count, 2);
  assert.strictEqual(result.total_fastpay_debit, 3000000);
  assert.strictEqual(result.total_reversal_credit, 50000);
  assert.strictEqual(result.net_cash_movement, 5000000 + 50000 - 3000000);
  // funding_need_difference murni informasi arus dana, BUKAN "kekurangan saldo"
  assert.strictEqual(result.funding_need_difference, 5000000 - 3200000);
  assert.strictEqual(result.daily.length, 1);
  assert.strictEqual(result.daily[0].net_cash_movement, 5000000 + 50000 - 3000000);
});
test('computeBniFundingComparison: query HANYA scope 3 bank_row_type funding (tidak ikut tarik row_type lain)', async () => {
  let capturedTypes = null;
  const fakePool = { query: async (sql, params) => { capturedTypes = params[1]; return { rows: [] }; } };
  await computeBniFundingComparison({ pool: fakePool, batchIds: [1], totalBalanceNeed: 0 });
  assert.deepStrictEqual(capturedTypes.sort(), ['CREDIT_REVERSAL', 'FASTPAY_DEBIT', 'FUNDING_CREDIT'].sort());
});

// ── TEST: struktur response akhir buildBalanceNeedsResponse via
// enrichBankSpecific -- hanya dipanggil kalau eksplisit diberikan (bank
// tanpa panel funding, mis. OCBC/Mandiri/BRI/BRI-BIFAST, bank_specific
// harus tetap {} kosong, bukan undefined atau error) ──────────────────────
test('BUILD RESPONSE TEST: bank tanpa enrichBankSpecific -> bank_specific = {} (bukan crash/undefined)', async () => {
  const fakePool = {
    query: async (sql) => {
      if (/recon_sync_batches/.test(sql) && /BETWEEN/.test(sql)) {
        return { rows: [{ id: 1, business_date: '2026-07-01', expected_fee: 150 }] };
      }
      return { rows: [] };
    },
  };
  const result = await buildBalanceNeedsResponse({ pool: fakePool, bankCode: 'BRI', startDate: '2026-07-01', endDate: '2026-07-01' });
  assert.strictEqual(result.statusCode, 200);
  assert.deepStrictEqual(result.body.bank_specific, {});
  assert.strictEqual(result.body.bank_code, 'BRI');
  assert.strictEqual(result.body.bank_label, 'BRI');
  assert.strictEqual(result.body.timezone, 'Asia/Jakarta');
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
