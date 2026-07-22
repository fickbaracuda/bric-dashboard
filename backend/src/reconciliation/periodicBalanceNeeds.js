/**
 * Kebutuhan Saldo periodik — SHARED service dipakai oleh tab "Kebutuhan
 * Saldo" di SEMUA war-room Rekonsiliasi (OCBC/Mandiri/BRI/BRI BI-FAST/BNI).
 *
 * TIDAK berisi matching logic bank apa pun (spec eksplisit) — murni
 * agregasi READ-ONLY dari recon_sync_batches/recon_results yang SUDAH
 * dihasilkan masing-masing matching engine bank (bniAdapter.js/
 * briAdapter.js/briBifastAdapter.js/mandiriAdapter.js/reconcileTransactions
 * OCBC). Route handler tiap bank (warroom-reconciliation*.js) HANYA
 * mengunci `bank_code` dan memanggil `buildBalanceNeedsResponse()` di sini
 * — TIDAK PERNAH menduplikasi rumus.
 *
 * Riwayat: awalnya implementasi ini HANYA ada utk OCBC
 * (computeOcbcBalanceNeedsPeriodic/dateRangeArray di warroom-reconciliation.js).
 * Fungsi pure di sini adalah ekstraksi PERSIS (byte-for-byte identik utk
 * seluruh field yang sudah ada) dari algoritma itu, generalisasi HANYA
 * menambah field baru (peak_hour_label, average_transaction_value) yang
 * TIDAK ADA di response lama — jadi output OCBC existing tidak berubah,
 * hanya bertambah. warroom-reconciliation.js sekarang delegate ke sini.
 */

// ─────────────────────────────────────────────────────────────────────────
// Allowlist bank — server-side, TIDAK PERNAH menerima bank_code arbitrary
// dari frontend. Default fee per bank direplikasi dari masing-masing
// adapter (DEFAULT_FEE_BIFAST/DEFAULT_FEE_MANDIRI/DEFAULT_FEE_BRI/
// DEFAULT_FEE_BRI_BIFAST/DEFAULT_FEE_BNI) — HANYA dipakai sbg fallback
// kalau batch tsb genuinely tidak punya evidence fee sama sekali, BUKAN
// nilai yang dipaksakan.
// ─────────────────────────────────────────────────────────────────────────
const BANK_LABELS = {
  OCBC: 'OCBC',
  MANDIRI: 'Mandiri',
  BRI: 'BRI',
  BRI_BIFAST: 'BRI BI-FAST',
  BNI: 'BNI',
};
const BANK_ALLOWLIST = Object.keys(BANK_LABELS);

const DEFAULT_FEE_BY_BANK = {
  OCBC: Number(process.env.RECON_OCBC_FEE_DEFAULT) || 25,
  MANDIRI: Number(process.env.RECON_MANDIRI_FEE_DEFAULT) || 100,
  BRI: Number(process.env.RECON_BRI_FEE_DEFAULT) || 150,
  BRI_BIFAST: Number(process.env.RECON_BRI_BIFAST_FEE_DEFAULT) || 77,
  BNI: Number(process.env.RECON_BNI_FEE_DEFAULT) || 0,
};

/**
 * Konvensi cross-date (bank_transaction_date != business_date batch)
 * TIDAK SERAGAM antar bank -- masing-masing `dailyReportHandler`/
 * `analyticsHandler` bank sudah punya aturannya sendiri, jadi shared query
 * di sini WAJIB mengikuti aturan yang SAMA per bank (bukan satu guard
 * dipaksakan ke semua), supaya total di tab "Kebutuhan Saldo" konsisten
 * dgn total di tab lain bank yang sama:
 * - 'strict'   : OCBC & MANDIRI -- baris dgn bank_transaction_date beda
 *                dari business_date DIKECUALIKAN dari SELURUH kalkulasi
 *                (lihat `resultsInDate`/dokumentasi masing2 file).
 * - 'strict_reversal_carveout' : BRI (non-BIFAST) -- sama seperti 'strict',
 *                KECUALI baris dgn `reversal_lookup_source =
 *                'CROSS_DATE_LOOKUP'` (fitur reversal cross-date yang VALID,
 *                lihat `resultsValidDate` di warroom-reconciliation-bri.js).
 * - 'none'     : BRI_BIFAST (by design -- "rolling sheet", TIDAK PERNAH
 *                difilter berdasarkan bank_transaction_date sama sekali,
 *                lihat komentar di warroom-reconciliation-bri-bifast.js)
 *                & BNI (dailyReportHandler/analyticsHandler BNI juga TIDAK
 *                PERNAH mengecualikan baris cross-date dari total) --
 *                seluruh baris FP-linked dihitung apa adanya.
 */
const CROSS_DATE_GUARD_MODE = {
  OCBC: 'strict',
  MANDIRI: 'strict',
  BRI: 'strict_reversal_carveout',
  BRI_BIFAST: 'none',
  BNI: 'none',
};

function isValidBankCode(bankCode) {
  return BANK_ALLOWLIST.includes(bankCode);
}
function bankLabel(bankCode) {
  return BANK_LABELS[bankCode] || bankCode;
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`);
function hourLabel(h) {
  return (Number.isInteger(h) && h >= 0 && h <= 23) ? HOUR_LABELS[h] : null;
}

function safeDivLocal(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/** Identik dgn dateRangeArray() lama di warroom-reconciliation.js (OCBC). */
function dateRangeArray(startStr, endStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) return [];
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const out = [];
  for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Pure aggregation — TIDAK menyentuh DB, dipakai SEMUA bank. Algoritma
 * hourly/summary IDENTIK dgn computeOcbcBalanceNeedsPeriodic() lama (setiap
 * field yang SUDAH ADA sebelumnya menghasilkan nilai yang SAMA persis).
 * Field BARU (tidak mengubah field lama): summary.peak_hour_label,
 * daily[].peak_hour_label, daily[].average_transaction_value.
 *
 * @param {string[]} selectedDates - seluruh tanggal kalender dlm rentang yg diminta user (dari dateRangeArray), TERMASUK yg tidak punya batch
 * @param {{business_date:string, expected_fee:number}[]} includedDayFees - HANYA tanggal yg punya batch bank ini pada rentang ini, + expected fee actual batch itu
 * @param {{business_date:string, hour:number, tx_count:number, principal_sum:number}[]} hourlyRows - hasil query agregasi SQL (GROUP BY business_date, hour); jam yg tidak muncul berarti 0 (diisi otomatis di bawah)
 */
function computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows) {
  const includedDates = includedDayFees.map(d => d.business_date);
  const feeByDate = new Map(includedDayFees.map(d => [d.business_date, d.expected_fee]));
  const missingDates = selectedDates.filter(d => !includedDates.includes(d));

  const coverage = {
    selected_days: selectedDates.length,
    included_days: includedDates.length,
    missing_days: missingDates.length,
    included_dates: includedDates,
    missing_dates: missingDates,
  };

  if (includedDates.length === 0) {
    return { empty: true, coverage, summary: null, hourly: [], daily: [] };
  }

  // matrix[date][hour] -- default 0, ditimpa oleh hourlyRows yang benar2 ada
  // transaksinya. Ini yang menjamin "jam kosong pada included day tetap
  // dihitung 0" (bukan diabaikan/di-skip dari average).
  const matrix = new Map();
  for (const d of includedDates) matrix.set(d, Array.from({ length: 24 }, () => ({ tx_count: 0, principal_sum: 0 })));
  for (const row of hourlyRows) {
    const hours = matrix.get(row.business_date);
    if (!hours) continue; // defense-in-depth: baris di luar includedDates (seharusnya tidak pernah terjadi krn query sudah di-scope batch_id)
    const hour = Number(row.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    hours[hour] = { tx_count: Number(row.tx_count) || 0, principal_sum: Number(row.principal_sum) || 0 };
  }

  const includedDaysCount = includedDates.length;
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    let totalTransaction = 0, totalPrincipal = 0, totalExpectedFee = 0;
    let maxNeed = -Infinity, minNeed = Infinity, peakDate = null;
    for (const d of includedDates) {
      const cell = matrix.get(d)[h];
      const fee = feeByDate.get(d);
      const need = cell.principal_sum + cell.tx_count * fee;
      totalTransaction += cell.tx_count;
      totalPrincipal += cell.principal_sum;
      totalExpectedFee += cell.tx_count * fee;
      if (need > maxNeed) { maxNeed = need; peakDate = d; }
      if (need < minNeed) minNeed = need;
    }
    const totalBalanceNeed = totalPrincipal + totalExpectedFee;
    hourly.push({
      hour: h,
      label: hourLabel(h),
      total_transaction: totalTransaction,
      average_transaction_per_day: safeDivLocal(totalTransaction, includedDaysCount),
      total_principal: totalPrincipal,
      average_principal_per_day: safeDivLocal(totalPrincipal, includedDaysCount),
      total_expected_fee: totalExpectedFee,
      average_fee_per_day: safeDivLocal(totalExpectedFee, includedDaysCount),
      total_balance_need: totalBalanceNeed,
      average_balance_need_per_day: safeDivLocal(totalBalanceNeed, includedDaysCount),
      maximum_daily_need: maxNeed,
      minimum_daily_need: minNeed,
      peak_date: peakDate,
    });
  }

  const daily = includedDates.map(d => {
    const hours = matrix.get(d);
    const fee = feeByDate.get(d);
    let transactionCount = 0, principal = 0, peakHour = 0, peakHourNeed = -Infinity;
    for (let h = 0; h < 24; h++) {
      const cell = hours[h];
      transactionCount += cell.tx_count;
      principal += cell.principal_sum;
      const need = cell.principal_sum + cell.tx_count * fee;
      if (need > peakHourNeed) { peakHourNeed = need; peakHour = h; }
    }
    const expectedFee = transactionCount * fee;
    return {
      business_date: d,
      transaction_count: transactionCount,
      principal,
      expected_fee: expectedFee,
      total_balance_need: principal + expectedFee,
      peak_hour: peakHour,
      peak_hour_label: hourLabel(peakHour),
      peak_hour_need: peakHourNeed,
      average_transaction_value: transactionCount > 0 ? principal / transactionCount : 0,
    };
  }).sort((a, b) => b.business_date.localeCompare(a.business_date)); // tanggal terbaru dulu

  const totalTransaction = hourly.reduce((s, h) => s + h.total_transaction, 0);
  const totalPrincipal = hourly.reduce((s, h) => s + h.total_principal, 0);
  const totalExpectedFee = hourly.reduce((s, h) => s + h.total_expected_fee, 0);
  const totalBalanceNeed = totalPrincipal + totalExpectedFee;

  let peakHourIdx = 0, peakHourAvg = -Infinity;
  for (const h of hourly) {
    const avg = h.average_balance_need_per_day === null ? -Infinity : h.average_balance_need_per_day;
    if (avg > peakHourAvg) { peakHourAvg = avg; peakHourIdx = h.hour; }
  }
  let maxDailyNeed = -Infinity, maxDailyNeedDate = null;
  for (const d of daily) {
    if (d.total_balance_need > maxDailyNeed) { maxDailyNeed = d.total_balance_need; maxDailyNeedDate = d.business_date; }
  }

  return {
    empty: false,
    coverage,
    summary: {
      total_transaction: totalTransaction,
      total_principal: totalPrincipal,
      total_expected_fee: totalExpectedFee,
      total_balance_need: totalBalanceNeed,
      average_transaction_per_day: safeDivLocal(totalTransaction, includedDaysCount),
      average_balance_need_per_day: safeDivLocal(totalBalanceNeed, includedDaysCount),
      peak_hour: peakHourIdx,
      peak_hour_label: hourLabel(peakHourIdx),
      peak_hour_average: peakHourAvg === -Infinity ? null : peakHourAvg,
      maximum_daily_need: maxDailyNeed === -Infinity ? 0 : maxDailyNeed,
      maximum_daily_need_date: maxDailyNeedDate,
    },
    hourly,
    daily,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DB access — batch selection & expected fee resolution
// ─────────────────────────────────────────────────────────────────────────

/**
 * Active batch per business_date: recon_sync_batches punya UNIQUE
 * (business_date, bank_code), jadi TIDAK PERNAH ada 2 batch utk kombinasi
 * itu — resync selalu meng-upsert baris yang SAMA. Filter status='success'
 * memastikan batch yang masih 'pending' (mis. sync sedang berjalan/chunk
 * belum selesai) tidak ikut dihitung sbg included day.
 */
async function getActiveBatchesForPeriod(pool, bankCode, startDate, endDate) {
  const res = await pool.query(
    `SELECT id, business_date::text AS business_date, expected_fee
     FROM recon_sync_batches
     WHERE bank_code = $1 AND business_date BETWEEN $2 AND $3 AND status = 'success'
     ORDER BY business_date`,
    [bankCode, startDate, endDate]
  );
  return res.rows;
}

/**
 * Expected fee per batch/tanggal — TIDAK PERNAH dari frontend, TIDAK PERNAH
 * satu nilai dipaksakan ke seluruh periode kalau batch harian berbeda.
 *
 * OCBC: recon_sync_batches.expected_fee TIDAK PERNAH diisi oleh syncHandler
 * OCBC (desain lama, sengaja TIDAK diubah di refactor ini) -- diturunkan
 * dari recon_results batch itu sendiri (bank_fee - variance_fee, konstan
 * per batch krn 1 config expected_fee berlaku utk seluruh sync 1 hari).
 * SAMA PERSIS dgn implementasi lama, TIDAK diubah sedikit pun.
 *
 * Bank lain (Mandiri/BRI/BRI BI-FAST/BNI): expected_fee SUDAH tersimpan
 * langsung di kolom batch (diisi saat sync oleh masing-masing adapter),
 * dipakai apa adanya.
 *
 * Fallback (kedua jalur): default fee bank tsb (DEFAULT_FEE_BY_BANK) HANYA
 * kalau batch itu genuinely tidak punya evidence fee sama sekali.
 */
async function resolveExpectedFeePerBatch(pool, bankCode, batches) {
  const defaultFee = DEFAULT_FEE_BY_BANK[bankCode] ?? 0;
  const result = new Map();

  if (bankCode === 'OCBC') {
    const batchIds = batches.map(b => b.id);
    let feeByBatchId = new Map();
    if (batchIds.length) {
      const feeRes = await pool.query(
        `SELECT batch_id, MIN(bank_fee - variance_fee) AS derived_fee
         FROM recon_results
         WHERE batch_id = ANY($1::bigint[]) AND variance_fee IS NOT NULL AND bank_fee IS NOT NULL
         GROUP BY batch_id`,
        [batchIds]
      );
      feeByBatchId = new Map(feeRes.rows.map(r => [Number(r.batch_id), Number(r.derived_fee)]));
    }
    for (const b of batches) {
      result.set(b.business_date, feeByBatchId.has(Number(b.id)) ? feeByBatchId.get(Number(b.id)) : defaultFee);
    }
    return result;
  }

  for (const b of batches) {
    const fee = (b.expected_fee !== null && b.expected_fee !== undefined) ? Number(b.expected_fee) : NaN;
    result.set(b.business_date, Number.isFinite(fee) ? fee : defaultFee);
  }
  return result;
}

/**
 * Transaksi FP canonical per (business_date, hour) — SATU query agregasi
 * (bukan 24 query per jam), dipakai SEMUA bank. Scoping HANYA via
 * `batch_id = ANY($1)` (batch_id sudah dijamin unik per bank+tanggal lewat
 * recon_sync_batches) -- SENGAJA TIDAK memfilter r.bank_code, krn kolom itu
 * TIDAK PERNAH diisi utk baris OCBC lama (desain historis OCBC mendahului
 * penambahan kolom bank_code) -- memfilternya akan membuat OCBC diam-diam
 * mengembalikan 0 baris. Bank lain juga aman tanpa filter ini krn batch_id
 * sudah cukup men-scope.
 *
 * Transaksi yang dihitung: SEMUA baris recon_results dgn id_transaksi
 * TERISI (FP canonical -- BANK_ONLY/REVERSAL-tanpa-FP/FUNDING_CREDIT TIDAK
 * PERNAH punya id_transaksi, otomatis terkecuali), REGARDLESS status
 * (termasuk PENDING_BANK/FP_ONLY/NOMINAL_MISMATCH/FEE_MISMATCH/
 * DUPLICATE_BANK/REVERSAL/NEED_REVIEW/DUPLICATE_FP -- kebutuhan saldo
 * timbul begitu FP diproses, bukan setelah matched). Dedup canonical
 * (DISTINCT ON) menjamin DUPLICATE_FP/hasil ganda apa pun hanya dihitung
 * SATU KALI (recon_results sendiri sudah 1 baris per id_transaksi per
 * desain engine, DISTINCT ON di sini jaminan berlapis tambahan).
 */
async function getHourlyTransactionRows(pool, batchIds, bankCode) {
  if (!batchIds.length) return [];
  const guardMode = CROSS_DATE_GUARD_MODE[bankCode] || 'strict';
  let crossDateClause = '';
  if (guardMode === 'strict') {
    crossDateClause = "AND (r.bank_transaction_date IS NULL OR r.bank_transaction_date::text = b.business_date::text)";
  } else if (guardMode === 'strict_reversal_carveout') {
    crossDateClause = "AND (r.bank_transaction_date IS NULL OR r.bank_transaction_date::text = b.business_date::text OR r.reversal_lookup_source = 'CROSS_DATE_LOOKUP')";
  } // 'none' -> crossDateClause tetap kosong, seluruh baris FP-linked dihitung apa adanya (BRI_BIFAST/BNI, sama dgn dailyReportHandler masing2)
  const res = await pool.query(
    `WITH deduped AS (
       SELECT DISTINCT ON (r.batch_id, COALESCE(r.canonical_transaction_key, r.id_transaksi, '__id_' || r.id::text))
         r.batch_id, r.fp_nominal, r.fp_time_response
       FROM recon_results r
       JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE r.batch_id = ANY($1::bigint[])
         AND r.id_transaksi IS NOT NULL
         AND r.fp_time_response IS NOT NULL
         ${crossDateClause}
       ORDER BY r.batch_id, COALESCE(r.canonical_transaction_key, r.id_transaksi, '__id_' || r.id::text), r.updated_at DESC
     )
     SELECT batch_id, EXTRACT(HOUR FROM (fp_time_response AT TIME ZONE 'Asia/Jakarta'))::int AS hour,
       COUNT(*) AS tx_count, COALESCE(SUM(fp_nominal), 0) AS principal_sum
     FROM deduped
     GROUP BY batch_id, hour`,
    [batchIds]
  );
  return res.rows;
}

/**
 * BNI-only enrichment (opsional, spec eksplisit: "Panel ini hanya utk BNI,
 * jangan dipaksakan muncul pada bank lain"). funding_credit/fastpay_debit/
 * reversal_credit dihitung dari recon_bank_transactions.bank_row_type
 * (klasifikasi backend bniAdapter.js, TIDAK diulang di sini) utk batch yang
 * SAMA dgn periode kebutuhan saldo. net_cash_movement & funding_need_difference
 * MURNI informasi arus dana -- BUKAN saldo rekening aktual (tidak ada
 * opening balance di sumber data).
 */
async function computeBniFundingComparison({ pool, batchIds, totalBalanceNeed }) {
  const empty = {
    total_funding_credit: 0, funding_transaction_count: 0, total_fastpay_debit: 0,
    total_reversal_credit: 0, net_cash_movement: 0, funding_need_difference: -(Number(totalBalanceNeed) || 0),
    daily: [],
  };
  if (!batchIds.length) return empty;

  // GROUP BY business_date (via join batch) SEKALIGUS bank_row_type -- SATU
  // query, dipakai utk total period DAN breakdown per tanggal (grafik "Kebutuhan
  // Saldo per Tanggal" & kolom funding opsional di tabel per tanggal, spec
  // eksplisit "boleh ditambahkan" utk BNI).
  const res = await pool.query(
    `SELECT b.business_date::text AS business_date, bt.bank_row_type,
       COUNT(*) AS row_count,
       COALESCE(SUM(bt.credit), 0) AS credit_sum,
       COALESCE(SUM(bt.debit), 0) AS debit_sum
     FROM recon_bank_transactions bt
     JOIN recon_sync_batches b ON b.id = bt.batch_id
     WHERE bt.batch_id = ANY($1::bigint[]) AND bt.bank_row_type = ANY($2::text[])
     GROUP BY b.business_date, bt.bank_row_type`,
    [batchIds, ['FUNDING_CREDIT', 'FASTPAY_DEBIT', 'CREDIT_REVERSAL']]
  );

  let fundingCredit = 0, fundingCount = 0, fastpayDebit = 0, reversalCredit = 0;
  const dailyMap = new Map();
  for (const row of res.rows) {
    const date = row.business_date;
    if (!dailyMap.has(date)) dailyMap.set(date, { business_date: date, funding_credit: 0, fastpay_debit: 0, reversal_credit: 0 });
    const bucket = dailyMap.get(date);
    if (row.bank_row_type === 'FUNDING_CREDIT') {
      fundingCredit += Number(row.credit_sum); fundingCount += Number(row.row_count);
      bucket.funding_credit += Number(row.credit_sum);
    } else if (row.bank_row_type === 'FASTPAY_DEBIT') {
      fastpayDebit += Number(row.debit_sum);
      bucket.fastpay_debit += Number(row.debit_sum);
    } else if (row.bank_row_type === 'CREDIT_REVERSAL') {
      reversalCredit += Number(row.credit_sum);
      bucket.reversal_credit += Number(row.credit_sum);
    }
  }
  const daily = [...dailyMap.values()]
    .map(d => ({ ...d, net_cash_movement: d.funding_credit + d.reversal_credit - d.fastpay_debit }))
    .sort((a, b) => a.business_date.localeCompare(b.business_date));

  const netCashMovement = fundingCredit + reversalCredit - fastpayDebit;
  return {
    total_funding_credit: fundingCredit,
    funding_transaction_count: fundingCount,
    total_fastpay_debit: fastpayDebit,
    total_reversal_credit: reversalCredit,
    net_cash_movement: netCashMovement,
    funding_need_difference: fundingCredit - (Number(totalBalanceNeed) || 0),
    daily,
  };
}

/**
 * Orkestrasi penuh — dipanggil route handler tiap bank (hanya mengunci
 * bank_code). Return `{ statusCode, body }` supaya handler tinggal
 * `res.status(statusCode).json(body)`, konsisten di semua route.
 */
async function buildBalanceNeedsResponse({ pool, bankCode, startDate, endDate, enrichBankSpecific }) {
  const generatedAt = new Date().toISOString();

  if (!isValidBankCode(bankCode)) {
    return { statusCode: 400, body: { error: `bank_code tidak valid. Gunakan salah satu: ${BANK_ALLOWLIST.join(', ')}` } };
  }
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { statusCode: 400, body: { error: 'start_date & end_date wajib diisi, format YYYY-MM-DD' } };
  }
  const selectedDates = dateRangeArray(startDate, endDate);
  if (selectedDates.length === 0) {
    return { statusCode: 400, body: { error: 'end_date harus sama atau setelah start_date' } };
  }
  if (selectedDates.length > 90) {
    return { statusCode: 400, body: { error: 'Rentang tanggal maksimal 90 hari' } };
  }

  const batches = await getActiveBatchesForPeriod(pool, bankCode, startDate, endDate);

  if (batches.length === 0) {
    const result = computePeriodicBalanceNeeds(selectedDates, [], []);
    return {
      statusCode: 200,
      body: {
        success: true, empty: true, bank_code: bankCode, bank_label: bankLabel(bankCode),
        start_date: startDate, end_date: endDate, timezone: 'Asia/Jakarta', generated_at: generatedAt,
        coverage: result.coverage, summary: null, hourly: [], daily: [], bank_specific: {},
        message: `Belum ada batch Rekonsiliasi ${bankLabel(bankCode)} pada periode ini.`,
      },
    };
  }

  const batchIds = batches.map(b => b.id);
  const batchDateById = new Map(batches.map(b => [Number(b.id), b.business_date]));

  const [feeByDate, hourlyRowsRaw] = await Promise.all([
    resolveExpectedFeePerBatch(pool, bankCode, batches),
    getHourlyTransactionRows(pool, batchIds, bankCode),
  ]);

  const includedDayFees = batches.map(b => ({
    business_date: b.business_date,
    expected_fee: feeByDate.has(b.business_date) ? feeByDate.get(b.business_date) : (DEFAULT_FEE_BY_BANK[bankCode] ?? 0),
  }));
  const hourlyRows = hourlyRowsRaw
    .map(r => ({ business_date: batchDateById.get(Number(r.batch_id)), hour: Number(r.hour), tx_count: Number(r.tx_count), principal_sum: Number(r.principal_sum) }))
    .filter(r => r.business_date);

  const result = computePeriodicBalanceNeeds(selectedDates, includedDayFees, hourlyRows);

  let bankSpecific = {};
  if (typeof enrichBankSpecific === 'function') {
    bankSpecific = (await enrichBankSpecific({ pool, batchIds, totalBalanceNeed: result.summary ? result.summary.total_balance_need : 0 })) || {};
  }

  return {
    statusCode: 200,
    body: {
      success: true, empty: result.empty, bank_code: bankCode, bank_label: bankLabel(bankCode),
      start_date: startDate, end_date: endDate, timezone: 'Asia/Jakarta', generated_at: generatedAt,
      coverage: result.coverage, summary: result.summary, hourly: result.hourly, daily: result.daily,
      bank_specific: bankSpecific,
    },
  };
}

module.exports = {
  BANK_ALLOWLIST,
  BANK_LABELS,
  DEFAULT_FEE_BY_BANK,
  CROSS_DATE_GUARD_MODE,
  isValidBankCode,
  bankLabel,
  hourLabel,
  dateRangeArray,
  computePeriodicBalanceNeeds,
  getActiveBatchesForPeriod,
  resolveExpectedFeePerBatch,
  getHourlyTransactionRows,
  computeBniFundingComparison,
  buildBalanceNeedsResponse,
};
