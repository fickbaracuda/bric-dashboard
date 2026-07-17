/**
 * Rekonsiliasi BRI BI-FAST — War Room Rekonsiliasi > Rekonsiliasi BRI BI-FAST
 *
 * MODUL BARU, TERPISAH dari Rekonsiliasi BRI existing (warroom-reconciliation-bri.js)
 * — TIDAK mengubah/menggunakan route atau adapter BRI existing sama sekali.
 *
 * Sumber: 2 sheet Google Sheet ("Data FP", "Data Bank BRI BI Fast") —
 * spreadsheet ID dari Script Property BRI_BIFAST_SPREADSHEET_ID (fallback
 * getActiveSpreadsheet()), TIDAK di-hardcode di sini maupun di Apps Script.
 *
 * Bagian dari "Reconciliation Core Engine" bersama OCBC/Mandiri/BRI — REUSE
 * tabel recon_sync_batches/recon_fp_transactions/recon_bank_transactions/
 * recon_results/recon_action_logs (bank_code = 'BRI_BIFAST'), REUSE helper
 * dasar dari warroom-reconciliation.js. Logic ekstraksi+klasifikasi+matching
 * KHUSUS BRI BI-FAST ada di backend/src/reconciliation/briBifastAdapter.js
 * (reconcileBriBifastTransactions, dkk, pure function, di-unit-test di
 * backend/scripts/test-reconciliation-bri-bifast.js).
 *
 * Beda mendasar dari BRI existing: 1 transfer BI-FAST = 2 baris debit
 * TERPISAH (principal + fee Rp77, BUKAN gross digabung 1 baris), matching
 * key = DATA FP.bill_info1 == beneficiary_account (hasil ekstraksi pola
 * "BFST<digits>"), BUKAN id_transaksi. scope_mode default FULL_BUSINESS_DATE
 * (tidak ada konsep coverage-window sprt BRI/Mandiri).
 */

const pool = require('../db');
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
  todayJakarta,
} = require('./warroom-reconciliation');
const {
  isBriBifastFpCandidate, classifyBriBifastRow, parseBriBifastTransactionTime, formatDateJakartaBriBifast,
  computeBriBifastGroupKey, reconcileBriBifastTransactions, applyBriBifastReversalCrossDateLookup,
  validateBriBifastBalance, buildBriBifastFingerprint,
  DEFAULT_FEE_BRI_BIFAST, DEFAULT_GRACE_MINUTES, DEFAULT_BANK_POSTING_BEFORE_FP_TOLERANCE_MINUTES,
  DEFAULT_BANK_POSTING_AFTER_FP_TOLERANCE_MINUTES, DEFAULT_MISMATCH_TIME_TOLERANCE_MINUTES, DEFAULT_REVERSAL_LOOKUP_DAYS,
} = require('../reconciliation/briBifastAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dgn war-room lain, bukan token baru
const BANK_CODE = 'BRI_BIFAST';
const DEFAULT_ACCOUNT_NO = '36001999999306';

// Threshold health status terpusat (spec: "Threshold wajib terpusat").
const BRI_BIFAST_HEALTH_THRESHOLDS = {
  GREEN_MIN_MATCH_RATE: 0.99,
  YELLOW_MIN_MATCH_RATE: 0.95,
  ACCOUNT_CONFLICT_MATERIAL_COUNT: 5,
  DUPLICATE_BANK_TRACE_MATERIAL_COUNT: 5,
  IMPOSSIBLE_TIME_ORDER_MATERIAL_COUNT: 5,
  UNBALANCED_MATERIAL_COUNT: 5,
  EXTRACTION_MEDIUM_MATERIAL_RATIO: 0.10,
};

function fmtNumId(n) { return Number(n || 0).toLocaleString('id-ID'); }
function fmtRpId(n) { return `Rp ${Math.round(Number(n || 0)).toLocaleString('id-ID')}`; }
const INDO_MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function formatWibLong(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const monthName = INDO_MONTHS[Number(parts.month) - 1] || parts.month;
  return `${Number(parts.day)} ${monthName} ${parts.year} pukul ${parts.hour}:${parts.minute} WIB`;
}
function joinWithDan(items) {
  const arr = (items || []).filter(Boolean);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} dan ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, dan ${arr[arr.length - 1]}`;
}

/** Dedupe hasil berdasarkan canonical_transaction_key — pertahanan tambahan di luar UNIQUE index DB. */
function dedupeBriBifastResultsByCanonicalKey(results) {
  const map = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key || `__row_${r.id}`;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()];
}

const CONSUMED_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'REVERSAL', 'DUPLICATE_BANK'];

/**
 * Quality checks berbasis `recon_results` (SEBELUM dedupe) — invalid
 * business date, duplicate canonical, consumed-juga-bank-only,
 * impossible time order. account_conflict/duplicate_bank_trace/
 * unbalanced/orphan_fee_group dihitung terpisah dari recon_bank_transactions
 * mentah (lihat analyticsHandler/dailyReportHandler).
 */
function computeBriBifastResultQualityChecks(results, businessDate) {
  const invalidBusinessDateCount = results.filter(r =>
    r.bank_transaction_date !== null && r.bank_transaction_date !== businessDate &&
    r.reversal_lookup_source !== 'CROSS_DATE_TRACE'
  ).length;

  const canonicalGroups = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key;
    if (!key) continue;
    if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
    canonicalGroups.get(key).push(r);
  }
  let duplicateCanonicalResultCount = 0;
  let consumedAlsoBankOnlyCount = 0;
  for (const rows of canonicalGroups.values()) {
    if (rows.length <= 1) continue;
    duplicateCanonicalResultCount += rows.length - 1;
    const statuses = rows.map(r => r.recon_status);
    if (statuses.includes('BANK_ONLY') && statuses.some(s => CONSUMED_STATUSES.includes(s))) consumedAlsoBankOnlyCount++;
  }

  const impossibleTimeOrderCount = results.filter(r => r.time_order_status === 'IMPOSSIBLE_ORDER').length;

  return {
    invalid_business_date_count: invalidBusinessDateCount,
    duplicate_canonical_result_count: duplicateCanonicalResultCount,
    consumed_also_bank_only_count: consumedAlsoBankOnlyCount,
    impossible_time_order_count: impossibleTimeOrderCount,
  };
}

/**
 * Actionable Exception — dihitung BACKEND. Hanya 9 EXCEPTION_STATUSES,
 * dedupe by canonical key. Tidak menghitung MATCHED/MATCHED_NO_FEE/
 * OUT_OF_SCOPE bank row/raw row tanpa hasil/data tanggal lain/duplicate
 * canonical row (dedupe sudah dilakukan pemanggil sebelum fungsi ini).
 */
function computeBriBifastActionableException(results) {
  const rows = results.filter(r => EXCEPTION_STATUSES.includes(r.recon_status));
  const nominal = rows.reduce((s, r) => s + Number(r.fp_nominal !== null ? r.fp_nominal : (r.bank_total_debit || 0)), 0);
  return { count: rows.length, nominal };
}

/** Health Status BRI BI-FAST — threshold terpusat, RED dievaluasi dulu, lalu YELLOW, fallback GREEN. */
function computeBriBifastHealthStatus({
  validMatchRateTransaction, actionableExceptionCount, syncStatus,
  invalidBusinessDateCount, duplicateCanonicalResultCount, consumedAlsoBankOnlyCount,
  accountConflictCount, duplicateBankTraceCount, impossibleTimeOrderCount, unbalancedBankRowCount,
  extractionMediumRatio, hasPostingDelay,
}) {
  const T = BRI_BIFAST_HEALTH_THRESHOLDS;
  const syncFailed = syncStatus !== 'success';
  const rate = validMatchRateTransaction;

  if (
    syncFailed ||
    (rate !== null && rate < T.YELLOW_MIN_MATCH_RATE) ||
    invalidBusinessDateCount > 0 ||
    duplicateCanonicalResultCount > 0 ||
    consumedAlsoBankOnlyCount > 0 ||
    accountConflictCount >= T.ACCOUNT_CONFLICT_MATERIAL_COUNT ||
    duplicateBankTraceCount >= T.DUPLICATE_BANK_TRACE_MATERIAL_COUNT ||
    impossibleTimeOrderCount >= T.IMPOSSIBLE_TIME_ORDER_MATERIAL_COUNT ||
    unbalancedBankRowCount >= T.UNBALANCED_MATERIAL_COUNT
  ) {
    return 'RED';
  }

  if (
    (rate !== null && rate < T.GREEN_MIN_MATCH_RATE) ||
    actionableExceptionCount > 0 ||
    hasPostingDelay ||
    accountConflictCount > 0 ||
    duplicateBankTraceCount > 0 ||
    impossibleTimeOrderCount > 0 ||
    unbalancedBankRowCount > 0 ||
    (extractionMediumRatio !== null && extractionMediumRatio > T.EXTRACTION_MEDIUM_MATERIAL_RATIO)
  ) {
    return 'YELLOW';
  }

  return 'GREEN';
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bri-bifast/sync
// ─────────────────────────────────────────────────────────────────────────
async function syncHandler(req, res) {
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const businessDate = nullIfEmpty(body.business_date);
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return res.status(400).json({ error: 'business_date wajib diisi, format YYYY-MM-DD' });
  }
  const chunkIndex = Number.isFinite(Number(body.chunk_index)) ? Number(body.chunk_index) : 0;
  const chunkTotal = (Number.isFinite(Number(body.chunk_total)) && Number(body.chunk_total) > 0) ? Number(body.chunk_total) : 1;
  const isFirstChunk = chunkIndex === 0;
  const isLastChunk = chunkIndex >= chunkTotal - 1;

  const fpRowsRaw = Array.isArray(body.fp) ? body.fp : [];
  const bankRowsRaw = Array.isArray(body.bank) ? body.bank : [];

  const scopeMode = body.config?.scope_mode === 'FP_COVERAGE_WINDOW' ? 'FP_COVERAGE_WINDOW' : 'FULL_BUSINESS_DATE';
  const expectedFee = Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : DEFAULT_FEE_BRI_BIFAST;
  const graceMinutes = Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : DEFAULT_GRACE_MINUTES;
  const bankPostingBeforeFpToleranceMinutes = Number.isFinite(Number(body.config?.bank_posting_before_fp_tolerance_minutes))
    ? Number(body.config.bank_posting_before_fp_tolerance_minutes) : DEFAULT_BANK_POSTING_BEFORE_FP_TOLERANCE_MINUTES;
  const bankPostingAfterFpToleranceMinutes = Number.isFinite(Number(body.config?.bank_posting_after_fp_tolerance_minutes))
    ? Number(body.config.bank_posting_after_fp_tolerance_minutes) : DEFAULT_BANK_POSTING_AFTER_FP_TOLERANCE_MINUTES;
  const mismatchTimeToleranceMinutes = Number.isFinite(Number(body.config?.mismatch_time_tolerance_minutes))
    ? Number(body.config.mismatch_time_tolerance_minutes) : DEFAULT_MISMATCH_TIME_TOLERANCE_MINUTES;
  const reversalLookupDays = Number.isFinite(Number(body.config?.reversal_lookup_days)) ? Number(body.config.reversal_lookup_days) : DEFAULT_REVERSAL_LOOKUP_DAYS;
  const accountNo = nullIfEmpty(body.account_no) || DEFAULT_ACCOUNT_NO;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${BANK_CODE}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches
         (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name,
          account_no, scope_mode, expected_fee, grace_period_minutes,
          bank_posting_before_fp_tolerance_minutes, bank_posting_after_fp_tolerance_minutes,
          mismatch_time_tolerance_minutes, reversal_lookup_days,
          fp_row_count, bank_row_count, synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,0,NOW(),$15,'pending',$16)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = EXCLUDED.account_no, scope_mode = EXCLUDED.scope_mode,
         expected_fee = EXCLUDED.expected_fee, grace_period_minutes = EXCLUDED.grace_period_minutes,
         bank_posting_before_fp_tolerance_minutes = EXCLUDED.bank_posting_before_fp_tolerance_minutes,
         bank_posting_after_fp_tolerance_minutes = EXCLUDED.bank_posting_after_fp_tolerance_minutes,
         mismatch_time_tolerance_minutes = EXCLUDED.mismatch_time_tolerance_minutes,
         reversal_lookup_days = EXCLUDED.reversal_lookup_days,
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $16::jsonb <> '{}'::jsonb THEN $16::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, BANK_CODE, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'Data FP', nullIfEmpty(body.bank_sheet_name) || 'Data Bank BRI BI Fast',
        accountNo, scopeMode, expectedFee, graceMinutes,
        bankPostingBeforeFpToleranceMinutes, bankPostingAfterFpToleranceMinutes, mismatchTimeToleranceMinutes, reversalLookupDays,
        nullIfEmpty(body.meta?.synced_by) || 'apps_script',
        JSON.stringify(body.raw_summary || {}),
      ]
    );
    const batchId = batchRes.rows[0].id;

    // Chunk pertama -> fresh start (jamin resync tidak menggandakan row).
    if (isFirstChunk) {
      await client.query('DELETE FROM recon_fp_transactions WHERE batch_id = $1', [batchId]);
      await client.query('DELETE FROM recon_bank_transactions WHERE batch_id = $1', [batchId]);
    }

    let fpInserted = 0, fpSkippedInvalid = 0;
    for (const row of fpRowsRaw) {
      const idTransaksi = nullIfEmpty(row.id_transaksi);
      if (!idTransaksi) continue;
      if (!isValidIdTransaksi(idTransaksi)) { fpSkippedInvalid++; continue; }
      // bill_info1 WAJIB string murni (leading zero dipertahankan) — TIDAK
      // PERNAH Number(). nullIfEmpty() sudah aman (String(v).trim()).
      await client.query(
        `INSERT INTO recon_fp_transactions (batch_id, id_transaksi, bill_info1, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          batchId, idTransaksi, nullIfEmpty(row.bill_info1), cleanNum(row.nominal), nullIfEmpty(row.id_produk),
          parseBriBifastTransactionTime({ tglTran: row.time_response }).transactionDateTime || null,
          nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }
    if (fpSkippedInvalid > 0) {
      console.warn(`reconciliation-bri-bifast sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) utk business_date ${businessDate}`);
    }

    let bankInserted = 0, bankSkippedDuplicateFingerprint = 0;
    // Guard tanggal-masa-depan (fixBriBifastFutureDateSwap) dievaluasi thd
    // SATU `now` yang sama utk seluruh baris batch ini (bukan new Date() per
    // baris) -- supaya konsisten & deterministik dalam 1 kali sync.
    const parseNow = new Date();
    let dateSwapCorrected = 0, dateSwapUncorrectable = 0;
    for (const row of bankRowsRaw) {
      const deskTran = nullIfEmpty(row.desk_tran);
      const trremk = nullIfEmpty(row.trremk);
      const tlbds1 = nullIfEmpty(row.tlbds1);
      const tlbds2 = nullIfEmpty(row.tlbds2);
      const mutasiDebet = cleanNum(row.mutasi_debet);
      const mutasiKredit = cleanNum(row.mutasi_kredit);
      const saldoAwal = cleanNum(row.saldo_awal_mutasi);
      const saldoAkhir = cleanNum(row.saldo_akhir_mutasi);
      const norek = nullIfEmpty(row.norek) || accountNo;
      const seq = nullIfEmpty(row.seq);

      const classification = classifyBriBifastRow({ deskTran, trremk, mutasiDebet, mutasiKredit });
      const time = parseBriBifastTransactionTime({ tglTran: row.tgl_tran, tglEfektif: row.tgl_efektif, jamTran: row.jam_tran }, parseNow);
      if (time.dateSwapStatus === 'corrected') dateSwapCorrected++;
      else if (time.dateSwapStatus === 'uncorrectable') dateSwapUncorrectable++;
      const transferGroupKey = computeBriBifastGroupKey({
        bankCode: BANK_CODE, accountNo: norek, businessDate: time.businessDate,
        bankTraceId: classification.bankTraceId, jamTranNormalized: time.jamTranNormalized,
        seq, beneficiaryAccount: classification.beneficiaryAccount, deskTran,
      });

      let balanceCheckStatus = 'UNDETERMINED', balanceVariance = null;
      if (saldoAwal !== null && saldoAkhir !== null) {
        const expected = saldoAwal - (mutasiDebet || 0) + (mutasiKredit || 0);
        balanceVariance = saldoAkhir - expected;
        balanceCheckStatus = Math.abs(balanceVariance) <= 1 ? 'BALANCED' : 'UNBALANCED';
      }

      const fingerprint = buildBriBifastFingerprint({
        bankCode: BANK_CODE, norek,
        tglTranNormalized: formatDateJakartaBriBifast(time.transactionDateTime),
        tglEfektifNormalized: time.businessDate,
        jamTran: row.jam_tran, seq, deskTran, mutasiDebet, mutasiKredit, saldoAkhirMutasi: saldoAkhir, tlbds2,
      });

      const insertRes = await client.query(
        `INSERT INTO recon_bank_transactions
           (batch_id, account_no, business_date, transaction_date_time, effective_date_time,
            sequence_no, description, remarks, tlbds1, tlbds2, opening_balance, debit, credit, balance,
            beneficiary_account, account_from_desk_tran, account_from_trremk, account_conflict,
            bank_trace_id, trace_from_desk_tran, trace_from_tlbds2, counterparty_bic, esb_reference, transfer_group_key,
            extracted_transaction_id, bank_row_type, extraction_method, extraction_confidence, id_conflict,
            balance_check_status, balance_variance, row_fingerprint, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
         ON CONFLICT (row_fingerprint) WHERE row_fingerprint IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          batchId, norek, time.businessDate, time.transactionDateTime, time.effectiveDateTime,
          seq, deskTran, trremk, tlbds1, tlbds2, saldoAwal, mutasiDebet, mutasiKredit, saldoAkhir,
          classification.beneficiaryAccount, classification.accountFromDeskTran, classification.accountFromTrremk, classification.accountConflict,
          classification.bankTraceId, classification.traceFromDeskTran, classification.traceFromTlbds2,
          classification.counterpartyBic, classification.esbReference, transferGroupKey,
          classification.beneficiaryAccount, classification.bankRowType, classification.extractionConfidence,
          classification.extractionConfidence, classification.accountConflict,
          balanceCheckStatus, balanceVariance, fingerprint,
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      if (insertRes.rows.length) bankInserted++;
      else bankSkippedDuplicateFingerprint++;
    }
    if (dateSwapCorrected > 0) {
      console.warn(`reconciliation-bri-bifast sync: ${dateSwapCorrected} baris TGL_TRAN/TGL_EFEKTIF dikoreksi (hari/bulan tertukar akibat locale Sheets, mutasi bank tidak mungkin bertanggal masa depan) utk business_date ${businessDate}.`);
    }
    if (dateSwapUncorrectable > 0) {
      console.warn(`reconciliation-bri-bifast sync: ${dateSwapUncorrectable} baris TGL_TRAN/TGL_EFEKTIF di masa depan TAPI tidak bisa dikoreksi otomatis (hari>12 atau hasil tukar tetap tidak valid) utk business_date ${businessDate} — cek manual raw_data.`);
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({
        success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal,
        fp_rows_inserted: fpInserted, bank_rows_inserted: bankInserted, engine_run: false,
      });
    }

    // Chunk terakhir -> jalankan engine atas SELURUH data batch ini.
    const [fpAllRes, bankAllRes] = await Promise.all([
      client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]),
      client.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batchId]),
    ]);

    // Kandidat transaksi BRI BI-FAST: id_biller = '11096' — filter di SINI
    // (bukan di dalam pure engine), id_produk TIDAK dipakai memfilter.
    const fpForEngine = fpAllRes.rows
      .map(r => ({
        idTransaksi: r.id_transaksi, billInfo1: r.bill_info1, nominal: r.nominal !== null ? Number(r.nominal) : null,
        idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
        idOutlet: r.id_outlet, idBiller: r.id_biller,
      }))
      .filter(isBriBifastFpCandidate);

    const bankForEngine = bankAllRes.rows.map(r => ({
      bankCode: BANK_CODE, accountNo: r.account_no, businessDate: r.business_date,
      seq: r.sequence_no, deskTran: r.description, trremk: r.remarks, tlbds2: r.tlbds2,
      mutasiDebet: r.debit !== null ? Number(r.debit) : null, mutasiKredit: r.credit !== null ? Number(r.credit) : null,
      saldoAwalMutasi: r.opening_balance !== null ? Number(r.opening_balance) : null,
      saldoAkhirMutasi: r.balance !== null ? Number(r.balance) : null,
      transactionDateTime: r.transaction_date_time ? new Date(r.transaction_date_time) : null,
      beneficiaryAccount: r.beneficiary_account, bankTraceId: r.bank_trace_id, counterpartyBic: r.counterparty_bic,
      accountConflict: r.account_conflict, extractionConfidence: r.extraction_confidence, bankRowType: r.bank_row_type,
      jamTranNormalized: null, // sudah masuk transactionDateTime, tidak dipakai lagi di grouping (group key pakai businessDate+jamTran mentah dari raw insert, konsisten via transfer_group_key kolom)
    }));

    const engineConfig = {
      expectedFee, graceMinutes, bankPostingBeforeFpToleranceMinutes, bankPostingAfterFpToleranceMinutes, mismatchTimeToleranceMinutes,
    };
    const results = reconcileBriBifastTransactions(fpForEngine, bankForEngine, engineConfig, new Date());
    const balanceValidation = validateBriBifastBalance(bankForEngine);

    // Reversal cross-date lookup — TERISOLASI (lihat briBifastAdapter.js).
    // HANYA exact bank_trace_id + account_no (spec eksplisit).
    let finalResults = results;
    let crossDateResultCount = 0;
    if (reversalLookupDays > 0) {
      const futureRes = await client.query(
        `SELECT bt.bank_trace_id, bt.account_no, bt.credit, bt.transaction_date_time, bt.business_date::text AS business_date
         FROM recon_bank_transactions bt
         JOIN recon_sync_batches sb ON sb.id = bt.batch_id
         WHERE sb.bank_code = $1 AND bt.account_no = $2 AND bt.bank_row_type = 'CREDIT_REVERSAL'
           AND bt.bank_trace_id IS NOT NULL
           AND bt.business_date > $3::date AND bt.business_date <= ($3::date + $4 * INTERVAL '1 day')`,
        [BANK_CODE, accountNo, businessDate, reversalLookupDays]
      );
      if (futureRes.rows.length) {
        const futureByKey = new Map();
        for (const row of futureRes.rows) {
          const key = `${row.account_no}|${row.bank_trace_id}`;
          if (!futureByKey.has(key)) futureByKey.set(key, []);
          futureByKey.get(key).push({
            mutasiKredit: row.credit !== null ? Number(row.credit) : null,
            transactionDateTime: row.transaction_date_time ? new Date(row.transaction_date_time) : null,
            businessDate: row.business_date,
          });
        }
        finalResults = applyBriBifastReversalCrossDateLookup(results, futureByKey, { reversalLookupDays });
        crossDateResultCount = finalResults.filter(r => r.reversalLookupSource === 'CROSS_DATE_TRACE').length;
      }
    }

    for (const r of finalResults) {
      // canonical_transaction_key: id_transaksi kalau FP ada (bill_info1
      // BUKAN unik per FP -- satu beneficiary bisa terima banyak transfer),
      // else 'BRI_BIFAST_BANK::' + bank_trace_id (fallback stableGroupFingerprint
      // kalau trace tidak tersedia) utk BANK_ONLY/REVERSAL/NEED_REVIEW tanpa FP.
      const canonicalKey = r.idTransaksi
        ? normalizeCanonicalKey(r.idTransaksi)
        : `BRI_BIFAST_BANK::${r.bankTraceId || r.stableGroupFingerprint}`;
      await client.query(
        `INSERT INTO recon_results
           (batch_id, bank_code, id_transaksi, canonical_transaction_key, id_outlet, id_produk, id_biller,
            fp_bill_info1, bank_beneficiary_account, bank_trace_id, counterparty_bic, account_conflict, time_order_status,
            fp_nominal, fp_time_response, bank_transaction_date, bank_principal, bank_fee, bank_credit, bank_total_debit,
            variance_principal, variance_fee, time_difference_minutes, matching_method,
            recon_status, aging_minutes, notes, reversal_date, reversal_amount, reversal_lookup_source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW())
         ON CONFLICT (batch_id, canonical_transaction_key) DO UPDATE SET
           bank_code = EXCLUDED.bank_code, id_transaksi = EXCLUDED.id_transaksi,
           id_outlet = EXCLUDED.id_outlet, id_produk = EXCLUDED.id_produk, id_biller = EXCLUDED.id_biller,
           fp_bill_info1 = EXCLUDED.fp_bill_info1, bank_beneficiary_account = EXCLUDED.bank_beneficiary_account,
           bank_trace_id = EXCLUDED.bank_trace_id, counterparty_bic = EXCLUDED.counterparty_bic,
           account_conflict = EXCLUDED.account_conflict, time_order_status = EXCLUDED.time_order_status,
           fp_nominal = EXCLUDED.fp_nominal, fp_time_response = EXCLUDED.fp_time_response,
           bank_transaction_date = EXCLUDED.bank_transaction_date, bank_principal = EXCLUDED.bank_principal,
           bank_fee = EXCLUDED.bank_fee, bank_credit = EXCLUDED.bank_credit, bank_total_debit = EXCLUDED.bank_total_debit,
           variance_principal = EXCLUDED.variance_principal, variance_fee = EXCLUDED.variance_fee,
           time_difference_minutes = EXCLUDED.time_difference_minutes,
           matching_method = EXCLUDED.matching_method, recon_status = EXCLUDED.recon_status,
           aging_minutes = EXCLUDED.aging_minutes, notes = EXCLUDED.notes,
           reversal_date = EXCLUDED.reversal_date, reversal_amount = EXCLUDED.reversal_amount,
           reversal_lookup_source = EXCLUDED.reversal_lookup_source, updated_at = NOW()`,
        [
          batchId, BANK_CODE, r.idTransaksi, canonicalKey, r.idOutlet, r.idProduk, r.idBiller,
          r.billInfo1, r.beneficiaryAccount, r.bankTraceId, r.counterpartyBic, !!r.accountConflict, r.timeOrderStatus,
          r.fpNominal, r.fpTimeResponse, formatDateJakartaBriBifast(r.bankTransactionDate), r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
          r.variancePrincipal, r.varianceFee, r.timeDifferenceMinutes, r.matchingMethod,
          r.reconStatus, r.agingMinutes, r.notes, r.reversalDate, r.reversalAmount, r.reversalLookupSource,
        ]
      );
    }

    const currentKeys = finalResults.map(r =>
      r.idTransaksi ? normalizeCanonicalKey(r.idTransaksi) : `BRI_BIFAST_BANK::${r.bankTraceId || r.stableGroupFingerprint}`
    ).filter(Boolean);
    await client.query(
      `DELETE FROM recon_results WHERE batch_id = $1 AND bank_code = $2 AND canonical_transaction_key <> ALL($3::text[])`,
      [batchId, BANK_CODE, currentKeys.length ? currentKeys : ['']]
    );

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW(),
         raw_summary = COALESCE(raw_summary, '{}'::jsonb) || $4::jsonb WHERE id = $1`,
      [batchId, fpAllRes.rows.length, bankAllRes.rows.length, JSON.stringify({ balance_validation: balanceValidation })]
    );

    await client.query('COMMIT');
    res.json({
      success: true, batch_id: batchId, business_date: businessDate, bank_code: BANK_CODE,
      fp_row_count: fpAllRes.rows.length, bank_row_count: bankAllRes.rows.length,
      bank_rows_skipped_duplicate_fingerprint: bankSkippedDuplicateFingerprint,
      result_count: finalResults.length, balance_validation: balanceValidation,
      cross_date_result_count: crossDateResultCount,
      engine_run: true, synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation-bri-bifast sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics tambahan dari recon_bank_transactions MENTAH (account_conflict,
// duplicate_bank_trace, orphan_fee_group, unbalanced) — JS-side, pola sama
// dgn extraction_summary BRI existing.
// ─────────────────────────────────────────────────────────────────────────
function computeBriBifastRawDiagnostics(bankRows, expectedFee) {
  let accountConflictCount = 0, mediumConfCount = 0, highConfCount = 0, conflictConfCount = 0, noneConfCount = 0;
  let balancedRows = 0, unbalancedRows = 0, undeterminedRows = 0, varianceTotal = 0;
  const traceToGroupKeys = new Map();
  const groupDebits = new Map(); // transfer_group_key -> { hasNonFee, hasCredit, feeCount }

  for (const r of bankRows) {
    if (r.account_conflict) accountConflictCount++;
    if (r.extraction_confidence === 'HIGH') highConfCount++;
    else if (r.extraction_confidence === 'MEDIUM') mediumConfCount++;
    else if (r.extraction_confidence === 'CONFLICT') conflictConfCount++;
    else if (r.bank_row_type === 'DEBIT_COMPONENT' || r.bank_row_type === 'CREDIT_REVERSAL') noneConfCount++;

    if (r.balance_check_status === 'BALANCED') balancedRows++;
    else if (r.balance_check_status === 'UNBALANCED') { unbalancedRows++; varianceTotal += Number(r.balance_variance || 0); }
    else undeterminedRows++;

    if (r.bank_trace_id && r.transfer_group_key) {
      if (!traceToGroupKeys.has(r.bank_trace_id)) traceToGroupKeys.set(r.bank_trace_id, new Set());
      traceToGroupKeys.get(r.bank_trace_id).add(r.transfer_group_key);
    }

    if (r.bank_row_type === 'DEBIT_COMPONENT' && r.transfer_group_key) {
      if (!groupDebits.has(r.transfer_group_key)) groupDebits.set(r.transfer_group_key, { hasNonFee: false, hasCredit: false });
      const g = groupDebits.get(r.transfer_group_key);
      if (!(typeof r.debit === 'number' && Math.abs(Number(r.debit) - expectedFee) < 0.5)) g.hasNonFee = true;
    }
    if (r.bank_row_type === 'CREDIT_REVERSAL' && r.transfer_group_key) {
      if (!groupDebits.has(r.transfer_group_key)) groupDebits.set(r.transfer_group_key, { hasNonFee: false, hasCredit: false });
      groupDebits.get(r.transfer_group_key).hasCredit = true;
    }
  }

  let duplicateBankTraceCount = 0;
  for (const keys of traceToGroupKeys.values()) {
    if (keys.size > 1) duplicateBankTraceCount += keys.size - 1;
  }

  let orphanFeeGroupCount = 0;
  for (const g of groupDebits.values()) {
    if (!g.hasNonFee && !g.hasCredit) orphanFeeGroupCount++;
  }

  return {
    account_conflict_count: accountConflictCount,
    duplicate_bank_trace_count: duplicateBankTraceCount,
    orphan_fee_group_count: orphanFeeGroupCount,
    high_confidence_count: highConfCount, medium_confidence_count: mediumConfCount,
    conflict_count: conflictConfCount, none_confidence_count: noneConfCount,
    balanced_rows: balancedRows, unbalanced_rows: unbalancedRows, undetermined_rows: undeterminedRows,
    balance_variance_total: varianceTotal,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/analytics?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    let date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) {
      const latest = await pool.query(
        'SELECT business_date::text AS business_date FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 1',
        [BANK_CODE]
      );
      date = latest.rows[0] ? latest.rows[0].business_date : null;
    }

    const recentBatchesRes = await pool.query(
      `SELECT batch_no, business_date::text AS business_date, bank_code, account_no, scope_mode, fp_row_count, bank_row_count, synced_at, status
       FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 14`,
      [BANK_CODE]
    );
    const recentBatches = recentBatchesRes.rows;

    if (!date) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi BRI BI-FAST. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { date: null, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    // Active batch WAJIB exact match tanggal diminta — TIDAK PERNAH fallback.
    const batchRes = await pool.query(
      'SELECT *, business_date::text AS business_date FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, BANK_CODE]
    );
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi BRI BI-FAST untuk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankRowsRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batch.id]),
    ]);

    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const rawResults = resultsRes.rows;
    const qualityChecks = computeBriBifastResultQualityChecks(rawResults, date);
    const resultsValidDate = rawResults.filter(r =>
      r.bank_transaction_date === null || r.bank_transaction_date === date ||
      r.reversal_lookup_source === 'CROSS_DATE_TRACE'
    );
    const results = dedupeBriBifastResultsByCanonicalKey(resultsValidDate);

    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_BRI_BIFAST;
    const rawDiag = computeBriBifastRawDiagnostics(bankRowsRes.rows, expectedFee);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const bankTransferGroupCount = new Set(bankRowsRes.rows.filter(r => r.transfer_group_key).map(r => r.transfer_group_key)).size;

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const totalPrincipalBank = results.reduce((s, r) => s + (r.bank_principal !== null ? Number(r.bank_principal) : 0), 0);
    const totalActualFee = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);
    const transactionWithFeeCount = results.filter(r => r.bank_fee !== null).length;
    const expectedTotalFee = transactionWithFeeCount * expectedFee;

    const actionableException = computeBriBifastActionableException(results);

    const summary = {
      total_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      bank_transfer_group_count: bankTransferGroupCount,
      matched_count: byStatus.MATCHED.count,
      matched_no_fee: byStatus.MATCHED_NO_FEE.count,
      matched_nominal: matchedNominal,
      pending_bank: byStatus.PENDING_BANK.count,
      fp_only: byStatus.FP_ONLY.count,
      bank_only: byStatus.BANK_ONLY.count,
      nominal_mismatch: byStatus.NOMINAL_MISMATCH.count,
      fee_mismatch: byStatus.FEE_MISMATCH.count,
      duplicate_fp: byStatus.DUPLICATE_FP.count,
      duplicate_bank: byStatus.DUPLICATE_BANK.count,
      reversal: byStatus.REVERSAL.count,
      need_review: byStatus.NEED_REVIEW.count,
      principal_total: totalPrincipalBank,
      fee_total: totalActualFee,
      expected_fee: expectedFee,
      expected_fee_total: expectedTotalFee,
      fee_variance: totalActualFee - expectedTotalFee,
      valid_match_rate_transaction: safeDiv(matchedCount, totalTransaksiFp),
      valid_match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    // Fee analysis
    const feeRows = results.filter(r => r.bank_fee !== null);
    const feeMismatchRows = results.filter(r => r.recon_status === 'FEE_MISMATCH');
    const noFeeRows = results.filter(r => r.recon_status === 'MATCHED_NO_FEE');
    const orphanFeeCount = rawDiag.orphan_fee_group_count;
    const groupFeeBy = (keyFn) => {
      const map = new Map();
      for (const r of feeRows) {
        const key = keyFn(r) || '(tidak diketahui)';
        if (!map.has(key)) map.set(key, { key, count: 0, total_fee: 0 });
        const g = map.get(key);
        g.count++; g.total_fee += Number(r.bank_fee);
      }
      return [...map.values()].sort((a, b) => b.total_fee - a.total_fee);
    };
    const fee_analysis = {
      expected_fee: expectedFee,
      transaction_with_fee_count: transactionWithFeeCount,
      actual_fee_total: totalActualFee,
      expected_fee_total: expectedTotalFee,
      fee_variance: totalActualFee - expectedTotalFee,
      no_fee_count: noFeeRows.length,
      mismatched_fee_count: feeMismatchRows.length,
      orphan_fee_group_count: orphanFeeCount,
      distribution: [
        { fee: expectedFee, count: feeRows.filter(r => Math.abs(Number(r.bank_fee) - expectedFee) < 0.5).length },
        { fee: 0, count: feeRows.filter(r => Number(r.bank_fee) === 0).length },
        { fee: 'lainnya', count: feeRows.filter(r => Math.abs(Number(r.bank_fee) - expectedFee) >= 0.5 && Number(r.bank_fee) !== 0).length },
      ],
      by_produk: groupFeeBy(r => r.id_produk),
      by_outlet: groupFeeBy(r => r.id_outlet).slice(0, 20),
      by_biller: groupFeeBy(r => r.id_biller),
      by_counterparty_bic: groupFeeBy(r => r.counterparty_bic),
    };

    // Time & posting analysis
    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sum = absDiffs.reduce((s, v) => s + v, 0);
    const average_minutes = absDiffs.length ? sum / absDiffs.length : null;
    const median_minutes = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95_minutes = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const maximum_minutes = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
    const buckets = { NORMAL: 0, WARNING: 0, DELAYED: 0, EXTREME: 0, IMPOSSIBLE_ORDER: 0 };
    for (const r of results) { if (r.time_order_status && buckets[r.time_order_status] !== undefined) buckets[r.time_order_status]++; }
    const lateRows = results
      .filter(r => r.time_order_status === 'EXTREME' || r.time_order_status === 'IMPOSSIBLE_ORDER')
      .sort((a, b) => Math.abs(Number(b.time_difference_minutes || 0)) - Math.abs(Number(a.time_difference_minutes || 0)))
      .slice(0, 50)
      .map(r => ({
        id_transaksi: r.id_transaksi, fp_bill_info1: r.fp_bill_info1, bank_beneficiary_account: r.bank_beneficiary_account,
        fp_time_response: r.fp_time_response, bank_transaction_date: r.bank_transaction_date,
        time_difference_minutes: r.time_difference_minutes, time_order_status: r.time_order_status, recon_status: r.recon_status,
      }));
    const time_analysis = {
      average_minutes, median_minutes, p95_minutes, maximum_minutes,
      bucket_0_5: buckets.NORMAL, bucket_5_15: buckets.WARNING, bucket_15_30: buckets.DELAYED, bucket_over_30: buckets.EXTREME,
      impossible_time_order: buckets.IMPOSSIBLE_ORDER,
      late_postings: lateRows,
    };
    const hasPostingDelay = buckets.EXTREME > 0 || buckets.IMPOSSIBLE_ORDER > 0;

    const balance_validation = {
      status: rawDiag.unbalanced_rows > 0 ? 'UNBALANCED' : (rawDiag.balanced_rows > 0 ? 'BALANCED' : 'UNDETERMINED'),
      balanced_rows: rawDiag.balanced_rows, unbalanced_rows: rawDiag.unbalanced_rows, undetermined_rows: rawDiag.undetermined_rows,
      total_variance: rawDiag.balance_variance_total,
    };

    const extraction_summary = {
      high_confidence_count: rawDiag.high_confidence_count,
      medium_confidence_count: rawDiag.medium_confidence_count,
      conflict_count: rawDiag.conflict_count,
      none_confidence_count: rawDiag.none_confidence_count,
      account_conflict_count: rawDiag.account_conflict_count,
    };

    const extractionMediumRatio = safeDiv(rawDiag.medium_confidence_count, rawDiag.high_confidence_count + rawDiag.medium_confidence_count + rawDiag.conflict_count + rawDiag.none_confidence_count);

    const hasIssue = qualityChecks.invalid_business_date_count > 0 ||
      qualityChecks.duplicate_canonical_result_count > 0 ||
      qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      invalid_business_date_count: qualityChecks.invalid_business_date_count,
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      account_conflict_count: rawDiag.account_conflict_count,
      duplicate_bank_trace_count: rawDiag.duplicate_bank_trace_count,
      orphan_fee_group_count: rawDiag.orphan_fee_group_count,
      impossible_time_order_count: qualityChecks.impossible_time_order_count,
      unbalanced_bank_row_count: rawDiag.unbalanced_rows,
      has_issue: hasIssue,
      message: [
        qualityChecks.invalid_business_date_count > 0 ? `Ditemukan ${qualityChecks.invalid_business_date_count} baris hasil dgn bank_transaction_date di luar tanggal ${date}.` : null,
        qualityChecks.duplicate_canonical_result_count > 0 ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.` : null,
        qualityChecks.consumed_also_bank_only_count > 0 ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.` : null,
        rawDiag.account_conflict_count > 0 ? `${rawDiag.account_conflict_count} mutasi memiliki konflik ekstraksi beneficiary account antara DESK_TRAN/TRREMK.` : null,
        rawDiag.duplicate_bank_trace_count > 0 ? `${rawDiag.duplicate_bank_trace_count} bank_trace_id dipakai lebih dari satu grup transfer.` : null,
        rawDiag.orphan_fee_group_count > 0 ? `${rawDiag.orphan_fee_group_count} grup transfer fee-only tanpa baris principal.` : null,
        qualityChecks.impossible_time_order_count > 0 ? `${qualityChecks.impossible_time_order_count} transaksi dgn urutan waktu tidak mungkin (bank posting jauh sebelum FP).` : null,
        rawDiag.unbalanced_rows > 0 ? `${rawDiag.unbalanced_rows} baris mutasi tidak balance.` : null,
      ].filter(Boolean).join(' ') || null,
    };

    res.json({
      empty: false,
      meta: {
        date, bank_code: BANK_CODE, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
        account_no: batch.account_no, scope_mode: batch.scope_mode,
        expected_fee: expectedFee, grace_period_minutes: batch.grace_period_minutes,
        bank_posting_before_fp_tolerance_minutes: batch.bank_posting_before_fp_tolerance_minutes,
        bank_posting_after_fp_tolerance_minutes: batch.bank_posting_after_fp_tolerance_minutes,
        mismatch_time_tolerance_minutes: batch.mismatch_time_tolerance_minutes,
        reversal_lookup_days: batch.reversal_lookup_days,
      },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, expected_fee: expectedFee, synced_at: batch.synced_at, sync_status: batch.status,
      },
      summary, status_distribution, fee_analysis, time_analysis, balance_validation,
      extraction_summary, data_quality_warning,
      recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-bri-bifast analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/daily-report?date=YYYY-MM-DD
// TIDAK PERNAH fallback ke batch tanggal lain — default date = HARI INI (WIB).
// ─────────────────────────────────────────────────────────────────────────
async function dailyReportHandler(req, res) {
  try {
    const todayStr = todayJakarta();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr;
    const generatedAt = new Date().toISOString();
    const reportStatus = date === todayStr ? 'RUNNING' : 'CLOSED';

    const batchRes = await pool.query(
      'SELECT *, business_date::text AS business_date FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, BANK_CODE]
    );
    const batch = batchRes.rows[0] || null;

    if (!batch) {
      return res.json({
        success: true, empty: true,
        message: 'Belum ada data rekonsiliasi BRI BI-FAST untuk tanggal ini.',
        generated_at: generatedAt, report_status: reportStatus,
        meta: { date, bank_code: BANK_CODE },
      });
    }

    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes, bankRowsRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batch.id]),
    ]);

    const rawResults = resultsRes.rows;
    const qualityChecks = computeBriBifastResultQualityChecks(rawResults, date);
    const resultsValidDate = rawResults.filter(r =>
      r.bank_transaction_date === null || r.bank_transaction_date === date ||
      r.reversal_lookup_source === 'CROSS_DATE_TRACE'
    );
    const results = dedupeBriBifastResultsByCanonicalKey(resultsValidDate);

    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_BRI_BIFAST;
    const rawDiag = computeBriBifastRawDiagnostics(bankRowsRes.rows, expectedFee);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const bankTransferGroupCount = new Set(bankRowsRes.rows.filter(r => r.transfer_group_key).map(r => r.transfer_group_key)).size;

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const totalActualFee = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);
    const transactionWithFeeCount = results.filter(r => r.bank_fee !== null).length;
    const expectedTotalFee = transactionWithFeeCount * expectedFee;

    const validMatchRateTransaction = safeDiv(matchedCount, totalTransaksiFp);
    const validMatchRateNominal = safeDiv(matchedNominal, totalNominalFp);
    const actionableException = computeBriBifastActionableException(results);

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sumMinutes = absDiffs.reduce((s, v) => s + v, 0);
    const average_minutes = absDiffs.length ? sumMinutes / absDiffs.length : null;
    const median_minutes = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95_minutes = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const maximum_minutes = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
    const buckets = { NORMAL: 0, WARNING: 0, DELAYED: 0, EXTREME: 0, IMPOSSIBLE_ORDER: 0 };
    for (const r of results) { if (r.time_order_status && buckets[r.time_order_status] !== undefined) buckets[r.time_order_status]++; }
    const time_posting_summary = {
      average_minutes, median_minutes, p95_minutes, maximum_minutes,
      bucket_0_5: buckets.NORMAL, bucket_5_15: buckets.WARNING, bucket_15_30: buckets.DELAYED, bucket_over_30: buckets.EXTREME,
      impossible_time_order: buckets.IMPOSSIBLE_ORDER,
    };
    const hasPostingDelay = buckets.EXTREME > 0 || buckets.IMPOSSIBLE_ORDER > 0;

    const balance_validation = {
      status: rawDiag.unbalanced_rows > 0 ? 'UNBALANCED' : (rawDiag.balanced_rows > 0 ? 'BALANCED' : 'UNDETERMINED'),
      total_rows_checked: rawDiag.balanced_rows + rawDiag.unbalanced_rows + rawDiag.undetermined_rows,
      balanced_rows: rawDiag.balanced_rows, unbalanced_rows: rawDiag.unbalanced_rows, undetermined_rows: rawDiag.undetermined_rows,
      total_variance: rawDiag.balance_variance_total,
      pct_balanced: safeDiv(rawDiag.balanced_rows, rawDiag.balanced_rows + rawDiag.unbalanced_rows + rawDiag.undetermined_rows),
    };

    const extraction_summary = {
      high_confidence_count: rawDiag.high_confidence_count, medium_confidence_count: rawDiag.medium_confidence_count,
      conflict_count: rawDiag.conflict_count, none_confidence_count: rawDiag.none_confidence_count,
      account_conflict_count: rawDiag.account_conflict_count,
    };
    const extractionMediumRatio = safeDiv(rawDiag.medium_confidence_count, rawDiag.high_confidence_count + rawDiag.medium_confidence_count + rawDiag.conflict_count + rawDiag.none_confidence_count);

    const financial_summary = {
      total_nominal_fp: totalNominalFp,
      matched_nominal: matchedNominal,
      actual_fee_total: totalActualFee,
      expected_fee_total: expectedTotalFee,
      fee_variance: totalActualFee - expectedTotalFee,
      actionable_exception_nominal: actionableException.nominal,
      reversal_nominal: byStatus.REVERSAL.nominal,
    };

    const hasIssue = qualityChecks.invalid_business_date_count > 0 ||
      qualityChecks.duplicate_canonical_result_count > 0 ||
      qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      invalid_business_date_count: qualityChecks.invalid_business_date_count,
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      account_conflict_count: rawDiag.account_conflict_count,
      duplicate_bank_trace_count: rawDiag.duplicate_bank_trace_count,
      orphan_fee_group_count: rawDiag.orphan_fee_group_count,
      impossible_time_order_count: qualityChecks.impossible_time_order_count,
      unbalanced_bank_row_count: rawDiag.unbalanced_rows,
      has_issue: hasIssue,
      message: [
        qualityChecks.invalid_business_date_count > 0 ? `Ditemukan ${qualityChecks.invalid_business_date_count} baris hasil dgn bank_transaction_date di luar tanggal ${date}.` : null,
        qualityChecks.duplicate_canonical_result_count > 0 ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.` : null,
        qualityChecks.consumed_also_bank_only_count > 0 ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.` : null,
        rawDiag.account_conflict_count > 0 ? `${rawDiag.account_conflict_count} mutasi memiliki konflik ekstraksi beneficiary account.` : null,
        rawDiag.duplicate_bank_trace_count > 0 ? `${rawDiag.duplicate_bank_trace_count} bank_trace_id dipakai lebih dari satu grup transfer.` : null,
        rawDiag.orphan_fee_group_count > 0 ? `${rawDiag.orphan_fee_group_count} grup transfer fee-only tanpa baris principal.` : null,
        qualityChecks.impossible_time_order_count > 0 ? `${qualityChecks.impossible_time_order_count} transaksi dgn urutan waktu tidak mungkin.` : null,
        rawDiag.unbalanced_rows > 0 ? `${rawDiag.unbalanced_rows} baris mutasi tidak balance.` : null,
      ].filter(Boolean).join(' ') || null,
    };

    const top_10_exception = results
      .filter(r => EXCEPTION_STATUSES.includes(r.recon_status))
      .sort((a, b) => {
        const av = Number(a.fp_nominal !== null ? a.fp_nominal : (a.bank_total_debit || 0));
        const bv = Number(b.fp_nominal !== null ? b.fp_nominal : (b.bank_total_debit || 0));
        return bv - av;
      })
      .slice(0, 10)
      .map(r => ({
        id_transaksi: r.id_transaksi || null, canonical_transaction_key: r.canonical_transaction_key || null,
        fp_bill_info1: r.fp_bill_info1 || null, bank_beneficiary_account: r.bank_beneficiary_account || null,
        id_outlet: r.id_outlet || null, id_produk: r.id_produk || null, id_biller: r.id_biller || null,
        recon_status: r.recon_status,
        fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
        bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
        bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
        variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
        variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
        time_difference_minutes: r.time_difference_minutes,
        time_order_status: r.time_order_status || null,
        matching_method: r.matching_method || null,
        account_conflict: !!r.account_conflict,
        bank_trace_id: r.bank_trace_id || null,
        reversal_lookup_source: r.reversal_lookup_source || null,
        notes: r.notes || null,
      }));

    const healthStatus = computeBriBifastHealthStatus({
      validMatchRateTransaction, actionableExceptionCount: actionableException.count,
      syncStatus: batch.status,
      invalidBusinessDateCount: qualityChecks.invalid_business_date_count,
      duplicateCanonicalResultCount: qualityChecks.duplicate_canonical_result_count,
      consumedAlsoBankOnlyCount: qualityChecks.consumed_also_bank_only_count,
      accountConflictCount: rawDiag.account_conflict_count,
      duplicateBankTraceCount: rawDiag.duplicate_bank_trace_count,
      impossibleTimeOrderCount: qualityChecks.impossible_time_order_count,
      unbalancedBankRowCount: rawDiag.unbalanced_rows,
      extractionMediumRatio, hasPostingDelay,
    });

    // ── Ringkasan otomatis Direktur — deterministic, TANPA AI ──
    const pctMatch = validMatchRateTransaction !== null ? (validMatchRateTransaction * 100).toFixed(2).replace('.', ',') : '-';
    const exceptionStatusesPresent = RECON_STATUSES.filter(s => EXCEPTION_STATUSES.includes(s) && byStatus[s].count > 0);
    const lines = [];
    lines.push(
      `Per ${formatWibLong(new Date())}, sebanyak ${fmtNumId(matchedCount)} dari ${fmtNumId(totalTransaksiFp)} transaksi BRI BI-FAST telah berhasil direkonsiliasi dengan valid match rate sebesar ${pctMatch}%.`
    );
    lines.push(
      actionableException.count > 0
        ? `Terdapat ${fmtNumId(actionableException.count)} transaksi yang memerlukan tindak lanjut dengan nilai terdampak ${fmtRpId(actionableException.nominal)}. Expected fee BI-FAST adalah ${fmtRpId(expectedFee)} per transaksi.`
        : `Tidak ada transaksi exception yang perlu ditindaklanjuti. Expected fee BI-FAST adalah ${fmtRpId(expectedFee)} per transaksi.`
    );
    if (exceptionStatusesPresent.length > 0) {
      const parts = exceptionStatusesPresent.map(s => `${fmtNumId(byStatus[s].count)} transaksi ${s}`);
      lines.push(`Ditemukan ${joinWithDan(parts)}.`);
    }
    lines.push(`Validasi saldo bank berstatus ${balance_validation.status === 'BALANCED' ? 'selaras' : balance_validation.status === 'UNBALANCED' ? 'TIDAK selaras' : 'tidak dapat dipastikan'}.`);
    if (hasIssue) lines.push(`PERHATIAN: ${data_quality_warning.message}`);
    lines.push(`Status kesehatan rekonsiliasi hari ini adalah ${healthStatus}.`);
    const ringkasan_direktur = lines.join(' ');

    const rekomendasi = [];
    if (hasIssue) rekomendasi.push('Segera periksa & bersihkan data quality issue (invalid business date/duplikat canonical/consumed juga bank only) sebelum laporan difinalisasi.');
    if (batch.status !== 'success') rekomendasi.push('Sinkronisasi batch ini belum berstatus sukses — cek Apps Script/Execution Log dan jalankan sync ulang.');
    if (actionableException.count > 0) rekomendasi.push(`Tindak lanjuti ${fmtNumId(actionableException.count)} transaksi exception senilai ${fmtRpId(actionableException.nominal)} melalui tab Exception Queue.`);
    if (rawDiag.account_conflict_count > 0) rekomendasi.push(`Periksa manual ${fmtNumId(rawDiag.account_conflict_count)} mutasi dgn konflik ekstraksi beneficiary account (DESK_TRAN/TRREMK tidak konsisten).`);
    if (rawDiag.duplicate_bank_trace_count > 0) rekomendasi.push(`Periksa ${fmtNumId(rawDiag.duplicate_bank_trace_count)} bank_trace_id yang dipakai lebih dari satu grup transfer.`);
    if (rawDiag.orphan_fee_group_count > 0) rekomendasi.push(`Periksa ${fmtNumId(rawDiag.orphan_fee_group_count)} grup transfer fee-only tanpa baris principal.`);
    if (qualityChecks.impossible_time_order_count > 0) rekomendasi.push(`Periksa ${fmtNumId(qualityChecks.impossible_time_order_count)} transaksi dgn urutan waktu tidak mungkin (bank posting jauh sebelum FP).`);
    if (rawDiag.unbalanced_rows > 0) rekomendasi.push(`Periksa ${fmtNumId(rawDiag.unbalanced_rows)} baris mutasi BRI BI-FAST yang saldonya tidak balance.`);
    if (validMatchRateTransaction !== null && validMatchRateTransaction < BRI_BIFAST_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE) {
      rekomendasi.push('Match rate di bawah target 99% — eskalasi ke tim terkait untuk investigasi lebih lanjut.');
    }
    if (rekomendasi.length === 0) rekomendasi.push('Tidak ada tindak lanjut mendesak — seluruh transaksi FP telah berhasil direkonsiliasi dgn BRI BI-FAST.');

    res.json({
      success: true, empty: false,
      generated_at: generatedAt, report_status: reportStatus, health_status: healthStatus,
      meta: { date, bank_code: BANK_CODE, batch_no: batch.batch_no, last_sync: batch.synced_at },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, expected_fee: expectedFee, synced_at: batch.synced_at, sync_status: batch.status,
      },
      total_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      bank_transfer_group_count: bankTransferGroupCount,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      valid_match_rate_transaction: validMatchRateTransaction,
      valid_match_rate_nominal: validMatchRateNominal,
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
      reversal_count: byStatus.REVERSAL.count,
      reversal_nominal: byStatus.REVERSAL.nominal,
      status_distribution,
      financial_summary, fee_summary: financial_summary, time_posting_summary, extraction_summary, balance_validation,
      data_quality_warning,
      top_10_exception,
      ringkasan_direktur,
      rekomendasi_tindak_lanjut: rekomendasi,
    });
  } catch (e) {
    console.error('reconciliation-bri-bifast daily-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', fp_bill_info1: 'fp_bill_info1', bank_beneficiary_account: 'bank_beneficiary_account',
  fp_nominal: 'fp_nominal', bank_principal: 'bank_principal', bank_fee: 'bank_fee', bank_total_debit: 'bank_total_debit',
  variance_principal: 'variance_principal', variance_fee: 'variance_fee', aging_minutes: 'aging_minutes',
  time_difference_minutes: 'time_difference_minutes',
  recon_status: 'recon_status', fp_time_response: 'fp_time_response', bank_transaction_date: 'bank_transaction_date',
  updated_at: 'updated_at',
};

function buildTransactionsQuery(req) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const status = nullIfEmpty(req.query.status);
  const idOutlet = nullIfEmpty(req.query.id_outlet);
  const idProduk = nullIfEmpty(req.query.id_produk);
  const idBiller = nullIfEmpty(req.query.id_biller);
  const billInfo1 = nullIfEmpty(req.query.bill_info1);
  const beneficiaryAccount = nullIfEmpty(req.query.beneficiary_account);
  const bankTraceId = nullIfEmpty(req.query.bank_trace_id);
  const search = nullIfEmpty(req.query.search);

  const conditions = ['b.bank_code = $1', 'r.bank_code = $1'];
  const params = [BANK_CODE];
  if (date) { params.push(date); conditions.push(`b.business_date = $${params.length}`); }
  if (req.query.batch_id) { params.push(Number(req.query.batch_id)); conditions.push(`b.id = $${params.length}`); }
  if (status) {
    const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
    params.push(statusList);
    conditions.push(`r.recon_status = ANY($${params.length}::text[])`);
  }
  if (idOutlet) { params.push(idOutlet); conditions.push(`r.id_outlet = $${params.length}`); }
  if (idProduk) { params.push(idProduk); conditions.push(`r.id_produk = $${params.length}`); }
  if (idBiller) { params.push(idBiller); conditions.push(`r.id_biller = $${params.length}`); }
  if (billInfo1) { params.push(billInfo1); conditions.push(`r.fp_bill_info1 = $${params.length}`); }
  if (beneficiaryAccount) { params.push(beneficiaryAccount); conditions.push(`r.bank_beneficiary_account = $${params.length}`); }
  if (bankTraceId) { params.push(bankTraceId); conditions.push(`r.bank_trace_id = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.fp_bill_info1 ILIKE $${params.length} OR r.bank_beneficiary_account ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length} OR r.id_produk ILIKE $${params.length})`);
  }
  return { whereClause: conditions.join(' AND '), params };
}

async function transactionsHandler(req, res) {
  try {
    const { whereClause, params } = buildTransactionsQuery(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const sortKey = nullIfEmpty(req.query.sort);
    const sortColumn = (sortKey && SORT_COLUMNS[sortKey]) ? `r.${SORT_COLUMNS[sortKey]}` : 'r.updated_at';
    const sortDir = String(req.query.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id WHERE ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0]?.total || 0);

    const rowParams = [...params, limit, offset];
    const rowsRes = await pool.query(
      `SELECT r.*, b.business_date::text AS business_date, b.account_no AS batch_account_no,
              r.bank_transaction_date::text AS bank_transaction_date
       FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE ${whereClause} ORDER BY ${sortColumn} ${sortDir} NULLS LAST
       LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
      rowParams
    );

    res.json({
      meta: { page, limit, total, sort: sortKey && SORT_COLUMNS[sortKey] ? sortKey : 'updated_at', order: sortDir.toLowerCase() },
      rows: rowsRes.rows.map(mapResultRow),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function mapResultRow(r) {
  return {
    id: r.id,
    business_date: r.business_date,
    id_transaksi: r.id_transaksi,
    fp_bill_info1: r.fp_bill_info1,
    bank_beneficiary_account: r.bank_beneficiary_account,
    id_outlet: r.id_outlet,
    id_produk: r.id_produk,
    id_biller: r.id_biller,
    account_no: r.batch_account_no || null,
    fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
    fp_time_response: r.fp_time_response,
    bank_transaction_date: r.bank_transaction_date,
    bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
    bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    bank_total_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
    time_difference_minutes: r.time_difference_minutes,
    time_order_status: r.time_order_status,
    bank_trace_id: r.bank_trace_id,
    counterparty_bic: r.counterparty_bic,
    account_conflict: r.account_conflict,
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    reversal_date: r.reversal_date,
    reversal_amount: r.reversal_amount !== null ? Number(r.reversal_amount) : null,
    reversal_lookup_source: r.reversal_lookup_source,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/raw-fp & /raw-bank
// ─────────────────────────────────────────────────────────────────────────
async function rawFpHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json({ meta: { page: 1, limit: 0, total: 0 }, rows: [] });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = (page - 1) * limit;

    const batchRes = await pool.query('SELECT id FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2', [date, BANK_CODE]);
    const batchId = batchRes.rows[0]?.id;
    if (!batchId) return res.json({ meta: { page, limit, total: 0 }, rows: [] });

    const countRes = await pool.query('SELECT COUNT(*) AS total FROM recon_fp_transactions WHERE batch_id = $1', [batchId]);
    const rowsRes = await pool.query(
      `SELECT id, id_transaksi, bill_info1, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data
       FROM recon_fp_transactions WHERE batch_id = $1 ORDER BY source_row_number ASC NULLS LAST LIMIT $2 OFFSET $3`,
      [batchId, limit, offset]
    );
    res.json({ meta: { page, limit, total: Number(countRes.rows[0]?.total || 0) }, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function rawBankHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json({ meta: { page: 1, limit: 0, total: 0 }, rows: [] });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = (page - 1) * limit;

    const batchRes = await pool.query('SELECT id FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2', [date, BANK_CODE]);
    const batchId = batchRes.rows[0]?.id;
    if (!batchId) return res.json({ meta: { page, limit, total: 0 }, rows: [] });

    const countRes = await pool.query('SELECT COUNT(*) AS total FROM recon_bank_transactions WHERE batch_id = $1', [batchId]);
    const rowsRes = await pool.query(
      `SELECT id, account_no, transaction_date_time, effective_date_time, sequence_no, description, remarks,
              tlbds1, tlbds2, opening_balance, debit, credit, balance,
              beneficiary_account, account_from_desk_tran, account_from_trremk, account_conflict,
              bank_trace_id, counterparty_bic, esb_reference, transfer_group_key,
              extraction_confidence, bank_row_type, balance_check_status, balance_variance, source_row_number, raw_data
       FROM recon_bank_transactions WHERE batch_id = $1 ORDER BY source_row_number ASC NULLS LAST LIMIT $2 OFFSET $3`,
      [batchId, limit, offset]
    );
    res.json({ meta: { page, limit, total: Number(countRes.rows[0]?.total || 0) }, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/export — CSV
// ─────────────────────────────────────────────────────────────────────────
async function exportHandler(req, res) {
  try {
    const { whereClause, params } = buildTransactionsQuery(req);
    const rowsRes = await pool.query(
      `SELECT r.*, b.business_date::text AS business_date, b.account_no AS batch_account_no,
              r.bank_transaction_date::text AS bank_transaction_date
       FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE ${whereClause} ORDER BY r.updated_at DESC LIMIT 20000`,
      params
    );
    const headers = [
      'business_date', 'id_transaksi', 'fp_bill_info1', 'bank_beneficiary_account', 'account_no', 'id_outlet', 'id_produk', 'id_biller',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal', 'bank_fee', 'bank_credit', 'bank_total_debit',
      'variance_principal', 'variance_fee', 'time_difference_minutes', 'time_order_status', 'bank_trace_id', 'counterparty_bic',
      'account_conflict', 'matching_method', 'recon_status', 'aging_minutes', 'notes', 'reversal_date', 'reversal_amount', 'reversal_lookup_source',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-bri-bifast-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bri-bifast/:id/resolve
// ─────────────────────────────────────────────────────────────────────────
async function resolveHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });
    const status = nullIfEmpty(req.body?.status);
    const notes = nullIfEmpty(req.body?.notes);
    if (!status || !RECON_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status wajib salah satu dari: ${RECON_STATUSES.join(', ')}` });
    }
    if (!notes) {
      return res.status(400).json({ error: 'Catatan wajib diisi utk resolve Exception Queue.' });
    }

    const current = await pool.query('SELECT recon_status FROM recon_results WHERE id = $1 AND bank_code = $2', [id, BANK_CODE]);
    if (!current.rows.length) return res.status(404).json({ error: 'Data rekonsiliasi tidak ditemukan' });
    const statusBefore = current.rows[0].recon_status;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE recon_results SET recon_status = $2, notes = COALESCE($3, notes), matching_method = 'MANUAL_RESOLUTION', updated_at = NOW() WHERE id = $1`,
        [id, status, notes]
      );
      const username = req.user?.username || null;
      await client.query(
        `INSERT INTO recon_action_logs (recon_result_id, action, status_before, status_after, notes, created_by)
         VALUES ($1,'resolve',$2,$3,$4,$5)`,
        [id, statusBefore, status, notes, username]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const logsRes = await pool.query('SELECT * FROM recon_action_logs WHERE recon_result_id = $1 ORDER BY created_at DESC', [id]);
    res.json({ success: true, id, status_before: statusBefore, status_after: status, action_logs: logsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/resolution-history?date=
// ─────────────────────────────────────────────────────────────────────────
async function resolutionHistoryHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json([]);
    const r = await pool.query(
      `SELECT l.*, r.id_transaksi, r.fp_bill_info1, r.bank_beneficiary_account
       FROM recon_action_logs l
       JOIN recon_results r ON r.id = l.recon_result_id
       JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE b.business_date = $1 AND b.bank_code = $2 AND r.bank_code = $2
       ORDER BY l.created_at DESC LIMIT 200`,
      [date, BANK_CODE]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri-bifast/:id/logs
// ─────────────────────────────────────────────────────────────────────────
async function actionLogsHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });
    const r = await pool.query('SELECT * FROM recon_action_logs WHERE recon_result_id = $1 ORDER BY created_at DESC', [id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  dailyReportHandler,
  transactionsHandler,
  rawBankHandler,
  rawFpHandler,
  exportHandler,
  resolveHandler,
  actionLogsHandler,
  resolutionHistoryHandler,
  // exported utk unit test (backend/scripts/test-reconciliation-bri-bifast.js)
  buildTransactionsQuery,
  mapResultRow,
  dedupeBriBifastResultsByCanonicalKey,
  computeBriBifastResultQualityChecks,
  computeBriBifastActionableException,
  computeBriBifastHealthStatus,
  computeBriBifastRawDiagnostics,
  BRI_BIFAST_HEALTH_THRESHOLDS,
  BANK_CODE,
  DEFAULT_ACCOUNT_NO,
};
