/**
 * Rekonsiliasi BRI — War Room Rekonsiliasi > Rekonsiliasi BRI
 *
 * Sumber: 2 sheet Google Sheet ("DATA FP", "DATA BRI") — spreadsheet diambil
 * dari Script Property BRI_SPREADSHEET_ID (fallback getActiveSpreadsheet()),
 * TIDAK di-hardcode di sini maupun di Apps Script.
 *
 * Bagian dari "Reconciliation Core Engine" bersama Rekonsiliasi OCBC &
 * Mandiri — REUSE tabel recon_sync_batches/recon_fp_transactions/
 * recon_bank_transactions/recon_results/recon_action_logs (bank_code =
 * 'BRI'), REUSE helper dasar dari warroom-reconciliation.js. Logic
 * ekstraksi+klasifikasi+matching KHUSUS BRI ada di
 * backend/src/reconciliation/briAdapter.js (reconcileBriTransactions, dkk,
 * pure function, di-unit-test di backend/scripts/test-reconciliation-bri.js).
 *
 * Beda mendasar dari Mandiri/OCBC: 1 mutasi BRI = 1 baris debit (principal+
 * fee DIGABUNG, bukan 2 baris terpisah), ID transaksi diekstrak dari 3
 * sumber teks (DESK_TRAN/TRREMK/TLBDS2) yang wajib konsisten, dan statement
 * BRI mencampur SEMUA jenis mutasi rekening (bukan sheet khusus FASTPAY) —
 * mutasi non-FASTPAY WAJIB di-set OUT_OF_SCOPE (disimpan mentah, tidak
 * pernah masuk Exception Queue/match rate).
 */

const pool = require('../db');
const periodicBalanceNeeds = require('../reconciliation/periodicBalanceNeeds');
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
  todayJakarta,
} = require('./warroom-reconciliation');
const {
  classifyBriRow, parseBriTransactionTime, formatDateJakartaBri, parseFlexibleBriDateTime,
  reconcileBriTransactions, applyBriReversalCrossDateLookup, validateBriBalance, buildBriFingerprint,
  DEFAULT_FEE_BRI, DEFAULT_GRACE_MINUTES, DEFAULT_COVERAGE_TOLERANCE_MINUTES, DEFAULT_REVERSAL_LOOKUP_DAYS,
} = require('../reconciliation/briAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dgn war-room lain, bukan token baru
const BANK_CODE = 'BRI';

// Threshold health status terpusat (spec: "Threshold wajib terpusat dan
// terdokumentasi"). Angka MATERIAL (id conflict/unbalanced/outside coverage)
// dipilih supaya sejumlah KECIL kejadian (mis. 1-4 ID conflict) menurunkan
// status dari GREEN tapi TIDAK langsung RED — hanya kalau jumlahnya besar
// (berpotensi mengindikasikan masalah sistemik, bukan kasus tepi biasa)
// status naik jadi RED. Lihat computeBriHealthStatus().
const BRI_HEALTH_THRESHOLDS = {
  GREEN_MIN_MATCH_RATE: 0.99,
  YELLOW_MIN_MATCH_RATE: 0.95,
  ID_CONFLICT_MATERIAL_COUNT: 5,
  UNBALANCED_MATERIAL_COUNT: 5,
  OUTSIDE_COVERAGE_MATERIAL_RATIO: 0.05,
};

function timeDelayBucket(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  const abs = Math.abs(minutes);
  if (abs <= 5) return 'normal';
  if (abs <= 15) return 'warning';
  if (abs <= 30) return 'delayed';
  return 'exception';
}

// Status hasil yang berarti "grup bank sudah DIPASANGKAN/dikonsumsi" oleh
// suatu transaksi FP — dipakai utk deteksi consumed_also_bank_only_count.
const CONSUMED_STATUSES = ['MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH', 'NOMINAL_MISMATCH', 'REVERSAL', 'DUPLICATE_BANK'];

/**
 * Dedupe hasil berdasarkan canonical_transaction_key — PERTAHANAN TAMBAHAN
 * di luar UNIQUE(batch_id, canonical_transaction_key) DB (spec: "Jangan
 * hanya mengandalkan unique index. Diagnostic tetap harus ditampilkan").
 * Baris PERTAMA per key dipertahankan. Baris tanpa canonical key (null)
 * masing-masing dianggap unik (fallback __row_<id>).
 */
function dedupeBriResultsByCanonicalKey(results) {
  const map = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key || `__row_${r.id}`;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()];
}

/**
 * Quality checks berbasis `recon_results` (SEBELUM dedupe, spec: kasus
 * consumed+bank_only harus tetap terdeteksi dari data mentah) —
 * invalid_business_date_count, duplicate_canonical_result_count,
 * consumed_also_bank_only_count. PURE (tidak menyentuh DB).
 */
function computeBriResultQualityChecks(results, businessDate) {
  const invalidBusinessDateCount = results.filter(r =>
    r.bank_transaction_date !== null && r.bank_transaction_date !== businessDate &&
    r.reversal_lookup_source !== 'CROSS_DATE_LOOKUP'
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

  return {
    invalid_business_date_count: invalidBusinessDateCount,
    duplicate_canonical_result_count: duplicateCanonicalResultCount,
    consumed_also_bank_only_count: consumedAlsoBankOnlyCount,
  };
}

/**
 * Actionable Exception — dipindah dari frontend ke backend (spec). Hanya 9
 * EXCEPTION_STATUSES, dedupe by canonical key, TIDAK PERNAH menghitung
 * OUTSIDE_FP_COVERAGE (dijamin ganda: engine briAdapter.js sendiri tidak
 * pernah memasukkan grup OUTSIDE_FP_COVERAGE ke `results`, filter di sini
 * murni pertahanan berlapis eksplisit). Nominal: fp_nominal, fallback
 * bank_total_debit (gross debit) utk BANK_ONLY yang tidak punya fp_nominal.
 */
function computeBriActionableException(results) {
  const rows = results.filter(r =>
    EXCEPTION_STATUSES.includes(r.recon_status) && r.coverage_status !== 'OUTSIDE_FP_COVERAGE'
  );
  const nominal = rows.reduce((s, r) => s + Number(r.fp_nominal !== null ? r.fp_nominal : (r.bank_total_debit || 0)), 0);
  return { count: rows.length, nominal };
}

/**
 * Health Status BRI — threshold terpusat di BRI_HEALTH_THRESHOLDS. RED
 * dievaluasi LEBIH DULU, lalu YELLOW, fallback GREEN (spec eksplisit).
 * Cross-date reversal VALID (reversal_lookup_source=CROSS_DATE_LOOKUP)
 * BUKAN kondisi RED/YELLOW apa pun di sini — itu fitur bisnis, bukan
 * masalah data (lihat cross_date_reversal_count, dilaporkan terpisah,
 * TIDAK pernah masuk input fungsi ini).
 */
function computeBriHealthStatus({
  validMatchRateTransaction, actionableExceptionCount, syncStatus,
  invalidBusinessDateCount, duplicateCanonicalResultCount, consumedAlsoBankOnlyCount,
  idConflictCount, unbalancedBankRowCount, extractionMediumCount, outsideCoverageRatio, hasPostingDelay,
}) {
  const T = BRI_HEALTH_THRESHOLDS;
  const syncFailed = syncStatus !== 'success';
  const rate = validMatchRateTransaction;

  if (
    syncFailed ||
    (rate !== null && rate < T.YELLOW_MIN_MATCH_RATE) ||
    invalidBusinessDateCount > 0 ||
    duplicateCanonicalResultCount > 0 ||
    consumedAlsoBankOnlyCount > 0 ||
    idConflictCount >= T.ID_CONFLICT_MATERIAL_COUNT ||
    unbalancedBankRowCount >= T.UNBALANCED_MATERIAL_COUNT
  ) {
    return 'RED';
  }

  if (
    (rate !== null && rate < T.GREEN_MIN_MATCH_RATE) ||
    actionableExceptionCount > 0 ||
    hasPostingDelay ||
    extractionMediumCount > 0 ||
    idConflictCount > 0 ||
    unbalancedBankRowCount > 0 ||
    (outsideCoverageRatio !== null && outsideCoverageRatio > T.OUTSIDE_COVERAGE_MATERIAL_RATIO)
  ) {
    return 'YELLOW';
  }

  return 'GREEN';
}

function fmtNumId(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
function fmtRpId(n) {
  return `Rp ${Math.round(Number(n || 0)).toLocaleString('id-ID')}`;
}
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

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bri/sync
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
  const expectedFee = Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : DEFAULT_FEE_BRI;
  const graceMinutes = Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : DEFAULT_GRACE_MINUTES;
  const coverageToleranceMinutes = Number.isFinite(Number(body.config?.coverage_tolerance_minutes)) ? Number(body.config.coverage_tolerance_minutes) : DEFAULT_COVERAGE_TOLERANCE_MINUTES;
  const reversalLookupDays = Number.isFinite(Number(body.config?.reversal_lookup_days)) ? Number(body.config.reversal_lookup_days) : DEFAULT_REVERSAL_LOOKUP_DAYS;
  const accountNo = nullIfEmpty(body.account_no);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${BANK_CODE}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches
         (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name,
          account_no, scope_mode, expected_fee, grace_period_minutes, coverage_tolerance_minutes,
          reversal_lookup_days, fp_row_count, bank_row_count, synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,NOW(),$13,'pending',$14)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = EXCLUDED.account_no, scope_mode = EXCLUDED.scope_mode,
         expected_fee = EXCLUDED.expected_fee, grace_period_minutes = EXCLUDED.grace_period_minutes,
         coverage_tolerance_minutes = EXCLUDED.coverage_tolerance_minutes,
         reversal_lookup_days = EXCLUDED.reversal_lookup_days,
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $14::jsonb <> '{}'::jsonb THEN $14::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, BANK_CODE, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'DATA FP', nullIfEmpty(body.bank_sheet_name) || 'DATA BRI',
        accountNo, scopeMode, expectedFee, graceMinutes, coverageToleranceMinutes, reversalLookupDays,
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
          parseFlexibleBriDateTime(row.time_response), nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }
    if (fpSkippedInvalid > 0) {
      console.warn(`reconciliation-bri sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) utk business_date ${businessDate}`);
    }

    let bankInserted = 0, bankSkippedDuplicateFingerprint = 0;
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

      const classification = classifyBriRow({ deskTran, trremk, tlbds2, mutasiDebet, mutasiKredit });
      const time = parseBriTransactionTime({ tglTran: row.tgl_tran, tglEfektif: row.tgl_efektif, jamTran: row.jam_tran });

      let balanceCheckStatus = 'UNDETERMINED', balanceVariance = null;
      if (saldoAwal !== null && saldoAkhir !== null) {
        const expected = saldoAwal - (mutasiDebet || 0) + (mutasiKredit || 0);
        balanceVariance = saldoAkhir - expected;
        balanceCheckStatus = Math.abs(balanceVariance) <= 1 ? 'BALANCED' : 'UNBALANCED';
      }

      const fingerprint = buildBriFingerprint({
        bankCode: BANK_CODE, norek,
        tglTranNormalized: formatDateJakartaBri(time.transactionDateTime),
        tglEfektifNormalized: time.businessDate,
        seq, deskTran, mutasiDebet, mutasiKredit, saldoAkhirMutasi: saldoAkhir,
      });

      const insertRes = await client.query(
        `INSERT INTO recon_bank_transactions
           (batch_id, account_no, business_date, transaction_date_time, effective_date_time,
            sequence_no, description, remarks, tlbds1, tlbds2, opening_balance, debit, credit, balance,
            gl_sign, tr_user, kode_tran, kode_tran_teller,
            extracted_transaction_id, bank_row_type, extraction_method, extraction_confidence, id_conflict,
            balance_check_status, balance_variance, row_fingerprint, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         ON CONFLICT (row_fingerprint) WHERE row_fingerprint IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          batchId, norek, time.businessDate, time.transactionDateTime, time.effectiveDateTime,
          seq, deskTran, trremk, tlbds1, tlbds2, saldoAwal, mutasiDebet, mutasiKredit, saldoAkhir,
          nullIfEmpty(row.glsign), nullIfEmpty(row.truser), nullIfEmpty(row.kode_tran), nullIfEmpty(row.kode_tran_teller),
          classification.extractedTransactionId, classification.bankRowType, classification.extractionMethod,
          classification.extractionConfidence, classification.idConflict,
          balanceCheckStatus, balanceVariance, fingerprint,
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

    // Chunk terakhir -> jalankan engine atas SELURUH data batch ini.
    const [fpAllRes, bankAllRes] = await Promise.all([
      client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]),
      client.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batchId]),
    ]);

    const fpForEngine = fpAllRes.rows.map(r => ({
      idTransaksi: r.id_transaksi, nominal: r.nominal !== null ? Number(r.nominal) : null,
      idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
      idOutlet: r.id_outlet, idBiller: r.id_biller,
    }));
    const bankForEngine = bankAllRes.rows.map(r => ({
      norek: r.account_no, mutasiDebet: r.debit !== null ? Number(r.debit) : null, mutasiKredit: r.credit !== null ? Number(r.credit) : null,
      transactionDateTime: r.transaction_date_time ? new Date(r.transaction_date_time) : null,
      businessDate: r.business_date, extractedTransactionId: r.extracted_transaction_id,
      bankRowType: r.bank_row_type, extractionMethod: r.extraction_method,
      saldoAwalMutasi: r.opening_balance !== null ? Number(r.opening_balance) : null,
      saldoAkhirMutasi: r.balance !== null ? Number(r.balance) : null,
    }));

    const { results, coverage } = reconcileBriTransactions(fpForEngine, bankForEngine, { expectedFee, graceMinutes, scopeMode, coverageToleranceMinutes }, new Date());
    const balanceValidation = validateBriBalance(bankForEngine);

    // Tandai coverage_status pada SETIAP baris raw bank (bukan cuma pada
    // recon_results) — supaya tab Raw Data & Audit bisa menampilkan status
    // coverage per baris tanpa perlu join ke recon_results (banyak baris
    // OUT_OF_SCOPE/NEED_REVIEW/UNKNOWN tidak punya recon_results sama sekali).
    if (coverage.scopeMode === 'FULL_BUSINESS_DATE') {
      await client.query(`UPDATE recon_bank_transactions SET coverage_status = 'IN_FP_COVERAGE' WHERE batch_id = $1`, [batchId]);
    } else if (coverage.coverageStart && coverage.coverageEnd) {
      await client.query(
        `UPDATE recon_bank_transactions SET coverage_status = CASE
           WHEN transaction_date_time IS NULL THEN NULL
           WHEN transaction_date_time < $2::timestamptz OR transaction_date_time > $3::timestamptz THEN 'OUTSIDE_FP_COVERAGE'
           ELSE 'IN_FP_COVERAGE'
         END WHERE batch_id = $1`,
        [batchId, coverage.coverageStart, coverage.coverageEnd]
      );
    }

    // Reversal cross-date lookup — TERISOLASI (lihat briAdapter.js), HANYA
    // query bank row dari business_date+1 s.d. +reversalLookupDays yang
    // sudah tersimpan (di-sync sebelumnya) utk rekening yang sama.
    let finalResults = results;
    let crossDateResultCount = 0;
    if (reversalLookupDays > 0) {
      const futureRes = await client.query(
        `SELECT bt.extracted_transaction_id, bt.credit, bt.transaction_date_time, bt.business_date
         FROM recon_bank_transactions bt
         JOIN recon_sync_batches sb ON sb.id = bt.batch_id
         WHERE sb.bank_code = $1 AND bt.account_no = $2 AND bt.bank_row_type = 'CREDIT_REVERSAL'
           AND bt.extracted_transaction_id IS NOT NULL
           AND bt.business_date > $3::date AND bt.business_date <= ($3::date + $4 * INTERVAL '1 day')`,
        [BANK_CODE, accountNo, businessDate, reversalLookupDays]
      );
      if (futureRes.rows.length) {
        const futureByKey = new Map();
        for (const row of futureRes.rows) {
          const key = row.extracted_transaction_id;
          if (!key) continue;
          if (!futureByKey.has(key)) futureByKey.set(key, []);
          futureByKey.get(key).push({
            mutasiKredit: row.credit !== null ? Number(row.credit) : null,
            transactionDateTime: row.transaction_date_time ? new Date(row.transaction_date_time) : null,
            businessDate: row.business_date,
          });
        }
        finalResults = applyBriReversalCrossDateLookup(results, futureByKey, { reversalLookupDays });
        crossDateResultCount = finalResults.filter(r => r.reversalLookupSource === 'CROSS_DATE_LOOKUP').length;
      }
    }

    for (const r of finalResults) {
      // canonical_transaction_key = extracted_transaction_id kalau ada
      // (transaksi yang punya pasangan/kandidat bank), else id_transaksi
      // (FP_ONLY/PENDING_BANK murni belum ada bank sama sekali) — SAMA
      // prinsip upsert dgn OCBC/Mandiri, WAJIB krn unique index recon_results
      // sekarang berbasis kolom ini (shared table lintas bank).
      const canonicalKey = normalizeCanonicalKey(r.extractedTransactionId) || normalizeCanonicalKey(r.idTransaksi);
      await client.query(
        `INSERT INTO recon_results
           (batch_id, bank_code, id_transaksi, extracted_transaction_id, canonical_transaction_key, id_outlet, id_produk, id_biller,
            fp_nominal, fp_time_response, bank_transaction_date, bank_principal, estimated_bank_principal, bank_fee, bank_credit,
            bank_total_debit, variance_principal, variance_fee, time_difference_minutes, coverage_status, matching_method,
            recon_status, aging_minutes, notes, reversal_date, reversal_amount, reversal_lookup_source, id_conflict, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
         ON CONFLICT (batch_id, canonical_transaction_key) DO UPDATE SET
           bank_code = EXCLUDED.bank_code, id_transaksi = EXCLUDED.id_transaksi,
           extracted_transaction_id = EXCLUDED.extracted_transaction_id,
           id_outlet = EXCLUDED.id_outlet, id_produk = EXCLUDED.id_produk, id_biller = EXCLUDED.id_biller,
           fp_nominal = EXCLUDED.fp_nominal, fp_time_response = EXCLUDED.fp_time_response,
           bank_transaction_date = EXCLUDED.bank_transaction_date, bank_principal = EXCLUDED.bank_principal,
           estimated_bank_principal = EXCLUDED.estimated_bank_principal, bank_fee = EXCLUDED.bank_fee,
           bank_credit = EXCLUDED.bank_credit, bank_total_debit = EXCLUDED.bank_total_debit,
           variance_principal = EXCLUDED.variance_principal, variance_fee = EXCLUDED.variance_fee,
           time_difference_minutes = EXCLUDED.time_difference_minutes, coverage_status = EXCLUDED.coverage_status,
           matching_method = EXCLUDED.matching_method, recon_status = EXCLUDED.recon_status,
           aging_minutes = EXCLUDED.aging_minutes, notes = EXCLUDED.notes,
           reversal_date = EXCLUDED.reversal_date, reversal_amount = EXCLUDED.reversal_amount,
           reversal_lookup_source = EXCLUDED.reversal_lookup_source, id_conflict = EXCLUDED.id_conflict,
           updated_at = NOW()`,
        [
          batchId, BANK_CODE, r.idTransaksi, r.extractedTransactionId, canonicalKey, r.idOutlet, r.idProduk, r.idBiller,
          r.fpNominal, r.fpTimeResponse, formatDateJakartaBri(r.bankTransactionDate), r.bankPrincipal, r.estimatedBankPrincipal,
          r.bankFee, r.bankCredit, r.bankGrossDebit, r.variancePrincipal, r.varianceFee, r.timeDifferenceMinutes,
          r.coverageStatus || null, r.matchingMethod, r.reconStatus, r.agingMinutes, r.notes,
          r.reversalDate, r.reversalAmount, r.reversalLookupSource, !!r.idConflict,
        ]
      );
    }

    const currentKeys = finalResults
      .map(r => normalizeCanonicalKey(r.extractedTransactionId) || normalizeCanonicalKey(r.idTransaksi))
      .filter(Boolean);
    await client.query(
      `DELETE FROM recon_results WHERE batch_id = $1 AND bank_code = $2 AND canonical_transaction_key <> ALL($3::text[])`,
      [batchId, BANK_CODE, currentKeys.length ? currentKeys : ['']]
    );

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW(),
         raw_summary = COALESCE(raw_summary, '{}'::jsonb) || $4::jsonb WHERE id = $1`,
      [
        batchId, fpAllRes.rows.length, bankAllRes.rows.length,
        JSON.stringify({ balance_validation: balanceValidation, coverage: { scope_mode: coverage.scopeMode, coverage_start: coverage.coverageStart, coverage_end: coverage.coverageEnd } }),
      ]
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
    console.error('reconciliation-bri sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri/analytics?date=YYYY-MM-DD
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
        empty: true, message: 'Belum ada data rekonsiliasi BRI. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { date: null, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const batchRes = await pool.query(
      'SELECT *, business_date::text AS business_date FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, BANK_CODE]
    );
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi BRI utk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankScopeRes, bankBalanceRes, bankIdCountRes, extractionRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query(
        `SELECT bank_row_type, COUNT(*) AS c FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY bank_row_type`,
        [batch.id]
      ),
      pool.query('SELECT balance_check_status, COUNT(*) AS c, COALESCE(SUM(balance_variance),0) AS variance FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY balance_check_status', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT extracted_transaction_id) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND extracted_transaction_id IS NOT NULL', [batch.id]),
      pool.query(
        `SELECT extraction_confidence, extraction_method, bank_row_type, id_conflict, COUNT(*) AS c
         FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY 1,2,3,4`,
        [batch.id]
      ),
    ]);

    // Guard integritas — SAMA pola dgn Rekonsiliasi OCBC/Mandiri:
    // active_batch.business_date HARUS persis sama dgn `date` yang diminta
    // (dijamin oleh WHERE business_date=$1 di atas — cek eksplisit ini
    // murni pertahanan berlapis, gagal LANTANG bukan diam-diam mencampur data).
    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    // rawResults: SEMUA baris apa adanya (belum difilter cross-date/dedupe) —
    // dipakai HANYA utk data_quality_warning (perlu melihat duplikat/consumed
    // SEBELUM dibersihkan supaya bisa terdeteksi, spec: "Jangan hanya
    // mengandalkan unique index. Diagnostic tetap harus ditampilkan").
    const rawResults = resultsRes.rows;
    const qualityChecks = computeBriResultQualityChecks(rawResults, date);

    // "Invalid business date tidak masuk KPI" (spec) — SEMUA agregasi di
    // bawah (summary/fee_analysis/time_analysis/actionable exception) WAJIB
    // memakai `results` versi bersih ini, BUKAN rawResults. Cross-date
    // reversal VALID (CROSS_DATE_LOOKUP) tidak pernah dikecualikan di sini.
    const resultsValidDate = rawResults.filter(r =>
      r.bank_transaction_date === null || r.bank_transaction_date === date ||
      r.reversal_lookup_source === 'CROSS_DATE_LOOKUP'
    );
    // "Satu canonical_transaction_key hanya boleh dihitung satu kali" (spec) —
    // dedupe eksplisit sbg jaminan tambahan di luar unique index DB.
    const results = dedupeBriResultsByCanonicalKey(resultsValidDate);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const uniqueBankTransactionId = Number(bankIdCountRes.rows[0]?.c || 0);
    const scopeCounts = {};
    for (const r of bankScopeRes.rows) scopeCounts[r.bank_row_type || 'UNKNOWN'] = Number(r.c);
    const validFastpayRows = (scopeCounts.DEBIT_TRANSFER || 0) + (scopeCounts.CREDIT_REVERSAL || 0);
    const outOfScopeRows = scopeCounts.OUT_OF_SCOPE || 0;
    const totalBankRows = Object.values(scopeCounts).reduce((s, v) => s + v, 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const grossDebitTotal = results.reduce((s, r) => s + (r.bank_total_debit !== null ? Number(r.bank_total_debit) : 0), 0);
    const principalTotal = results.reduce((s, r) => s + (r.bank_principal !== null ? Number(r.bank_principal) : 0), 0);
    const creditTotal = results.reduce((s, r) => s + (r.bank_credit !== null ? Number(r.bank_credit) : 0), 0);
    const totalActualFee = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);
    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_BRI;
    const transactionWithFeeCount = results.filter(r => r.bank_fee !== null).length;
    const expectedTotalFee = transactionWithFeeCount * expectedFee;

    const bankOutsideCoverage = results.filter(r => r.coverage_status === 'OUTSIDE_FP_COVERAGE').length;
    const actionableException = computeBriActionableException(results);

    const summary = {
      total_fp: totalTransaksiFp,
      total_fp_nominal: totalNominalFp,
      total_bank_rows: totalBankRows,
      unique_bank_transaction_id: uniqueBankTransactionId,
      valid_fastpay_rows: validFastpayRows,
      out_of_scope_rows: outOfScopeRows,
      matched_count: byStatus.MATCHED.count,
      matched_nominal: matchedNominal,
      matched_no_fee: byStatus.MATCHED_NO_FEE.count,
      pending_bank: byStatus.PENDING_BANK.count,
      fp_only: byStatus.FP_ONLY.count,
      bank_only: byStatus.BANK_ONLY.count,
      nominal_mismatch: byStatus.NOMINAL_MISMATCH.count,
      fee_mismatch: byStatus.FEE_MISMATCH.count,
      duplicate_fp: byStatus.DUPLICATE_FP.count,
      duplicate_bank: byStatus.DUPLICATE_BANK.count,
      reversal: byStatus.REVERSAL.count,
      need_review: byStatus.NEED_REVIEW.count,
      gross_debit: grossDebitTotal,
      principal_total: principalTotal,
      fee_total: totalActualFee,
      credit_total: creditTotal,
      net_bank_movement: grossDebitTotal - creditTotal,
      valid_match_rate_transaction: safeDiv(matchedCount, totalTransaksiFp),
      valid_match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const coverageRaw = (batch.raw_summary && batch.raw_summary.coverage) || {};
    const coverage = {
      scope_mode: batch.scope_mode,
      coverage_start: coverageRaw.coverage_start || null,
      coverage_end: coverageRaw.coverage_end || null,
      fp_in_coverage: totalTransaksiFp,
      bank_in_coverage: results.filter(r => r.coverage_status !== 'OUTSIDE_FP_COVERAGE').length,
      bank_outside_coverage: bankOutsideCoverage,
    };

    // Fee analysis
    const feeRows = results.filter(r => r.bank_fee !== null);
    const feeMismatchRows = results.filter(r => r.recon_status === 'FEE_MISMATCH');
    const noFeeRows = results.filter(r => r.recon_status === 'MATCHED_NO_FEE');
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
      distribution: [
        { fee: expectedFee, count: feeRows.filter(r => Math.abs(Number(r.bank_fee) - expectedFee) < 0.5).length },
        { fee: 0, count: feeRows.filter(r => Number(r.bank_fee) === 0).length },
        { fee: 'lainnya', count: feeRows.filter(r => Math.abs(Number(r.bank_fee) - expectedFee) >= 0.5 && Number(r.bank_fee) !== 0).length },
      ],
      by_produk: groupFeeBy(r => r.id_produk),
      by_outlet: groupFeeBy(r => r.id_outlet).slice(0, 20),
      by_biller: groupFeeBy(r => r.id_biller),
    };

    // Time analysis
    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sum = absDiffs.reduce((s, v) => s + v, 0);
    const average_minutes = absDiffs.length ? sum / absDiffs.length : null;
    const median_minutes = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95_minutes = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const maximum_minutes = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
    const buckets = { normal: 0, warning: 0, delayed: 0, exception: 0 };
    for (const d of timeDiffs) {
      const b = timeDelayBucket(d);
      if (b) buckets[b]++;
    }
    const lateRows = results
      .filter(r => timeDelayBucket(r.time_difference_minutes) === 'exception')
      .sort((a, b) => Math.abs(Number(b.time_difference_minutes)) - Math.abs(Number(a.time_difference_minutes)))
      .slice(0, 50)
      .map(r => ({
        id_transaksi: r.id_transaksi, extracted_transaction_id: r.extracted_transaction_id,
        fp_time_response: r.fp_time_response, bank_transaction_date: r.bank_transaction_date,
        time_difference_minutes: r.time_difference_minutes, recon_status: r.recon_status,
      }));
    const time_analysis = {
      average_minutes, median_minutes, p95_minutes, maximum_minutes,
      bucket_0_5: buckets.normal, bucket_5_15: buckets.warning, bucket_15_30: buckets.delayed, bucket_over_30: buckets.exception,
      late_postings: lateRows,
    };

    let balancedRows = 0, unbalancedRows = 0, undeterminedRows = 0, varianceTotal = 0;
    for (const r of bankBalanceRes.rows) {
      if (r.balance_check_status === 'BALANCED') balancedRows = Number(r.c);
      else if (r.balance_check_status === 'UNBALANCED') { unbalancedRows = Number(r.c); varianceTotal = Number(r.variance); }
      else undeterminedRows += Number(r.c);
    }
    const balance_validation = {
      status: unbalancedRows > 0 ? 'UNBALANCED' : (balancedRows > 0 ? 'BALANCED' : 'UNDETERMINED'),
      balanced_rows: balancedRows, unbalanced_rows: unbalancedRows, undetermined_rows: undeterminedRows,
      total_variance: varianceTotal,
    };

    // Extraction summary — dari GROUP BY recon_bank_transactions (RAW, semua
    // baris terklasifikasi, bukan hanya yg punya recon_results — spec:
    // hitungan confidence/method/OUT_OF_SCOPE harus di level baris mentah).
    let highConf = 0, mediumConf = 0, conflictConf = 0, noneConf = 0;
    let idConflictRowCount = 0, needReviewConflictCount = 0, outOfScopeCount = 0;
    let idFromDeskTran = 0, idFromTrremk = 0, idFromTlbds2 = 0;
    for (const r of extractionRes.rows) {
      const c = Number(r.c);
      if (r.extraction_confidence === 'HIGH') highConf += c;
      else if (r.extraction_confidence === 'MEDIUM') mediumConf += c;
      else if (r.extraction_confidence === 'CONFLICT') conflictConf += c;
      else noneConf += c;
      if (r.id_conflict) idConflictRowCount += c;
      if (r.id_conflict && r.bank_row_type === 'NEED_REVIEW') needReviewConflictCount += c;
      if (r.bank_row_type === 'OUT_OF_SCOPE') outOfScopeCount += c;
      if (r.extraction_method === 'DESK_TRAN') idFromDeskTran += c;
      else if (r.extraction_method === 'TRREMK') idFromTrremk += c;
      else if (r.extraction_method === 'TLBDS2') idFromTlbds2 += c;
    }
    const extraction_summary = {
      high_confidence_count: highConf,
      medium_confidence_count: mediumConf,
      conflict_count: conflictConf,
      none_confidence_count: noneConf,
      id_conflict_count: idConflictRowCount,
      id_from_desk_tran_count: idFromDeskTran,
      id_from_trremk_count: idFromTrremk,
      id_from_tlbds2_count: idFromTlbds2,
      need_review_conflict_count: needReviewConflictCount,
      out_of_scope_count: outOfScopeCount,
    };

    const crossDateReversalCount = results.filter(r => r.reversal_lookup_source === 'CROSS_DATE_LOOKUP').length;

    // data_quality_warning — has_issue HANYA dari 3 sinyal integritas inti
    // (spec eksplisit). ID conflict & saldo unbalanced TETAP ditampilkan
    // jelas di sini, tapi dampaknya ke health status ikut threshold
    // MATERIAL (lihat computeBriHealthStatus), bukan has_issue biner.
    const hasIssue = qualityChecks.invalid_business_date_count > 0 ||
      qualityChecks.duplicate_canonical_result_count > 0 ||
      qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      invalid_business_date_count: qualityChecks.invalid_business_date_count,
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      id_conflict_count: idConflictRowCount,
      unbalanced_bank_row_count: unbalancedRows,
      has_issue: hasIssue,
      message: [
        qualityChecks.invalid_business_date_count > 0
          ? `Ditemukan ${qualityChecks.invalid_business_date_count} baris hasil dgn bank_transaction_date di luar tanggal ${date} (data stale, dikecualikan otomatis dari KPI).`
          : null,
        qualityChecks.duplicate_canonical_result_count > 0
          ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.`
          : null,
        qualityChecks.consumed_also_bank_only_count > 0
          ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.`
          : null,
        idConflictRowCount > 0 ? `${idConflictRowCount} mutasi memiliki konflik ekstraksi ID antar DESK_TRAN/TRREMK/TLBDS2.` : null,
        unbalancedRows > 0 ? `${unbalancedRows} baris mutasi tidak balance (saldo awal-debit+kredit != saldo akhir).` : null,
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
        coverage_tolerance_minutes: batch.coverage_tolerance_minutes, reversal_lookup_days: batch.reversal_lookup_days,
      },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, synced_at: batch.synced_at, sync_status: batch.status,
      },
      summary, status_distribution, coverage, fee_analysis, time_analysis, balance_validation,
      extraction_summary, cross_date_reversal_count: crossDateReversalCount, data_quality_warning,
      recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-bri analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri/daily-report?date=YYYY-MM-DD
// Laporan Harian — ringkasan siap-cetak utk Direktur (tab "Laporan Harian" di
// WarRoomReconciliationBri.jsx). BEDA MENDASAR dari analyticsHandler: TIDAK
// PERNAH fallback ke batch tanggal terakhir kalau tanggal yang diminta/hari
// ini belum ada batch-nya — default date = HARI INI (Asia/Jakarta).
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
        message: 'Belum ada data rekonsiliasi BRI untuk tanggal ini.',
        generated_at: generatedAt, report_status: reportStatus,
        meta: { date, bank_code: BANK_CODE },
      });
    }

    // Guard integritas — SAMA pola dgn analyticsHandler & OCBC/Mandiri.
    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes, bankScopeRes, bankBalanceRes, extractionRes, bankIdCountRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT bank_row_type, COUNT(*) AS c FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY bank_row_type', [batch.id]),
      pool.query('SELECT balance_check_status, COUNT(*) AS c, COALESCE(SUM(balance_variance),0) AS variance FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY balance_check_status', [batch.id]),
      pool.query('SELECT extraction_confidence, extraction_method, bank_row_type, id_conflict, COUNT(*) AS c FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY 1,2,3,4', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT extracted_transaction_id) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND extracted_transaction_id IS NOT NULL', [batch.id]),
    ]);
    const uniqueBankTransactionId = Number(bankIdCountRes.rows[0]?.c || 0);

    const rawResults = resultsRes.rows;
    const qualityChecks = computeBriResultQualityChecks(rawResults, date);
    const resultsValidDate = rawResults.filter(r =>
      r.bank_transaction_date === null || r.bank_transaction_date === date ||
      r.reversal_lookup_source === 'CROSS_DATE_LOOKUP'
    );
    const results = dedupeBriResultsByCanonicalKey(resultsValidDate);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);

    const scopeCounts = {};
    for (const r of bankScopeRes.rows) scopeCounts[r.bank_row_type || 'UNKNOWN'] = Number(r.c);
    const validFastpayRows = (scopeCounts.DEBIT_TRANSFER || 0) + (scopeCounts.CREDIT_REVERSAL || 0);
    const outOfScopeRows = scopeCounts.OUT_OF_SCOPE || 0;
    const totalBankRows = Object.values(scopeCounts).reduce((s, v) => s + v, 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const grossDebitTotal = results.reduce((s, r) => s + (r.bank_total_debit !== null ? Number(r.bank_total_debit) : 0), 0);
    const totalActualFee = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);
    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_BRI;
    const transactionWithFeeCount = results.filter(r => r.bank_fee !== null).length;
    const expectedTotalFee = transactionWithFeeCount * expectedFee;
    const bankOnlyRows = results.filter(r => r.recon_status === 'BANK_ONLY');
    const bankOnlyGrossDebit = bankOnlyRows.reduce((s, r) => s + (r.bank_total_debit !== null ? Number(r.bank_total_debit) : 0), 0);
    const bankOnlyEstimatedPrincipal = bankOnlyRows.reduce((s, r) => s + (r.estimated_bank_principal !== null ? Number(r.estimated_bank_principal) : 0), 0);
    const nominalMismatchAbs = results
      .filter(r => r.recon_status === 'NOMINAL_MISMATCH')
      .reduce((s, r) => s + Math.abs(Number(r.fp_nominal || 0) - Number(r.bank_total_debit || 0)), 0);

    const validMatchRateTransaction = safeDiv(matchedCount, totalTransaksiFp);
    const validMatchRateNominal = safeDiv(matchedNominal, totalNominalFp);
    const actionableException = computeBriActionableException(results);

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const bankOutsideCoverage = results.filter(r => r.coverage_status === 'OUTSIDE_FP_COVERAGE').length;
    const coverageRaw = (batch.raw_summary && batch.raw_summary.coverage) || {};
    const coverage_summary = {
      scope_mode: batch.scope_mode,
      coverage_start: coverageRaw.coverage_start || null,
      coverage_end: coverageRaw.coverage_end || null,
      coverage_tolerance_minutes: batch.coverage_tolerance_minutes,
      bank_in_coverage: results.filter(r => r.coverage_status !== 'OUTSIDE_FP_COVERAGE').length,
      bank_outside_coverage: bankOutsideCoverage,
      out_of_scope_rows: outOfScopeRows,
      fastpay_rows_in_scope: validFastpayRows,
    };
    const outsideCoverageRatio = totalBankRows > 0 ? bankOutsideCoverage / totalBankRows : null;

    let highConf = 0, mediumConf = 0, conflictConf = 0, noneConf = 0;
    let idConflictRowCount = 0, needReviewConflictCount = 0, outOfScopeExtractionCount = 0;
    let idFromDeskTran = 0, idFromTrremk = 0, idFromTlbds2 = 0;
    for (const r of extractionRes.rows) {
      const c = Number(r.c);
      if (r.extraction_confidence === 'HIGH') highConf += c;
      else if (r.extraction_confidence === 'MEDIUM') mediumConf += c;
      else if (r.extraction_confidence === 'CONFLICT') conflictConf += c;
      else noneConf += c;
      if (r.id_conflict) idConflictRowCount += c;
      if (r.id_conflict && r.bank_row_type === 'NEED_REVIEW') needReviewConflictCount += c;
      if (r.bank_row_type === 'OUT_OF_SCOPE') outOfScopeExtractionCount += c;
      if (r.extraction_method === 'DESK_TRAN') idFromDeskTran += c;
      else if (r.extraction_method === 'TRREMK') idFromTrremk += c;
      else if (r.extraction_method === 'TLBDS2') idFromTlbds2 += c;
    }
    const extraction_summary = {
      high_confidence_count: highConf, medium_confidence_count: mediumConf,
      conflict_count: conflictConf, none_confidence_count: noneConf,
      id_conflict_count: idConflictRowCount,
      id_from_desk_tran_count: idFromDeskTran, id_from_trremk_count: idFromTrremk, id_from_tlbds2_count: idFromTlbds2,
      need_review_conflict_count: needReviewConflictCount, out_of_scope_count: outOfScopeExtractionCount,
    };

    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sumMinutes = absDiffs.reduce((s, v) => s + v, 0);
    const average_minutes = absDiffs.length ? sumMinutes / absDiffs.length : null;
    const median_minutes = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95_minutes = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const maximum_minutes = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
    const buckets = { normal: 0, warning: 0, delayed: 0, exception: 0 };
    for (const d of timeDiffs) { const b = timeDelayBucket(d); if (b) buckets[b]++; }
    const time_posting_summary = {
      average_minutes, median_minutes, p95_minutes, maximum_minutes,
      bucket_0_5: buckets.normal, bucket_5_15: buckets.warning, bucket_15_30: buckets.delayed, bucket_over_30: buckets.exception,
    };
    const hasPostingDelay = buckets.exception > 0;

    let balancedRows = 0, unbalancedRows = 0, undeterminedRows = 0, varianceTotal = 0;
    for (const r of bankBalanceRes.rows) {
      if (r.balance_check_status === 'BALANCED') balancedRows = Number(r.c);
      else if (r.balance_check_status === 'UNBALANCED') { unbalancedRows = Number(r.c); varianceTotal = Number(r.variance); }
      else undeterminedRows += Number(r.c);
    }
    const totalBalanceRowsChecked = balancedRows + unbalancedRows + undeterminedRows;
    const balance_validation = {
      status: unbalancedRows > 0 ? 'UNBALANCED' : (balancedRows > 0 ? 'BALANCED' : 'UNDETERMINED'),
      total_rows_checked: totalBalanceRowsChecked,
      balanced_rows: balancedRows, unbalanced_rows: unbalancedRows, undetermined_rows: undeterminedRows,
      total_variance: varianceTotal,
      pct_balanced: safeDiv(balancedRows, totalBalanceRowsChecked),
    };

    const crossDateReversalCount = results.filter(r => r.reversal_lookup_source === 'CROSS_DATE_LOOKUP').length;
    const hasIssue = qualityChecks.invalid_business_date_count > 0 ||
      qualityChecks.duplicate_canonical_result_count > 0 ||
      qualityChecks.consumed_also_bank_only_count > 0;
    const data_quality_warning = {
      invalid_business_date_count: qualityChecks.invalid_business_date_count,
      duplicate_canonical_result_count: qualityChecks.duplicate_canonical_result_count,
      consumed_also_bank_only_count: qualityChecks.consumed_also_bank_only_count,
      id_conflict_count: idConflictRowCount,
      unbalanced_bank_row_count: unbalancedRows,
      has_issue: hasIssue,
      message: [
        qualityChecks.invalid_business_date_count > 0
          ? `Ditemukan ${qualityChecks.invalid_business_date_count} baris hasil dgn bank_transaction_date di luar tanggal ${date} (data stale, dikecualikan otomatis dari KPI).`
          : null,
        qualityChecks.duplicate_canonical_result_count > 0
          ? `Ditemukan ${qualityChecks.duplicate_canonical_result_count} baris hasil berbagi canonical_transaction_key yang sama.`
          : null,
        qualityChecks.consumed_also_bank_only_count > 0
          ? `Ditemukan ${qualityChecks.consumed_also_bank_only_count} canonical key yang sudah dipasangkan ke FP tapi juga muncul sbg BANK_ONLY.`
          : null,
        idConflictRowCount > 0 ? `${idConflictRowCount} mutasi memiliki konflik ekstraksi ID antar DESK_TRAN/TRREMK/TLBDS2.` : null,
        unbalancedRows > 0 ? `${unbalancedRows} baris mutasi tidak balance (saldo awal-debit+kredit != saldo akhir).` : null,
      ].filter(Boolean).join(' ') || null,
    };

    const financial_summary = {
      total_nominal_fp: totalNominalFp,
      matched_nominal: matchedNominal,
      total_gross_debit: grossDebitTotal,
      actual_fee_total: totalActualFee,
      expected_fee_total: expectedTotalFee,
      fee_variance: totalActualFee - expectedTotalFee,
      actionable_exception_nominal: actionableException.nominal,
      reversal_nominal: byStatus.REVERSAL.nominal,
      bank_only_gross_debit: bankOnlyGrossDebit,
      bank_only_estimated_principal: bankOnlyEstimatedPrincipal,
      bank_only_estimated_principal_label: 'ESTIMASI',
      nominal_mismatch_absolute: nominalMismatchAbs,
    };

    const top_10_exception = results
      .filter(r => EXCEPTION_STATUSES.includes(r.recon_status) && r.coverage_status !== 'OUTSIDE_FP_COVERAGE')
      .sort((a, b) => {
        const av = Number(a.fp_nominal !== null ? a.fp_nominal : (a.bank_total_debit || 0));
        const bv = Number(b.fp_nominal !== null ? b.fp_nominal : (b.bank_total_debit || 0));
        return bv - av;
      })
      .slice(0, 10)
      .map(r => ({
        id_transaksi: r.id_transaksi || null,
        canonical_transaction_key: r.canonical_transaction_key || null,
        id_outlet: r.id_outlet || null, id_produk: r.id_produk || null, id_biller: r.id_biller || null,
        account_no: batch.account_no,
        recon_status: r.recon_status,
        fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
        bank_gross_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
        bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
        estimated_bank_principal: r.estimated_bank_principal !== null ? Number(r.estimated_bank_principal) : null,
        bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
        variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
        variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
        time_difference_minutes: r.time_difference_minutes,
        matching_method: r.matching_method || null,
        extraction_confidence: r.extraction_confidence || null,
        id_conflict: !!r.id_conflict,
        coverage_status: r.coverage_status || null,
        reversal_lookup_source: r.reversal_lookup_source || null,
        notes: r.notes || null,
      }));

    const healthStatus = computeBriHealthStatus({
      validMatchRateTransaction, actionableExceptionCount: actionableException.count,
      syncStatus: batch.status,
      invalidBusinessDateCount: qualityChecks.invalid_business_date_count,
      duplicateCanonicalResultCount: qualityChecks.duplicate_canonical_result_count,
      consumedAlsoBankOnlyCount: qualityChecks.consumed_also_bank_only_count,
      idConflictCount: idConflictRowCount, unbalancedBankRowCount: unbalancedRows,
      extractionMediumCount: mediumConf, outsideCoverageRatio, hasPostingDelay,
    });

    // ── Ringkasan otomatis Direktur — deterministic, TANPA AI/API eksternal ──
    const pctMatch = validMatchRateTransaction !== null ? (validMatchRateTransaction * 100).toFixed(2).replace('.', ',') : '-';
    const exceptionStatusesPresent = RECON_STATUSES.filter(s => EXCEPTION_STATUSES.includes(s) && byStatus[s].count > 0);
    const lines = [];
    lines.push(
      `Per ${formatWibLong(new Date())}, sebanyak ${fmtNumId(matchedCount)} dari ${fmtNumId(totalTransaksiFp)} transaksi FP telah berhasil direkonsiliasi dengan Bank BRI, dengan valid match rate sebesar ${pctMatch}%.`
    );
    lines.push(
      actionableException.count > 0
        ? `Saat ini terdapat ${fmtNumId(actionableException.count)} transaksi yang memerlukan tindak lanjut dengan nilai terdampak sebesar ${fmtRpId(actionableException.nominal)}.`
        : `Tidak ada transaksi exception yang perlu ditindaklanjuti.`
    );
    if (exceptionStatusesPresent.length > 0) {
      lines.push(`Permasalahan terbesar berasal dari ${joinWithDan(exceptionStatusesPresent)}.`);
    }
    if (byStatus.REVERSAL.count > 0) {
      lines.push(
        crossDateReversalCount > 0
          ? `Sebanyak ${fmtNumId(byStatus.REVERSAL.count)} transaksi teridentifikasi sebagai reversal, termasuk ${fmtNumId(crossDateReversalCount)} reversal yang ditemukan melalui pencarian lintas tanggal.`
          : `Sebanyak ${fmtNumId(byStatus.REVERSAL.count)} transaksi teridentifikasi sebagai reversal.`
      );
    }
    if (idConflictRowCount > 0) {
      lines.push(`Ditemukan ${fmtNumId(idConflictRowCount)} konflik ID antara DESK_TRAN, TRREMK, dan TLBDS2 yang memerlukan pemeriksaan manual.`);
    }
    if (hasIssue) {
      lines.push(`PERHATIAN: ${data_quality_warning.message}`);
    }
    lines.push(`Status kesehatan rekonsiliasi hari ini adalah ${healthStatus}.`);
    const ringkasan_direktur = lines.join(' ');

    // ── Rekomendasi tindak lanjut ──
    const rekomendasi = [];
    if (hasIssue) {
      rekomendasi.push('Segera periksa & bersihkan data quality issue (invalid business date/duplikat canonical/consumed juga bank only) sebelum laporan difinalisasi.');
    }
    if (batch.status !== 'success') {
      rekomendasi.push('Sinkronisasi batch ini belum berstatus sukses — cek Apps Script/Execution Log dan jalankan sync ulang.');
    }
    if (actionableException.count > 0) {
      rekomendasi.push(`Tindak lanjuti ${fmtNumId(actionableException.count)} transaksi exception senilai ${fmtRpId(actionableException.nominal)} melalui tab Exception Queue.`);
    }
    if (idConflictRowCount > 0) {
      rekomendasi.push(`Periksa manual ${fmtNumId(idConflictRowCount)} mutasi dgn konflik ekstraksi ID (DESK_TRAN/TRREMK/TLBDS2 tidak konsisten).`);
    }
    if (unbalancedRows > 0) {
      rekomendasi.push(`Periksa ${fmtNumId(unbalancedRows)} baris mutasi BRI yang saldonya tidak balance.`);
    }
    if (validMatchRateTransaction !== null && validMatchRateTransaction < BRI_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE) {
      rekomendasi.push('Match rate di bawah target 99% — eskalasi ke tim terkait untuk investigasi lebih lanjut.');
    }
    if (rekomendasi.length === 0) {
      rekomendasi.push('Tidak ada tindak lanjut mendesak — seluruh transaksi FP telah berhasil direkonsiliasi dgn Bank BRI.');
    }

    res.json({
      success: true, empty: false,
      generated_at: generatedAt, report_status: reportStatus, health_status: healthStatus,
      meta: { date, bank_code: BANK_CODE, batch_no: batch.batch_no, last_sync: batch.synced_at },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, synced_at: batch.synced_at, sync_status: batch.status,
      },
      total_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      total_bank_row_count: totalBankRows,
      unique_bank_transaction_id: uniqueBankTransactionId,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      valid_match_rate_transaction: validMatchRateTransaction,
      valid_match_rate_nominal: validMatchRateNominal,
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
      reversal: { count: byStatus.REVERSAL.count, nominal: byStatus.REVERSAL.nominal },
      cross_date_reversal_count: crossDateReversalCount,
      status_distribution,
      financial_summary, coverage_summary, extraction_summary, time_posting_summary, balance_validation,
      data_quality_warning,
      top_10_exception,
      ringkasan_direktur,
      rekomendasi_tindak_lanjut: rekomendasi,
    });
  } catch (e) {
    console.error('reconciliation-bri daily-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', extracted_transaction_id: 'extracted_transaction_id', fp_nominal: 'fp_nominal',
  bank_principal: 'bank_principal', bank_fee: 'bank_fee', bank_total_debit: 'bank_total_debit',
  variance_principal: 'variance_principal', variance_fee: 'variance_fee', aging_minutes: 'aging_minutes',
  time_difference_minutes: 'time_difference_minutes',
  recon_status: 'recon_status', fp_time_response: 'fp_time_response', bank_transaction_date: 'bank_transaction_date',
  updated_at: 'updated_at',
};

function buildTransactionsQuery(req) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const status = nullIfEmpty(req.query.status);
  const coverageStatus = nullIfEmpty(req.query.coverage_status);
  const idOutlet = nullIfEmpty(req.query.id_outlet);
  const idProduk = nullIfEmpty(req.query.id_produk);
  const idBiller = nullIfEmpty(req.query.id_biller);
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
  if (coverageStatus) { params.push(coverageStatus); conditions.push(`r.coverage_status = $${params.length}`); }
  if (idOutlet) { params.push(idOutlet); conditions.push(`r.id_outlet = $${params.length}`); }
  if (idProduk) { params.push(idProduk); conditions.push(`r.id_produk = $${params.length}`); }
  if (idBiller) { params.push(idBiller); conditions.push(`r.id_biller = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.extracted_transaction_id ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length} OR r.id_produk ILIKE $${params.length})`);
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
    extracted_transaction_id: r.extracted_transaction_id,
    id_outlet: r.id_outlet,
    id_produk: r.id_produk,
    id_biller: r.id_biller,
    account_no: r.batch_account_no || null,
    fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
    fp_time_response: r.fp_time_response,
    bank_transaction_date: r.bank_transaction_date,
    bank_gross_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
    estimated_bank_principal: r.estimated_bank_principal !== null ? Number(r.estimated_bank_principal) : null,
    bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
    time_difference_minutes: r.time_difference_minutes,
    coverage_status: r.coverage_status,
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    reversal_date: r.reversal_date,
    reversal_amount: r.reversal_amount !== null ? Number(r.reversal_amount) : null,
    reversal_lookup_source: r.reversal_lookup_source,
    id_conflict: r.id_conflict,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri/raw-bank & /raw-fp
// ─────────────────────────────────────────────────────────────────────────
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
              tlbds1, tlbds2, opening_balance, debit, credit, balance, gl_sign, tr_user, kode_tran, kode_tran_teller,
              extracted_transaction_id, bank_row_type, extraction_method, extraction_confidence, id_conflict,
              coverage_status, balance_check_status, balance_variance, source_row_number, raw_data
       FROM recon_bank_transactions WHERE batch_id = $1 ORDER BY source_row_number ASC NULLS LAST LIMIT $2 OFFSET $3`,
      [batchId, limit, offset]
    );
    res.json({ meta: { page, limit, total: Number(countRes.rows[0]?.total || 0) }, rows: rowsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

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

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bri/export — CSV
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
      'business_date', 'id_transaksi', 'extracted_transaction_id', 'account_no', 'id_outlet', 'id_produk', 'id_biller',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_gross_debit', 'bank_principal', 'estimated_bank_principal',
      'bank_fee', 'bank_credit', 'variance_principal', 'variance_fee', 'time_difference_minutes', 'coverage_status',
      'matching_method', 'recon_status', 'aging_minutes', 'notes', 'reversal_date', 'reversal_amount', 'reversal_lookup_source',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-bri-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bri/:id/resolve
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
// GET /api/warroom/reconciliation/bri/resolution-history?date=
// ─────────────────────────────────────────────────────────────────────────
async function resolutionHistoryHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json([]);
    const r = await pool.query(
      `SELECT l.*, r.id_transaksi, r.extracted_transaction_id
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
// GET /api/warroom/reconciliation/bri/:id/logs
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
// GET /api/warroom/reconciliation/bri/balance-needs-periodic
// Tab "Kebutuhan Saldo" — wrapper TIPIS: hanya mengunci bank_code='BRI' dan
// memanggil shared service (backend/src/reconciliation/
// periodicBalanceNeeds.js, referensi utama = implementasi OCBC). TIDAK ADA
// rumus/matching logic BRI yang disentuh di sini.
// ─────────────────────────────────────────────────────────────────────────
async function balanceNeedsPeriodicHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const result = await periodicBalanceNeeds.buildBalanceNeedsResponse({ pool, bankCode: 'BRI', startDate, endDate });
    res.status(result.statusCode).json(result.body);
  } catch (e) {
    console.error('reconciliation-bri balance-needs-periodic error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  dailyReportHandler,
  transactionsHandler,
  balanceNeedsPeriodicHandler,
  rawBankHandler,
  rawFpHandler,
  exportHandler,
  resolveHandler,
  actionLogsHandler,
  resolutionHistoryHandler,
  // exported utk unit test (backend/scripts/test-reconciliation-bri.js)
  timeDelayBucket,
  buildTransactionsQuery,
  mapResultRow,
  dedupeBriResultsByCanonicalKey,
  computeBriResultQualityChecks,
  computeBriActionableException,
  computeBriHealthStatus,
  BRI_HEALTH_THRESHOLDS,
};
