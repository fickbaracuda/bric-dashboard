/**
 * Rekonsiliasi BNI — War Room Rekonsiliasi > BNI
 *
 * MODUL BARU, TERPISAH dari Rekonsiliasi OCBC/Mandiri/BRI/BRI BI-FAST
 * existing — TIDAK mengubah route/adapter/matching engine bank lain sama
 * sekali.
 *
 * Sumber: 2 sheet Google Sheet ("Data FP", "Data Bank BNI") — spreadsheet ID
 * dari Script Property BNI_SPREADSHEET_ID (fallback getActiveSpreadsheet()),
 * TIDAK di-hardcode di sini maupun di Apps Script.
 *
 * Bagian dari "Reconciliation Core Engine" bersama bank lain — REUSE tabel
 * recon_sync_batches/recon_fp_transactions/recon_bank_transactions/
 * recon_results/recon_action_logs (bank_code = 'BNI'), REUSE helper dasar
 * dari warroom-reconciliation.js. Logic ekstraksi+klasifikasi+matching
 * KHUSUS BNI ada di backend/src/reconciliation/bniAdapter.js (pure
 * function, di-unit-test di backend/scripts/test-reconciliation-bni.js).
 *
 * Beda mendasar dari bank lain: matching key = DATA FP.id_transaksi ==
 * transaction ID hasil EKSTRAKSI dari Description (2 sumber independen:
 * hash "BMS_SNAP API #<10 digit>" & 10 digit terakhir referensi setelah
 * "/"), BUKAN Reference No./bill_info1 langsung. scope_mode default
 * FP_COVERAGE_WINDOW (Data FP bisa berupa potongan waktu — mutasi bank di
 * luar rentang waktu FP ± toleransi TIDAK PERNAH otomatis BANK_ONLY).
 */

const pool = require('../db');
const periodicBalanceNeeds = require('../reconciliation/periodicBalanceNeeds');
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
  todayJakarta,
} = require('./warroom-reconciliation');
const {
  isBniFpCandidate, extractBniIdentifiers, classifyBniBankRow, parseBniDateTime, formatDateJakartaBni,
  computeBniCoverage, classifyBniCoverageStatus, buildBniBankGroups, reconcileBniTransactions,
  applyBniReversalCrossDateLookup, buildBniBankFingerprint,
  DEFAULT_FEE_BNI, DEFAULT_GRACE_MINUTES, DEFAULT_COVERAGE_TOLERANCE_BEFORE_MINUTES,
  DEFAULT_COVERAGE_TOLERANCE_AFTER_MINUTES, DEFAULT_MATCHING_TIME_TOLERANCE_MINUTES,
  DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES, DEFAULT_REVERSAL_LOOKUP_DAYS,
} = require('../reconciliation/bniAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dgn war-room lain, bukan token baru
const BANK_CODE = 'BNI';

const BNI_HEALTH_THRESHOLDS = {
  GREEN_MIN_MATCH_RATE: 0.99,
  YELLOW_MIN_MATCH_RATE: 0.95,
  ID_CONFLICT_MATERIAL_COUNT: 5,
  MALFORMED_ID_MATERIAL_COUNT: 5,
  IMPOSSIBLE_TIME_ORDER_MATERIAL_COUNT: 5,
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
function dedupeBniResultsByCanonicalKey(results) {
  const map = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key || `__row_${r.id}`;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()];
}

const CONSUMED_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'REVERSAL', 'DUPLICATE_BANK'];

function computeBniResultQualityChecks(results) {
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

  const idConflictCount = results.filter(r => r.id_conflict).length;
  const missingIdInsideCoverageCount = results.filter(r =>
    r.recon_status === 'NEED_REVIEW' && !r.id_transaksi && r.coverage_status === 'INSIDE_FP_COVERAGE' && !r.id_conflict
  ).length;
  const impossibleTimeOrderCount = results.filter(r => r.time_order_status === 'IMPOSSIBLE_ORDER').length;
  const malformedDatetimeCount = results.filter(r => r.fp_time_response === null && r.id_transaksi !== null).length;

  return {
    duplicate_canonical_result_count: duplicateCanonicalResultCount,
    consumed_also_bank_only_count: consumedAlsoBankOnlyCount,
    id_conflict_count: idConflictCount,
    missing_transaction_id_inside_coverage_count: missingIdInsideCoverageCount,
    impossible_time_order_count: impossibleTimeOrderCount,
    malformed_datetime_count: malformedDatetimeCount,
  };
}

/**
 * Actionable Exception — dihitung BACKEND. HANYA 9 EXCEPTION_STATUSES,
 * dedupe by canonical key. TIDAK PERNAH menghitung MATCHED/MATCHED_NO_FEE
 * (bukan exception) — FUNDING_CREDIT/OUT_OF_SCOPE/OUTSIDE_FP_COVERAGE
 * TIDAK PERNAH menghasilkan recon_results sama sekali (lihat bniAdapter.js),
 * jadi otomatis tidak pernah ikut terhitung di sini.
 */
function computeBniActionableException(results) {
  const rows = results.filter(r => EXCEPTION_STATUSES.includes(r.recon_status));
  const nominal = rows.reduce((s, r) => s + Number(r.fp_nominal !== null ? r.fp_nominal : (r.bank_total_debit || 0)), 0);
  return { count: rows.length, nominal };
}

/** Diagnostics dari recon_bank_transactions MENTAH (funding, extraction, coverage, duplicate id). */
function computeBniRawDiagnostics(bankRows) {
  let highConf = 0, mediumConf = 0, conflictConf = 0, noneConf = 0;
  let fundingCount = 0, fundingTotal = 0;
  let outsideCoverageCount = 0;
  const debitIdCounts = new Map();
  let fundingFirst = null, fundingLast = null;

  for (const r of bankRows) {
    if (r.extraction_confidence === 'HIGH') highConf++;
    else if (r.extraction_confidence === 'MEDIUM') mediumConf++;
    else if (r.extraction_confidence === 'CONFLICT') conflictConf++;
    else if (r.extraction_confidence === 'NONE') noneConf++;

    if (r.bank_row_type === 'FUNDING_CREDIT') {
      fundingCount++;
      fundingTotal += Number(r.credit || 0);
      const t = r.transaction_date_time ? new Date(r.transaction_date_time) : null;
      if (t) {
        if (!fundingFirst || t.getTime() < fundingFirst.getTime()) fundingFirst = t;
        if (!fundingLast || t.getTime() > fundingLast.getTime()) fundingLast = t;
      }
    }
    if (r.coverage_status === 'OUTSIDE_FP_COVERAGE') outsideCoverageCount++;
    if (r.bank_row_type === 'FASTPAY_DEBIT' && r.extracted_transaction_id) {
      debitIdCounts.set(r.extracted_transaction_id, (debitIdCounts.get(r.extracted_transaction_id) || 0) + 1);
    }
  }
  const duplicateBankTransactionIdCount = [...debitIdCounts.values()].filter(c => c > 1).length;

  return {
    high_confidence_count: highConf, medium_confidence_count: mediumConf,
    conflict_confidence_count: conflictConf, none_confidence_count: noneConf,
    funding_credit_count: fundingCount, funding_credit_total: fundingTotal,
    funding_first_time: fundingFirst, funding_last_time: fundingLast,
    outside_coverage_bank_count: outsideCoverageCount,
    duplicate_bank_transaction_id_count: duplicateBankTransactionIdCount,
  };
}

/** Health Status BNI — threshold terpusat, RED dievaluasi dulu, lalu YELLOW, fallback GREEN. Funding credit & outside-coverage TIDAK PERNAH memengaruhi health (spec eksplisit). */
function computeBniHealthStatus({
  validMatchRateTransaction, actionableExceptionCount, syncStatus,
  duplicateCanonicalResultCount, consumedAlsoBankOnlyCount, idConflictCount,
  missingIdInsideCoverageCount, impossibleTimeOrderCount, extractionMediumRatio,
}) {
  const T = BNI_HEALTH_THRESHOLDS;
  const syncFailed = syncStatus !== 'success';
  const rate = validMatchRateTransaction;

  if (
    syncFailed ||
    (rate !== null && rate < T.YELLOW_MIN_MATCH_RATE) ||
    duplicateCanonicalResultCount > 0 ||
    consumedAlsoBankOnlyCount > 0 ||
    idConflictCount >= T.ID_CONFLICT_MATERIAL_COUNT ||
    missingIdInsideCoverageCount >= T.MALFORMED_ID_MATERIAL_COUNT ||
    impossibleTimeOrderCount >= T.IMPOSSIBLE_TIME_ORDER_MATERIAL_COUNT
  ) {
    return 'RED';
  }

  if (
    (rate !== null && rate < T.GREEN_MIN_MATCH_RATE) ||
    actionableExceptionCount > 0 ||
    idConflictCount > 0 ||
    missingIdInsideCoverageCount > 0 ||
    impossibleTimeOrderCount > 0 ||
    (extractionMediumRatio !== null && extractionMediumRatio > T.EXTRACTION_MEDIUM_MATERIAL_RATIO)
  ) {
    return 'YELLOW';
  }

  return 'GREEN';
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bni/sync
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

  const scopeMode = body.config?.scope_mode === 'FULL_BUSINESS_DATE' ? 'FULL_BUSINESS_DATE' : 'FP_COVERAGE_WINDOW';
  const expectedFee = Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : DEFAULT_FEE_BNI;
  const graceMinutes = Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : DEFAULT_GRACE_MINUTES;
  const coverageToleranceBeforeMinutes = Number.isFinite(Number(body.config?.coverage_tolerance_before_minutes))
    ? Number(body.config.coverage_tolerance_before_minutes) : DEFAULT_COVERAGE_TOLERANCE_BEFORE_MINUTES;
  const coverageToleranceAfterMinutes = Number.isFinite(Number(body.config?.coverage_tolerance_after_minutes))
    ? Number(body.config.coverage_tolerance_after_minutes) : DEFAULT_COVERAGE_TOLERANCE_AFTER_MINUTES;
  const matchingTimeToleranceMinutes = Number.isFinite(Number(body.config?.matching_time_tolerance_minutes))
    ? Number(body.config.matching_time_tolerance_minutes) : DEFAULT_MATCHING_TIME_TOLERANCE_MINUTES;
  const bankBeforeFpToleranceMinutes = Number.isFinite(Number(body.config?.bank_before_fp_tolerance_minutes))
    ? Number(body.config.bank_before_fp_tolerance_minutes) : DEFAULT_BANK_BEFORE_FP_TOLERANCE_MINUTES;
  const reversalLookupDays = Number.isFinite(Number(body.config?.reversal_lookup_days)) ? Number(body.config.reversal_lookup_days) : DEFAULT_REVERSAL_LOOKUP_DAYS;
  // BNI TIDAK punya kolom nomor rekening di file mutasi -- account_no HANYA
  // dari konfigurasi eksplisit (Script Property BNI_ACCOUNT_NO -> body).
  // NULL kalau belum dikonfigurasi (spec: JANGAN menggagalkan rekonsiliasi).
  const accountNo = nullIfEmpty(body.account_no);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${BANK_CODE}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches
         (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name,
          account_no, scope_mode, expected_fee, grace_period_minutes,
          coverage_tolerance_before_minutes, coverage_tolerance_after_minutes,
          mismatch_time_tolerance_minutes, bank_posting_before_fp_tolerance_minutes, reversal_lookup_days,
          fp_row_count, bank_row_count, synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,0,NOW(),$16,'pending',$17)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = EXCLUDED.account_no, scope_mode = EXCLUDED.scope_mode,
         expected_fee = EXCLUDED.expected_fee, grace_period_minutes = EXCLUDED.grace_period_minutes,
         coverage_tolerance_before_minutes = EXCLUDED.coverage_tolerance_before_minutes,
         coverage_tolerance_after_minutes = EXCLUDED.coverage_tolerance_after_minutes,
         mismatch_time_tolerance_minutes = EXCLUDED.mismatch_time_tolerance_minutes,
         bank_posting_before_fp_tolerance_minutes = EXCLUDED.bank_posting_before_fp_tolerance_minutes,
         reversal_lookup_days = EXCLUDED.reversal_lookup_days,
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $17::jsonb <> '{}'::jsonb THEN $17::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, BANK_CODE, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'Data FP', nullIfEmpty(body.bank_sheet_name) || 'Data Bank BNI',
        accountNo, scopeMode, expectedFee, graceMinutes,
        coverageToleranceBeforeMinutes, coverageToleranceAfterMinutes,
        matchingTimeToleranceMinutes, bankBeforeFpToleranceMinutes, reversalLookupDays,
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
      await client.query(
        `INSERT INTO recon_fp_transactions (batch_id, id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          batchId, idTransaksi, cleanNum(row.nominal), nullIfEmpty(row.id_produk),
          parseBniDateTime(row.time_response),
          nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }
    if (fpSkippedInvalid > 0) {
      console.warn(`reconciliation-bni sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) utk business_date ${businessDate}`);
    }

    // Insert RAW bank rows dulu (kolom hasil ekstraksi/klasifikasi/coverage
    // SENGAJA belum diisi -- butuh SELURUH FP batch ini utk hitung coverage
    // window, baru bisa dihitung di chunk TERAKHIR, lihat bawah).
    let bankInserted = 0, bankSkippedDuplicateFingerprint = 0;
    for (const row of bankRowsRaw) {
      const description = nullIfEmpty(row.description);
      const debit = cleanNum(row.debit);
      const credit = cleanNum(row.credit);
      const branch = nullIfEmpty(row.branch);
      const journalNo = nullIfEmpty(row.journal_no);
      const postDateTime = parseBniDateTime(row.post_date);
      const valueDateTimeRaw = parseBniDateTime(row.value_date);
      const valueDateTime = valueDateTimeRaw || postDateTime; // fallback ke Post Date kalau Value Date kosong
      const businessDateRow = formatDateJakartaBni(valueDateTime);

      const fingerprint = buildBniBankFingerprint({
        bankCode: BANK_CODE, postDateRaw: nullIfEmpty(row.post_date), valueDateRaw: nullIfEmpty(row.value_date),
        branch, journalNo, description, debit, credit,
      });

      const insertRes = await client.query(
        `INSERT INTO recon_bank_transactions
           (batch_id, business_date, transaction_date_time, effective_date_time, branch, sequence_no,
            description, debit, credit, row_fingerprint, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (row_fingerprint) WHERE row_fingerprint IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          batchId, businessDateRow, postDateTime, valueDateTime, branch, journalNo,
          description, debit, credit, fingerprint,
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      if (insertRes.rows.length) bankInserted++;
      else bankSkippedDuplicateFingerprint++;
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({
        success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal,
        fp_rows_inserted: fpInserted, bank_rows_inserted: bankInserted, engine_run: false,
      });
    }

    // ── Chunk terakhir: classification pass (butuh SELURUH FP batch ini utk
    // hitung coverage window), lalu jalankan engine. ──
    const [fpAllRes, bankAllRes] = await Promise.all([
      client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]),
      client.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batchId]),
    ]);

    const fpForEngineAll = fpAllRes.rows.map(r => ({
      idTransaksi: r.id_transaksi, nominal: r.nominal !== null ? Number(r.nominal) : null,
      idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
      idOutlet: r.id_outlet, idBiller: r.id_biller,
    }));
    const fpForEngine = fpForEngineAll.filter(isBniFpCandidate);

    const coverage = computeBniCoverage(fpForEngine, coverageToleranceBeforeMinutes, coverageToleranceAfterMinutes);

    const bankForEngine = [];
    for (const r of bankAllRes.rows) {
      const description = r.description;
      const transactionDateTime = r.transaction_date_time ? new Date(r.transaction_date_time) : null;
      const debit = r.debit !== null ? Number(r.debit) : null;
      const credit = r.credit !== null ? Number(r.credit) : null;
      const extraction = extractBniIdentifiers(description);
      const coverageStatus = classifyBniCoverageStatus(transactionDateTime, coverage);
      const bankRowType = classifyBniBankRow({ description, debit, credit }, extraction, coverageStatus);

      await client.query(
        `UPDATE recon_bank_transactions SET
           transaction_id_from_hash = $2, transaction_id_from_reference = $3, extracted_transaction_id = $4,
           extraction_confidence = $5, id_conflict = $6, beneficiary_account = $7, recipient_name = $8,
           bank_row_type = $9, coverage_status = $10
         WHERE id = $1`,
        [
          r.id, extraction.transactionIdFromHash, extraction.transactionIdFromReference, extraction.extractedTransactionId,
          extraction.extractionConfidence, extraction.idConflict, extraction.beneficiaryAccount, extraction.recipientName,
          bankRowType, coverageStatus,
        ]
      );

      bankForEngine.push({
        bankCode: BANK_CODE, businessDate: r.business_date ? String(r.business_date).slice(0, 10) : null,
        description, debit, credit,
        transactionDateTime, postDateRaw: r.transaction_date_time, valueDateRaw: r.effective_date_time,
        branch: r.branch, journalNo: r.sequence_no,
        beneficiaryAccount: extraction.beneficiaryAccount, recipientName: extraction.recipientName,
        transactionIdFromHash: extraction.transactionIdFromHash, transactionIdFromReference: extraction.transactionIdFromReference,
        extractedTransactionId: extraction.extractedTransactionId, extractionConfidence: extraction.extractionConfidence,
        idConflict: extraction.idConflict, bankRowType, coverageStatus, bankFingerprint: r.row_fingerprint,
      });
    }

    const engineConfig = { expectedFee, graceMinutes, bankBeforeFpToleranceMinutes, matchingTimeToleranceMinutes };
    const results = reconcileBniTransactions(fpForEngine, bankForEngine, engineConfig, new Date());

    // Reversal cross-date lookup -- TERISOLASI, HANYA exact extracted_transaction_id.
    let finalResults = results;
    let crossDateResultCount = 0;
    if (reversalLookupDays > 0) {
      const futureRes = await client.query(
        `SELECT bt.extracted_transaction_id, bt.credit, bt.transaction_date_time, bt.business_date::text AS business_date
         FROM recon_bank_transactions bt
         JOIN recon_sync_batches sb ON sb.id = bt.batch_id
         WHERE sb.bank_code = $1 AND bt.bank_row_type = 'CREDIT_REVERSAL' AND bt.extracted_transaction_id IS NOT NULL
           AND bt.business_date > $2::date AND bt.business_date <= ($2::date + $3 * INTERVAL '1 day')`,
        [BANK_CODE, businessDate, reversalLookupDays]
      );
      if (futureRes.rows.length) {
        const futureByKey = new Map();
        for (const row of futureRes.rows) {
          const key = row.extracted_transaction_id;
          if (!futureByKey.has(key)) futureByKey.set(key, []);
          futureByKey.get(key).push({
            credit: row.credit !== null ? Number(row.credit) : null,
            transactionDateTime: row.transaction_date_time ? new Date(row.transaction_date_time) : null,
            businessDate: row.business_date,
          });
        }
        finalResults = applyBniReversalCrossDateLookup(results, futureByKey);
        crossDateResultCount = finalResults.filter(r => r.reversalLookupSource === 'CROSS_DATE_ID').length;
      }
    }

    for (const r of finalResults) {
      const canonicalKey = r.idTransaksi
        ? normalizeCanonicalKey(r.idTransaksi)
        : (r.extractedTransactionId ? `BNI_BANK::${r.extractedTransactionId}` : `BNI_REVIEW::${r.bankFingerprint}`);
      await client.query(
        `INSERT INTO recon_results
           (batch_id, bank_code, id_transaksi, canonical_transaction_key, id_outlet, id_produk, id_biller,
            fp_nominal, fp_time_response, bank_transaction_date, bank_principal, bank_fee, bank_credit, bank_total_debit,
            variance_principal, variance_fee, time_difference_seconds, time_order_status, matching_method,
            bank_beneficiary_account, recipient_name, bank_branch, bank_journal_no,
            transaction_id_from_hash, transaction_id_from_reference, extracted_transaction_id,
            extraction_confidence, id_conflict, coverage_status, is_actionable, eligible_for_match_rate,
            recon_status, aging_minutes, notes, reversal_date, reversal_amount, reversal_lookup_source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,NOW())
         ON CONFLICT (batch_id, canonical_transaction_key) DO UPDATE SET
           bank_code=EXCLUDED.bank_code, id_transaksi=EXCLUDED.id_transaksi,
           id_outlet=EXCLUDED.id_outlet, id_produk=EXCLUDED.id_produk, id_biller=EXCLUDED.id_biller,
           fp_nominal=EXCLUDED.fp_nominal, fp_time_response=EXCLUDED.fp_time_response,
           bank_transaction_date=EXCLUDED.bank_transaction_date, bank_principal=EXCLUDED.bank_principal,
           bank_fee=EXCLUDED.bank_fee, bank_credit=EXCLUDED.bank_credit, bank_total_debit=EXCLUDED.bank_total_debit,
           variance_principal=EXCLUDED.variance_principal, variance_fee=EXCLUDED.variance_fee,
           time_difference_seconds=EXCLUDED.time_difference_seconds, time_order_status=EXCLUDED.time_order_status,
           matching_method=EXCLUDED.matching_method, bank_beneficiary_account=EXCLUDED.bank_beneficiary_account,
           recipient_name=EXCLUDED.recipient_name, bank_branch=EXCLUDED.bank_branch, bank_journal_no=EXCLUDED.bank_journal_no,
           transaction_id_from_hash=EXCLUDED.transaction_id_from_hash, transaction_id_from_reference=EXCLUDED.transaction_id_from_reference,
           extracted_transaction_id=EXCLUDED.extracted_transaction_id, extraction_confidence=EXCLUDED.extraction_confidence,
           id_conflict=EXCLUDED.id_conflict, coverage_status=EXCLUDED.coverage_status,
           is_actionable=EXCLUDED.is_actionable, eligible_for_match_rate=EXCLUDED.eligible_for_match_rate,
           recon_status=EXCLUDED.recon_status, aging_minutes=EXCLUDED.aging_minutes, notes=EXCLUDED.notes,
           reversal_date=EXCLUDED.reversal_date, reversal_amount=EXCLUDED.reversal_amount,
           reversal_lookup_source=EXCLUDED.reversal_lookup_source, updated_at=NOW()`,
        [
          batchId, BANK_CODE, r.idTransaksi, canonicalKey, r.idOutlet, r.idProduk, r.idBiller,
          r.fpNominal, r.fpTimeResponse, formatDateJakartaBni(r.bankTransactionDate), r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
          r.variancePrincipal, r.varianceFee, r.timeDifferenceSeconds, r.timeOrderStatus, r.matchingMethod,
          r.beneficiaryAccount, r.recipientName, r.branch, r.journalNo,
          r.transactionIdFromHash, r.transactionIdFromReference, r.extractedTransactionId,
          r.extractionConfidence, !!r.idConflict, r.coverageStatus, true, true,
          r.reconStatus, r.agingMinutes, r.notes, r.reversalDate, r.reversalAmount, r.reversalLookupSource,
        ]
      );
    }

    const currentKeys = finalResults.map(r =>
      r.idTransaksi ? normalizeCanonicalKey(r.idTransaksi) : (r.extractedTransactionId ? `BNI_BANK::${r.extractedTransactionId}` : `BNI_REVIEW::${r.bankFingerprint}`)
    ).filter(Boolean);
    await client.query(
      `DELETE FROM recon_results WHERE batch_id = $1 AND bank_code = $2 AND canonical_transaction_key <> ALL($3::text[])`,
      [batchId, BANK_CODE, currentKeys.length ? currentKeys : ['']]
    );

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW() WHERE id = $1`,
      [batchId, fpAllRes.rows.length, bankAllRes.rows.length]
    );

    await client.query('COMMIT');
    res.json({
      success: true, batch_id: batchId, business_date: businessDate, bank_code: BANK_CODE,
      fp_row_count: fpAllRes.rows.length, bank_row_count: bankAllRes.rows.length,
      bank_rows_skipped_duplicate_fingerprint: bankSkippedDuplicateFingerprint,
      result_count: finalResults.length, cross_date_result_count: crossDateResultCount,
      coverage_start: coverage.coverageStart, coverage_end: coverage.coverageEnd,
      engine_run: true, synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation-bni sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/analytics?date=YYYY-MM-DD
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
        empty: true, message: 'Belum ada data rekonsiliasi BNI. Jalankan sync Google Sheet terlebih dahulu.',
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
        empty: true, message: 'Belum ada data rekonsiliasi BNI untuk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }
    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes, bankRowsRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT *, business_date::text AS business_date FROM recon_bank_transactions WHERE batch_id = $1', [batch.id]),
    ]);

    const rawResults = resultsRes.rows;
    const qualityChecks = computeBniResultQualityChecks(rawResults);
    const results = dedupeBniResultsByCanonicalKey(rawResults);
    const rawDiag = computeBniRawDiagnostics(bankRowsRes.rows);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const actionableException = computeBniActionableException(results);
    const validMatchRateTransaction = safeDiv(matchedCount, totalTransaksiFp);
    const validMatchRateNominal = safeDiv(matchedNominal, totalNominalFp);

    const summary = {
      total_fp: totalTransaksiFp, total_nominal_fp: totalNominalFp,
      matched_count: byStatus.MATCHED.count, matched_no_fee: byStatus.MATCHED_NO_FEE.count, matched_nominal: matchedNominal,
      pending_bank: byStatus.PENDING_BANK.count, fp_only: byStatus.FP_ONLY.count, bank_only: byStatus.BANK_ONLY.count,
      nominal_mismatch: byStatus.NOMINAL_MISMATCH.count, fee_mismatch: byStatus.FEE_MISMATCH.count,
      duplicate_fp: byStatus.DUPLICATE_FP.count, duplicate_bank: byStatus.DUPLICATE_BANK.count,
      reversal: byStatus.REVERSAL.count, need_review: byStatus.NEED_REVIEW.count,
      expected_fee: Number(batch.expected_fee) || DEFAULT_FEE_BNI,
      valid_match_rate_transaction: validMatchRateTransaction,
      valid_match_rate_nominal: validMatchRateNominal,
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
    };
    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    // Coverage window (utk Executive Summary)
    const coverage = {
      scope_mode: batch.scope_mode,
      coverage_tolerance_before_minutes: batch.coverage_tolerance_before_minutes,
      coverage_tolerance_after_minutes: batch.coverage_tolerance_after_minutes,
      outside_coverage_bank_count: rawDiag.outside_coverage_bank_count,
    };

    // Time & posting analysis (detik)
    const timeDiffs = results.map(r => r.time_difference_seconds).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sumSeconds = absDiffs.reduce((s, v) => s + v, 0);
    const average_seconds = absDiffs.length ? sumSeconds / absDiffs.length : null;
    const median_seconds = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95_seconds = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const maximum_seconds = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
    const buckets = { NORMAL: 0, WARNING: 0, DELAYED: 0, EXTREME: 0, IMPOSSIBLE_ORDER: 0 };
    for (const r of results) { if (r.time_order_status && buckets[r.time_order_status] !== undefined) buckets[r.time_order_status]++; }
    const bankEarlierCount = results.filter(r => typeof r.time_difference_seconds === 'number' && r.time_difference_seconds < 0).length;
    const lateRows = results
      .filter(r => r.time_order_status === 'EXTREME' || r.time_order_status === 'IMPOSSIBLE_ORDER')
      .sort((a, b) => Math.abs(Number(b.time_difference_seconds || 0)) - Math.abs(Number(a.time_difference_seconds || 0)))
      .slice(0, 50)
      .map(r => ({
        id_transaksi: r.id_transaksi, extracted_transaction_id: r.extracted_transaction_id,
        fp_time_response: r.fp_time_response, bank_transaction_date: r.bank_transaction_date,
        time_difference_seconds: r.time_difference_seconds, time_order_status: r.time_order_status, recon_status: r.recon_status,
      }));
    const time_analysis = {
      average_seconds, median_seconds, p95_seconds, maximum_seconds, bank_earlier_count: bankEarlierCount,
      bucket_0_60s: buckets.NORMAL, bucket_1_5min: buckets.WARNING, bucket_5_15min: buckets.DELAYED,
      bucket_over_15min: buckets.EXTREME, impossible_time_order: buckets.IMPOSSIBLE_ORDER,
      top_50_delayed: lateRows,
    };

    const extraction_summary = {
      high_confidence_count: rawDiag.high_confidence_count, medium_confidence_count: rawDiag.medium_confidence_count,
      conflict_confidence_count: rawDiag.conflict_confidence_count, none_confidence_count: rawDiag.none_confidence_count,
      id_conflict_count: qualityChecks.id_conflict_count,
    };
    const extractionMediumRatio = safeDiv(rawDiag.medium_confidence_count, rawDiag.high_confidence_count + rawDiag.medium_confidence_count + rawDiag.conflict_confidence_count + rawDiag.none_confidence_count);

    // Funding & saldo -- "Net Cash Movement", BUKAN saldo rekening aktual
    // (spec eksplisit -- file mutasi tidak punya opening/closing balance).
    const totalFastpayDebit = results.filter(r => r.recon_status !== 'REVERSAL').reduce((s, r) => s + (r.bank_principal !== null ? Number(r.bank_principal) : 0), 0)
      + results.filter(r => r.recon_status === 'REVERSAL').reduce((s, r) => s + (r.bank_principal !== null ? Number(r.bank_principal) : 0), 0);
    const totalReversalCredit = byStatus.REVERSAL.count ? results.filter(r => r.recon_status === 'REVERSAL').reduce((s, r) => s + Number(r.reversal_amount || 0), 0) : 0;
    const netCashMovement = rawDiag.funding_credit_total + totalReversalCredit - totalFastpayDebit;
    const funding_summary = {
      total_funding_credit: rawDiag.funding_credit_total,
      funding_credit_count: rawDiag.funding_credit_count,
      total_fastpay_debit: totalFastpayDebit,
      total_reversal_credit: totalReversalCredit,
      net_cash_movement: netCashMovement,
      last_topup_time: rawDiag.funding_last_time,
      disclaimer: 'Nilai ini menunjukkan arus dana berdasarkan mutasi yang tersedia dan bukan saldo rekening aktual karena data tidak memuat opening balance.',
    };

    const hasIssue = qualityChecks.duplicate_canonical_result_count > 0 || qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      id_conflict_count: qualityChecks.id_conflict_count,
      missing_transaction_id_inside_coverage_count: qualityChecks.missing_transaction_id_inside_coverage_count,
      duplicate_bank_transaction_id_count: rawDiag.duplicate_bank_transaction_id_count,
      malformed_datetime_count: qualityChecks.malformed_datetime_count,
      impossible_time_order_count: qualityChecks.impossible_time_order_count,
      funding_credit_count: rawDiag.funding_credit_count, // informasi, BUKAN error
      outside_coverage_bank_count: rawDiag.outside_coverage_bank_count, // informasi, BUKAN error
      has_issue: hasIssue,
      message: [
        qualityChecks.duplicate_canonical_result_count > 0 ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.` : null,
        qualityChecks.consumed_also_bank_only_count > 0 ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.` : null,
        qualityChecks.id_conflict_count > 0 ? `${qualityChecks.id_conflict_count} transaksi punya konflik ekstraksi ID (hash vs reference berbeda).` : null,
        rawDiag.duplicate_bank_transaction_id_count > 0 ? `${rawDiag.duplicate_bank_transaction_id_count} transaction ID dipakai lebih dari satu baris debit bank.` : null,
        qualityChecks.impossible_time_order_count > 0 ? `${qualityChecks.impossible_time_order_count} transaksi dgn urutan waktu tidak mungkin.` : null,
      ].filter(Boolean).join(' ') || null,
    };

    res.json({
      empty: false,
      meta: {
        date, bank_code: BANK_CODE, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
        account_no: batch.account_no, scope_mode: batch.scope_mode,
        expected_fee: summary.expected_fee, grace_period_minutes: batch.grace_period_minutes,
        reversal_lookup_days: batch.reversal_lookup_days,
      },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, expected_fee: summary.expected_fee, scope_mode: batch.scope_mode,
        coverage_start: null, coverage_end: null, synced_at: batch.synced_at, sync_status: batch.status,
      },
      summary, status_distribution, coverage, time_analysis, extraction_summary, funding_summary,
      data_quality_warning, recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-bni analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/daily-report?date=YYYY-MM-DD
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
        success: true, empty: true, message: 'Belum ada data rekonsiliasi BNI untuk tanggal ini.',
        generated_at: generatedAt, report_status: reportStatus, meta: { date, bank_code: BANK_CODE },
      });
    }
    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes, bankRowsRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT *, business_date::text AS business_date FROM recon_bank_transactions WHERE batch_id = $1', [batch.id]),
    ]);

    const rawResults = resultsRes.rows;
    const qualityChecks = computeBniResultQualityChecks(rawResults);
    const results = dedupeBniResultsByCanonicalKey(rawResults);
    const rawDiag = computeBniRawDiagnostics(bankRowsRes.rows);
    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_BNI;

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const validMatchRateTransaction = safeDiv(matchedCount, totalTransaksiFp);
    const validMatchRateNominal = safeDiv(matchedNominal, totalNominalFp);
    const actionableException = computeBniActionableException(results);
    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const timeDiffs = results.map(r => r.time_difference_seconds).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sumSeconds = absDiffs.reduce((s, v) => s + v, 0);
    const buckets = { NORMAL: 0, WARNING: 0, DELAYED: 0, EXTREME: 0, IMPOSSIBLE_ORDER: 0 };
    for (const r of results) { if (r.time_order_status && buckets[r.time_order_status] !== undefined) buckets[r.time_order_status]++; }
    const time_posting_summary = {
      average_seconds: absDiffs.length ? sumSeconds / absDiffs.length : null,
      median_seconds: absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null,
      maximum_seconds: absDiffs.length ? absDiffs[absDiffs.length - 1] : null,
      bucket_0_60s: buckets.NORMAL, bucket_1_5min: buckets.WARNING, bucket_5_15min: buckets.DELAYED,
      bucket_over_15min: buckets.EXTREME, impossible_time_order: buckets.IMPOSSIBLE_ORDER,
    };

    const extraction_summary = {
      high_confidence_count: rawDiag.high_confidence_count, medium_confidence_count: rawDiag.medium_confidence_count,
      conflict_confidence_count: rawDiag.conflict_confidence_count, none_confidence_count: rawDiag.none_confidence_count,
      id_conflict_count: qualityChecks.id_conflict_count,
    };
    const extractionMediumRatio = safeDiv(rawDiag.medium_confidence_count, rawDiag.high_confidence_count + rawDiag.medium_confidence_count + rawDiag.conflict_confidence_count + rawDiag.none_confidence_count);

    const totalFastpayDebit = results.reduce((s, r) => s + (r.bank_principal !== null ? Number(r.bank_principal) : 0), 0);
    const totalReversalCredit = results.filter(r => r.recon_status === 'REVERSAL').reduce((s, r) => s + Number(r.reversal_amount || 0), 0);
    const netCashMovement = rawDiag.funding_credit_total + totalReversalCredit - totalFastpayDebit;
    const funding_summary = {
      total_funding_credit: rawDiag.funding_credit_total, funding_credit_count: rawDiag.funding_credit_count,
      total_fastpay_debit: totalFastpayDebit, total_reversal_credit: totalReversalCredit,
      net_cash_movement: netCashMovement,
      disclaimer: 'Nilai ini menunjukkan arus dana berdasarkan mutasi yang tersedia dan bukan saldo rekening aktual karena data tidak memuat opening balance.',
    };

    const financial_summary = {
      total_nominal_fp: totalNominalFp, matched_nominal: matchedNominal,
      actionable_exception_nominal: actionableException.nominal, reversal_nominal: byStatus.REVERSAL.nominal,
      total_funding_credit: rawDiag.funding_credit_total, net_cash_movement: netCashMovement,
    };

    const hasIssue = qualityChecks.duplicate_canonical_result_count > 0 || qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      id_conflict_count: qualityChecks.id_conflict_count,
      missing_transaction_id_inside_coverage_count: qualityChecks.missing_transaction_id_inside_coverage_count,
      duplicate_bank_transaction_id_count: rawDiag.duplicate_bank_transaction_id_count,
      malformed_datetime_count: qualityChecks.malformed_datetime_count,
      impossible_time_order_count: qualityChecks.impossible_time_order_count,
      funding_credit_count: rawDiag.funding_credit_count,
      outside_coverage_bank_count: rawDiag.outside_coverage_bank_count,
      has_issue: hasIssue,
      message: [
        qualityChecks.duplicate_canonical_result_count > 0 ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.` : null,
        qualityChecks.consumed_also_bank_only_count > 0 ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.` : null,
        qualityChecks.id_conflict_count > 0 ? `${qualityChecks.id_conflict_count} transaksi punya konflik ekstraksi ID.` : null,
        rawDiag.duplicate_bank_transaction_id_count > 0 ? `${rawDiag.duplicate_bank_transaction_id_count} transaction ID dipakai lebih dari satu baris debit bank.` : null,
        qualityChecks.impossible_time_order_count > 0 ? `${qualityChecks.impossible_time_order_count} transaksi dgn urutan waktu tidak mungkin.` : null,
      ].filter(Boolean).join(' ') || null,
    };

    const top_10_exception = results
      .filter(r => EXCEPTION_STATUSES.includes(r.recon_status))
      .sort((a, b) => Number(b.fp_nominal !== null ? b.fp_nominal : (b.bank_total_debit || 0)) - Number(a.fp_nominal !== null ? a.fp_nominal : (a.bank_total_debit || 0)))
      .slice(0, 10)
      .map(r => ({
        id_transaksi: r.id_transaksi || null, canonical_transaction_key: r.canonical_transaction_key || null,
        extracted_transaction_id: r.extracted_transaction_id || null, recipient_name: r.recipient_name || null,
        id_outlet: r.id_outlet || null, id_produk: r.id_produk || null, id_biller: r.id_biller || null,
        recon_status: r.recon_status,
        fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
        bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
        variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
        time_difference_seconds: r.time_difference_seconds, time_order_status: r.time_order_status || null,
        matching_method: r.matching_method || null, id_conflict: !!r.id_conflict, notes: r.notes || null,
      }));

    const healthStatus = computeBniHealthStatus({
      validMatchRateTransaction, actionableExceptionCount: actionableException.count, syncStatus: batch.status,
      duplicateCanonicalResultCount: qualityChecks.duplicate_canonical_result_count,
      consumedAlsoBankOnlyCount: qualityChecks.consumed_also_bank_only_count,
      idConflictCount: qualityChecks.id_conflict_count,
      missingIdInsideCoverageCount: qualityChecks.missing_transaction_id_inside_coverage_count,
      impossibleTimeOrderCount: qualityChecks.impossible_time_order_count,
      extractionMediumRatio,
    });

    // ── Ringkasan otomatis Direktur — deterministic, TANPA AI ──
    const pctMatch = validMatchRateTransaction !== null ? (validMatchRateTransaction * 100).toFixed(2).replace('.', ',') : '-';
    const exceptionStatusesPresent = RECON_STATUSES.filter(s => EXCEPTION_STATUSES.includes(s) && byStatus[s].count > 0);
    const lines = [];
    lines.push(`Per ${formatWibLong(new Date())}, sebanyak ${fmtNumId(matchedCount)} dari ${fmtNumId(totalTransaksiFp)} transaksi BNI telah berhasil direkonsiliasi dengan valid match rate sebesar ${pctMatch}%.`);
    lines.push(
      actionableException.count > 0
        ? `Terdapat ${fmtNumId(actionableException.count)} transaksi yang memerlukan tindak lanjut dengan nilai terdampak ${fmtRpId(actionableException.nominal)}.`
        : 'Tidak ada transaksi exception yang perlu ditindaklanjuti.'
    );
    if (exceptionStatusesPresent.length > 0) {
      lines.push(`Ditemukan ${joinWithDan(exceptionStatusesPresent.map(s => `${fmtNumId(byStatus[s].count)} transaksi ${s}`))}.`);
    }
    lines.push(`Total funding credit hari ini ${fmtRpId(rawDiag.funding_credit_total)} (${fmtNumId(rawDiag.funding_credit_count)} top-up), net cash movement ${fmtRpId(netCashMovement)}.`);
    if (hasIssue) lines.push(`PERHATIAN: ${data_quality_warning.message}`);
    lines.push(`Status kesehatan rekonsiliasi hari ini adalah ${healthStatus}.`);
    const ringkasan_direktur = lines.join(' ');

    const rekomendasi = [];
    if (hasIssue) rekomendasi.push('Segera periksa & bersihkan data quality issue (duplikat canonical/consumed juga bank only) sebelum laporan difinalisasi.');
    if (batch.status !== 'success') rekomendasi.push('Sinkronisasi batch ini belum berstatus sukses — cek Apps Script/Execution Log dan jalankan sync ulang.');
    if (actionableException.count > 0) rekomendasi.push(`Tindak lanjuti ${fmtNumId(actionableException.count)} transaksi exception senilai ${fmtRpId(actionableException.nominal)} melalui tab Exception Queue.`);
    if (qualityChecks.id_conflict_count > 0) rekomendasi.push(`Periksa manual ${fmtNumId(qualityChecks.id_conflict_count)} transaksi dgn konflik ekstraksi ID (hash vs reference berbeda).`);
    if (rawDiag.duplicate_bank_transaction_id_count > 0) rekomendasi.push(`Periksa ${fmtNumId(rawDiag.duplicate_bank_transaction_id_count)} transaction ID yang dipakai lebih dari satu baris debit bank.`);
    if (qualityChecks.impossible_time_order_count > 0) rekomendasi.push(`Periksa ${fmtNumId(qualityChecks.impossible_time_order_count)} transaksi dgn urutan waktu tidak mungkin (bank posting jauh sebelum FP).`);
    if (validMatchRateTransaction !== null && validMatchRateTransaction < BNI_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE) {
      rekomendasi.push('Match rate di bawah target 99% — eskalasi ke tim terkait untuk investigasi lebih lanjut.');
    }
    if (rekomendasi.length === 0) rekomendasi.push('Tidak ada tindak lanjut mendesak — seluruh transaksi FP telah berhasil direkonsiliasi dgn BNI.');

    res.json({
      success: true, empty: false,
      generated_at: generatedAt, report_status: reportStatus, health_status: healthStatus,
      meta: { date, bank_code: BANK_CODE, batch_no: batch.batch_no, last_sync: batch.synced_at },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, expected_fee: expectedFee, scope_mode: batch.scope_mode,
        synced_at: batch.synced_at, sync_status: batch.status,
      },
      summary: {
        total_fp: totalTransaksiFp, total_nominal_fp: totalNominalFp, matched_transaksi: matchedCount, matched_nominal: matchedNominal,
        valid_match_rate_transaction: validMatchRateTransaction, valid_match_rate_nominal: validMatchRateNominal,
        actionable_exception_count: actionableException.count, actionable_exception_nominal: actionableException.nominal,
      },
      financial_summary, funding_summary, time_posting_summary, extraction_summary,
      coverage: {
        scope_mode: batch.scope_mode,
        coverage_tolerance_before_minutes: batch.coverage_tolerance_before_minutes,
        coverage_tolerance_after_minutes: batch.coverage_tolerance_after_minutes,
        outside_coverage_bank_count: rawDiag.outside_coverage_bank_count,
      },
      data_quality_warning, status_distribution, top_10_exception,
      ringkasan_direktur, rekomendasi_tindak_lanjut: rekomendasi,
    });
  } catch (e) {
    console.error('reconciliation-bni daily-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', extracted_transaction_id: 'extracted_transaction_id',
  fp_nominal: 'fp_nominal', bank_principal: 'bank_principal', bank_fee: 'bank_fee',
  variance_principal: 'variance_principal', variance_fee: 'variance_fee', aging_minutes: 'aging_minutes',
  time_difference_seconds: 'time_difference_seconds', recon_status: 'recon_status',
  fp_time_response: 'fp_time_response', bank_transaction_date: 'bank_transaction_date', updated_at: 'updated_at',
};

function buildTransactionsQuery(req) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const status = nullIfEmpty(req.query.status);
  const idOutlet = nullIfEmpty(req.query.id_outlet);
  const idProduk = nullIfEmpty(req.query.id_produk);
  const idBiller = nullIfEmpty(req.query.id_biller);
  const idTransaksi = nullIfEmpty(req.query.id_transaksi);
  const beneficiaryAccount = nullIfEmpty(req.query.beneficiary_account);
  const recipientName = nullIfEmpty(req.query.recipient_name);
  const journalNo = nullIfEmpty(req.query.journal_no);
  const coverageStatus = nullIfEmpty(req.query.coverage_status);
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
  if (idTransaksi) { params.push(idTransaksi); conditions.push(`r.id_transaksi = $${params.length}`); }
  if (beneficiaryAccount) { params.push(beneficiaryAccount); conditions.push(`r.bank_beneficiary_account = $${params.length}`); }
  if (recipientName) { params.push(`%${recipientName}%`); conditions.push(`r.recipient_name ILIKE $${params.length}`); }
  if (journalNo) { params.push(journalNo); conditions.push(`r.bank_journal_no = $${params.length}`); }
  if (coverageStatus) { params.push(coverageStatus); conditions.push(`r.coverage_status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.extracted_transaction_id ILIKE $${params.length} OR r.recipient_name ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length} OR r.id_produk ILIKE $${params.length})`);
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
    id: r.id, business_date: r.business_date,
    id_transaksi: r.id_transaksi, id_outlet: r.id_outlet, id_produk: r.id_produk, id_biller: r.id_biller,
    account_no: r.batch_account_no || null,
    fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null, fp_time_response: r.fp_time_response,
    bank_transaction_date: r.bank_transaction_date,
    bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
    bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    bank_total_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
    time_difference_seconds: r.time_difference_seconds, time_order_status: r.time_order_status,
    branch: r.bank_branch, journal_no: r.bank_journal_no,
    beneficiary_account: r.bank_beneficiary_account, recipient_name: r.recipient_name,
    transaction_id_from_hash: r.transaction_id_from_hash, transaction_id_from_reference: r.transaction_id_from_reference,
    extracted_transaction_id: r.extracted_transaction_id, extraction_confidence: r.extraction_confidence,
    id_conflict: r.id_conflict, matching_method: r.matching_method, coverage_status: r.coverage_status,
    recon_status: r.recon_status, aging_minutes: r.aging_minutes, notes: r.notes,
    reversal_date: r.reversal_date, reversal_amount: r.reversal_amount !== null ? Number(r.reversal_amount) : null,
    reversal_lookup_source: r.reversal_lookup_source, updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/raw-fp & /raw-bank
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
      `SELECT id, id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data
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
      `SELECT id, transaction_date_time, effective_date_time, branch, sequence_no, description, debit, credit,
              transaction_id_from_hash, transaction_id_from_reference, extracted_transaction_id, extraction_confidence,
              id_conflict, beneficiary_account, recipient_name, bank_row_type, coverage_status, row_fingerprint,
              source_row_number, raw_data
       FROM recon_bank_transactions WHERE batch_id = $1 ORDER BY source_row_number ASC NULLS LAST LIMIT $2 OFFSET $3`,
      [batchId, limit, offset]
    );
    res.json({ meta: { page, limit, total: Number(countRes.rows[0]?.total || 0) }, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/export — CSV
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
      'business_date', 'id_transaksi', 'id_outlet', 'id_produk', 'id_biller', 'account_no',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal', 'bank_fee',
      'bank_credit', 'bank_total_debit', 'variance_principal', 'variance_fee',
      'time_difference_seconds', 'time_order_status', 'branch', 'journal_no',
      'beneficiary_account', 'recipient_name', 'transaction_id_from_hash', 'transaction_id_from_reference',
      'extracted_transaction_id', 'extraction_confidence', 'id_conflict', 'matching_method', 'coverage_status',
      'recon_status', 'aging_minutes', 'notes', 'reversal_date', 'reversal_amount', 'reversal_lookup_source',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-bni-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bni/:id/resolve
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
// GET /api/warroom/reconciliation/bni/resolution-history?date=
// ─────────────────────────────────────────────────────────────────────────
async function resolutionHistoryHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json([]);
    const r = await pool.query(
      `SELECT l.*, r.id_transaksi, r.extracted_transaction_id, r.recipient_name
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
// GET /api/warroom/reconciliation/bni/:id/logs
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

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bni/balance-needs-periodic
// Tab "Kebutuhan Saldo" — wrapper TIPIS: hanya mengunci bank_code='BNI' dan
// memanggil shared service (backend/src/reconciliation/
// periodicBalanceNeeds.js, referensi utama = implementasi OCBC). TIDAK ADA
// rumus/matching logic BNI yang disentuh di sini. `bank_specific` diisi
// via computeBniFundingComparison() — HANYA utk BNI (spec eksplisit:
// funding credit BUKAN kebutuhan saldo, cuma info pembanding tambahan).
// ─────────────────────────────────────────────────────────────────────────
async function balanceNeedsPeriodicHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const result = await periodicBalanceNeeds.buildBalanceNeedsResponse({
      pool, bankCode: 'BNI', startDate, endDate,
      enrichBankSpecific: periodicBalanceNeeds.computeBniFundingComparison,
    });
    res.status(result.statusCode).json(result.body);
  } catch (e) {
    console.error('reconciliation-bni balance-needs-periodic error:', e.message);
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
  balanceNeedsPeriodicHandler,
  resolutionHistoryHandler,
  // exported utk unit test (backend/scripts/test-reconciliation-bni.js)
  buildTransactionsQuery,
  mapResultRow,
  dedupeBniResultsByCanonicalKey,
  computeBniResultQualityChecks,
  computeBniActionableException,
  computeBniHealthStatus,
  computeBniRawDiagnostics,
  BNI_HEALTH_THRESHOLDS,
  BANK_CODE,
};
