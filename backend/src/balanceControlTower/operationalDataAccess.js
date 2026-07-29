'use strict';

/**
 * Balance Control Tower — data access utk mesin kalkulasi operasional.
 * Mengumpulkan input dari DB (policy, posisi saldo terverifikasi, outflow
 * matched) lalu memanggil calculationEngine.buildOperationalCalculation
 * (PURE). SATU tempat ini yang dipanggil route/alert engine — tidak ada
 * konsumen lain yang query recon_results/bankPosition sendiri-sendiri.
 *
 * REUSE eksplisit:
 *   - Posisi saldo: backend/src/reconciliation/bankPosition (sudah ada,
 *     TIDAK diquery ulang di sini dgn cara lain).
 *   - Outflow matched: recon_results (SUDAH difilter/diverifikasi oleh
 *     reconcileTransactions() di warroom-reconciliation.js) -- kolom
 *     bank_principal/bank_fee dipakai APA ADANYA, grouping/fee-verification
 *     TIDAK diulang di sini.
 */

const { getLatestVerifiedBankPosition, isSupportedBank } = require('../reconciliation/bankPosition');
const { buildOperationalCalculation, STANDARD_WINDOWS_MINUTES } = require('./calculationEngine');

const MAX_WINDOW_MINUTES = Math.max(...STANDARD_WINDOWS_MINUTES);

/**
 * Baris outflow matched (recon_results, status SUDAH diverifikasi oleh
 * engine rekonsiliasi) dalam MAX_WINDOW_MINUTES terakhir. `fp_time_response`
 * dipakai sbg anchor waktu (kapan transaksi diproses -- bukan tanggal
 * posting bank yang cuma presisi harian di recon_results.bank_transaction_date).
 *
 * recon_status yang diikutkan (SESUAI spec section 9B — "do not include
 * bank-only anomalies, reversals, credits, pending FP, duplicated rows,
 * failed FP, unknown transactions"):
 *   MATCHED / MATCHED_NO_FEE  -> principal + fee penuh, sudah 100% cocok.
 *   FEE_MISMATCH              -> principal TETAP dihitung (dana riil keluar
 *                                utk settlement), fee TIDAK dihitung (belum
 *                                terverifikasi cocok, jangan dianggap "fee
 *                                terverifikasi").
 */
async function fetchRecentMatchedOutflows({ pool, bankCode, now, since }) {
  const rangeSince = since || new Date(now.getTime() - MAX_WINDOW_MINUTES * 60000);
  const r = await pool.query(
    `SELECT r.bank_principal, r.bank_fee, r.fp_time_response, r.recon_status
     FROM recon_results r
     JOIN recon_sync_batches b ON b.id = r.batch_id
     WHERE b.bank_code = $1
       AND r.fp_time_response IS NOT NULL
       AND r.fp_time_response >= $2 AND r.fp_time_response <= $3
       AND r.recon_status IN ('MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH')`,
    [bankCode, rangeSince, now]
  );
  return r.rows.map(row => ({
    principal: Number(row.bank_principal) || 0,
    fee: row.recon_status === 'FEE_MISMATCH' ? 0 : (Number(row.bank_fee) || 0),
    matchedAt: row.fp_time_response,
  }));
}

/**
 * "Penggunaan Saldo Hari Ini" -- breakdown outflow TERVERIFIKASI utk
 * business_date posisi saat ini, TERPISAH dari window 60-menit di atas
 * (window itu utk burn rate real-time, ini utk ringkasan harian). TIDAK
 * bergantung pada burn_window_minutes sama sekali -- selalu dihitung kalau
 * posisi ada, spec section 8 ("must work independently of top-up policy
 * configuration"). total_bank_debit_today dipakai APA ADANYA dari statement
 * bank (position.total_debit_amount) -- BUKAN dijumlah dari recon_results,
 * supaya tetap benar walau ada baris recon yang belum sempat matched.
 * unmatched_or_anomaly_debit_today = residual (total bank debit dikurangi
 * yang SUDAH terverifikasi matched) -- kalau residual negatif (matched >
 * total, indikasi data belum konsisten), TIDAK di-clamp, dikirim apa adanya
 * + data_quality_flag supaya kelihatan, bukan disembunyikan jadi 0.
 */
async function fetchTodayMatchedOutflowSummary({ pool, bankCode, businessDate, now }) {
  if (!businessDate) return null;
  // Awal business_date di zona Asia/Jakarta (UTC+7, tidak ada DST) -> UTC.
  const startOfDayJakarta = new Date(`${businessDate}T00:00:00+07:00`);
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN r.recon_status IN ('MATCHED','MATCHED_NO_FEE','FEE_MISMATCH') THEN r.bank_principal ELSE 0 END), 0) AS matched_principal,
       COALESCE(SUM(CASE WHEN r.recon_status IN ('MATCHED','MATCHED_NO_FEE') THEN r.bank_fee ELSE 0 END), 0) AS verified_fee,
       COUNT(*) FILTER (WHERE r.recon_status IN ('MATCHED','MATCHED_NO_FEE','FEE_MISMATCH')) AS matched_transaction_count
     FROM recon_results r
     JOIN recon_sync_batches b ON b.id = r.batch_id
     WHERE b.bank_code = $1
       AND r.fp_time_response IS NOT NULL
       AND r.fp_time_response >= $2 AND r.fp_time_response <= $3
       AND r.recon_status IN ('MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH')`,
    [bankCode, startOfDayJakarta, now]
  );
  const row = r.rows[0] || {};
  const matchedPrincipal = Number(row.matched_principal) || 0;
  const verifiedFee = Number(row.verified_fee) || 0;
  return {
    business_date: businessDate,
    matched_principal_outflow_today: round2(matchedPrincipal),
    verified_fee_outflow_today: round2(verifiedFee),
    other_verified_operational_outflow_today: 0,
    matched_transaction_count_today: Number(row.matched_transaction_count) || 0,
    total_bank_debit_today: null, // diisi caller dari position.total_debit_amount (sumber statement bank, bukan hasil agregasi di sini)
    unmatched_or_anomaly_debit_today: null, // diisi caller setelah total_bank_debit_today diketahui (residual)
  };
}
function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? n : Math.round(n * 100) / 100;
}

/**
 * Freshness posisi saldo -- REUSE ambang stale_after_minutes yang SUDAH
 * ada di policy (dipakai jg oleh classifyBankStatus lama utk snapshot),
 * BUKAN field baru duplikat.
 */
function computeFreshness({ position, policy, now }) {
  if (!position || !position.synced_at) return 'UNAVAILABLE';
  const staleLimit = policy && policy.stale_after_minutes !== null && policy.stale_after_minutes !== undefined
    ? Number(policy.stale_after_minutes) : null;
  if (staleLimit === null) return 'FRESH'; // belum dikonfigurasi -> tidak diblokir stale, tapi CONFIGURATION_REQUIRED tetap muncul dari field lain yg kosong
  const ageMinutes = (now.getTime() - new Date(position.synced_at).getTime()) / 60000;
  return ageMinutes > staleLimit ? 'STALE' : 'FRESH';
}

/**
 * Entry point utama -- dipanggil route (summary/detail) & alert engine.
 * null kalau bank tidak didukung adapter rekonsiliasi (fallback ke cascade
 * manual-policy lama di balanceControlTower.js, TIDAK dipaksa pakai mesin ini).
 */
async function computeOperationalCalculationForBank({ pool, bank, policy, STATUS, now = new Date() }) {
  if (!isSupportedBank(bank.bank_code)) return null;

  const positionResult = await getLatestVerifiedBankPosition({ pool, bankCode: bank.bank_code, bankAccountId: bank.id });
  const position = positionResult.available ? positionResult.position : null;
  const freshness = computeFreshness({ position, policy, now });

  let outflowRows = [];
  if (position && freshness !== 'UNAVAILABLE') {
    try {
      outflowRows = await fetchRecentMatchedOutflows({ pool, bankCode: bank.bank_code, now });
    } catch (e) {
      console.error(`fetchRecentMatchedOutflows(${bank.bank_code}) error:`, e.message);
    }
  }

  // "Penggunaan Saldo Hari Ini" -- independen dari burn_window_minutes,
  // selalu dicoba kalau posisi ada (spec section 8).
  let todayUsage = null;
  if (position && position.business_date) {
    try {
      todayUsage = await fetchTodayMatchedOutflowSummary({ pool, bankCode: bank.bank_code, businessDate: position.business_date, now });
      if (todayUsage) {
        const totalBankDebitToday = position.total_debit_amount !== null && position.total_debit_amount !== undefined
          ? Number(position.total_debit_amount) : null;
        todayUsage.total_bank_debit_today = totalBankDebitToday;
        todayUsage.unmatched_or_anomaly_debit_today = totalBankDebitToday !== null
          ? round2(totalBankDebitToday - todayUsage.matched_principal_outflow_today - todayUsage.verified_fee_outflow_today)
          : null;
      }
    } catch (e) {
      console.error(`fetchTodayMatchedOutflowSummary(${bank.bank_code}) error:`, e.message);
    }
  }

  return buildOperationalCalculation({ STATUS, bank, policy, position, freshness, outflowRows, todayUsage, now });
}

module.exports = {
  fetchRecentMatchedOutflows,
  fetchTodayMatchedOutflowSummary,
  computeFreshness,
  computeOperationalCalculationForBank,
};
