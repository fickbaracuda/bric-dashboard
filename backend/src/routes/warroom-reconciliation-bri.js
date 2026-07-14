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
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
} = require('./warroom-reconciliation');
const {
  classifyBriRow, parseBriTransactionTime, formatDateJakartaBri, parseFlexibleBriDateTime,
  reconcileBriTransactions, applyBriReversalCrossDateLookup, validateBriBalance, buildBriFingerprint,
  DEFAULT_FEE_BRI, DEFAULT_GRACE_MINUTES, DEFAULT_COVERAGE_TOLERANCE_MINUTES, DEFAULT_REVERSAL_LOOKUP_DAYS,
} = require('../reconciliation/briAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dgn war-room lain, bukan token baru
const BANK_CODE = 'BRI';

function timeDelayBucket(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  const abs = Math.abs(minutes);
  if (abs <= 5) return 'normal';
  if (abs <= 15) return 'warning';
  if (abs <= 30) return 'delayed';
  return 'exception';
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

    const batchRes = await pool.query('SELECT * FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2', [date, BANK_CODE]);
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi BRI utk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankScopeRes, bankBalanceRes, bankIdCountRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query(
        `SELECT bank_row_type, COUNT(*) AS c FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY bank_row_type`,
        [batch.id]
      ),
      pool.query('SELECT balance_check_status, COUNT(*) AS c, COALESCE(SUM(balance_variance),0) AS variance FROM recon_bank_transactions WHERE batch_id = $1 GROUP BY balance_check_status', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT extracted_transaction_id) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND extracted_transaction_id IS NOT NULL', [batch.id]),
    ]);
    const results = resultsRes.rows;

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

    const quality = {
      id_conflict_count: results.filter(r => r.id_conflict).length,
      duplicate_canonical_result_count: 0, // dijaga 0 lewat UNIQUE(batch_id, canonical_transaction_key)
      consumed_also_bank_only_count: 0, // dijaga 0 lewat consumedBankKeys di briAdapter.js
      cross_date_result_count: results.filter(r => r.reversal_lookup_source === 'CROSS_DATE_LOOKUP').length,
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
      summary, status_distribution, coverage, fee_analysis, time_analysis, balance_validation, quality,
      recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-bri analytics error:', e.message);
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

module.exports = {
  syncHandler,
  analyticsHandler,
  transactionsHandler,
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
};
