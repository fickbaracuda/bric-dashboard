'use strict';

/**
 * Reprocess 1 batch BNI yang SUDAH ADA di DB, tanpa menyentuh raw FP/raw
 * bank/sync history/action log/manual resolution — dipakai SETELAH fix bug
 * matching (mis. TIER3 UNIQUE_TIME_AMOUNT_FALLBACK) supaya data lama ikut
 * terkoreksi tanpa perlu resync ulang dari Google Sheet (yang mustahil utk
 * tanggal yang sudah lewat, krn Apps Script BNI selalu memakai tanggal HARI
 * INI, bukan tanggal spesifik).
 *
 * "Gunakan mekanisme sync/reconciliation existing" (spec) -- script ini
 * MEREUSE fungsi PURE yang SAMA dari bniAdapter.js (extractBniIdentifiers/
 * classifyBniBankRow/computeBniCoverage/classifyBniCoverageStatus/
 * reconcileBniTransactions/applyBniReversalCrossDateLookup) dan pola query
 * upsert/cleanup yang SAMA dgn "chunk terakhir" syncHandler di
 * warroom-reconciliation-bni.js -- TIDAK ada rumus matching baru ditulis
 * di sini.
 *
 * Safety:
 *   - TIDAK PERNAH menghapus/mengubah recon_fp_transactions atau
 *     recon_bank_transactions (raw data tetap utuh).
 *   - TIDAK PERNAH delete-all recon_results -- hanya baris "stale" (canonical
 *     key yang TIDAK ADA lagi di hasil baru) yang dihapus, DAN hanya kalau
 *     baris itu belum pernah punya recon_action_logs ATAU matching_method
 *     'MANUAL_RESOLUTION' (dilindungi, TIDAK PERNAH dihapus).
 *   - Idempotent -- dijalankan 2x berturut-turut menghasilkan state akhir
 *     yang SAMA (upsert ON CONFLICT, delete hanya utk yang genuinely stale).
 *   - Seluruh perubahan dalam SATU transaction (BEGIN/COMMIT, ROLLBACK kalau
 *     error).
 *
 * Run: node backend/scripts/reprocess-bni-batch.js 2026-07-22
 */

require('dotenv').config();
const pool = require('../src/db');
const {
  extractBniIdentifiers, classifyBniBankRow, formatDateJakartaBni,
  computeBniCoverage, classifyBniCoverageStatus, reconcileBniTransactions,
  applyBniReversalCrossDateLookup, DEFAULT_FEE_BNI,
} = require('../src/reconciliation/bniAdapter');
const { normalizeCanonicalKey } = require('../src/routes/warroom-reconciliation');

const BANK_CODE = 'BNI';

async function main() {
  const businessDate = process.argv[2];
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    console.error('Usage: node backend/scripts/reprocess-bni-batch.js YYYY-MM-DD');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchRes = await client.query(
      `SELECT * FROM recon_sync_batches WHERE bank_code = $1 AND business_date = $2 FOR UPDATE`,
      [BANK_CODE, businessDate]
    );
    const batch = batchRes.rows[0];
    if (!batch) {
      console.error(`Tidak ada batch BNI utk business_date ${businessDate}.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    const batchId = batch.id;
    console.log(`Batch ditemukan: id=${batchId}, business_date=${businessDate}, status=${batch.status}`);

    const expectedFee = batch.expected_fee !== null ? Number(batch.expected_fee) : DEFAULT_FEE_BNI;
    const graceMinutes = batch.grace_period_minutes !== null ? Number(batch.grace_period_minutes) : undefined;
    const coverageToleranceBeforeMinutes = batch.coverage_tolerance_before_minutes !== null ? Number(batch.coverage_tolerance_before_minutes) : undefined;
    const coverageToleranceAfterMinutes = batch.coverage_tolerance_after_minutes !== null ? Number(batch.coverage_tolerance_after_minutes) : undefined;
    const matchingTimeToleranceMinutes = batch.mismatch_time_tolerance_minutes !== null ? Number(batch.mismatch_time_tolerance_minutes) : undefined;
    const bankBeforeFpToleranceMinutes = batch.bank_posting_before_fp_tolerance_minutes !== null ? Number(batch.bank_posting_before_fp_tolerance_minutes) : undefined;
    const reversalLookupDays = batch.reversal_lookup_days !== null ? Number(batch.reversal_lookup_days) : 0;

    // ── SAMA PERSIS dgn "chunk terakhir" syncHandler -- baca SELURUH raw FP/
    // bank utk batch ini (TIDAK diubah/dihapus), re-klasifikasi bank row,
    // jalankan engine yang SAMA. ──
    const [fpAllRes, bankAllRes] = await Promise.all([
      client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]),
      client.query('SELECT * FROM recon_bank_transactions WHERE batch_id = $1', [batchId]),
    ]);
    console.log(`Raw data (TIDAK diubah): ${fpAllRes.rows.length} FP, ${bankAllRes.rows.length} bank rows.`);

    const fpForEngineAll = fpAllRes.rows.map(r => ({
      idTransaksi: r.id_transaksi, nominal: r.nominal !== null ? Number(r.nominal) : null,
      idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
      idOutlet: r.id_outlet, idBiller: r.id_biller,
    }));
    const fpForEngine = fpForEngineAll.filter(r => String(r.idBiller || '').trim() === '141');

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
    console.log('Fallback diagnostics:', results.fallbackDiagnostics);

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

    let upserted = 0;
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
      upserted++;
    }
    console.log(`Upsert selesai: ${upserted} baris (idempotent -- canonical key yang sudah ada di-update, bukan digandakan).`);

    // ── Hapus HANYA hasil "stale" (canonical key TIDAK ADA lagi di hasil
    // baru) -- DILINDUNGI: baris dgn recon_action_logs ATAU
    // matching_method='MANUAL_RESOLUTION' TIDAK PERNAH dihapus (spec
    // eksplisit). Ini PERSIS query cleanup yang sama dgn syncHandler,
    // ditambah 2 guard proteksi utk skenario reprocess batch existing. ──
    const currentKeys = finalResults.map(r =>
      r.idTransaksi ? normalizeCanonicalKey(r.idTransaksi) : (r.extractedTransactionId ? `BNI_BANK::${r.extractedTransactionId}` : `BNI_REVIEW::${r.bankFingerprint}`)
    ).filter(Boolean);

    const staleCandidates = await client.query(
      `SELECT id, canonical_transaction_key, recon_status, matching_method
       FROM recon_results
       WHERE batch_id = $1 AND bank_code = $2 AND canonical_transaction_key <> ALL($3::text[])`,
      [batchId, BANK_CODE, currentKeys.length ? currentKeys : ['']]
    );

    const protectedRows = [];
    const deletableIds = [];
    for (const row of staleCandidates.rows) {
      if (row.matching_method === 'MANUAL_RESOLUTION') { protectedRows.push(row); continue; }
      const logCheck = await client.query('SELECT 1 FROM recon_action_logs WHERE recon_result_id = $1 LIMIT 1', [row.id]);
      if (logCheck.rows.length > 0) { protectedRows.push(row); continue; }
      deletableIds.push(row.id);
    }

    if (protectedRows.length > 0) {
      console.log(`DILINDUNGI (tidak dihapus, punya action log/manual resolution): ${protectedRows.length} baris ->`, protectedRows.map(r => r.canonical_transaction_key));
    }
    if (deletableIds.length > 0) {
      const delRes = await client.query('DELETE FROM recon_results WHERE id = ANY($1::bigint[])', [deletableIds]);
      console.log(`Hasil orphan otomatis dihapus: ${delRes.rowCount} baris.`);
    } else {
      console.log('Tidak ada hasil orphan yang perlu dihapus.');
    }

    await client.query(
      `UPDATE recon_sync_batches
       SET raw_summary = COALESCE(raw_summary, '{}'::jsonb) || jsonb_build_object(
             'fallback_diagnostics', $2::jsonb,
             'reprocessed_at', $3::text
           )
       WHERE id = $1`,
      [batchId, JSON.stringify(results.fallbackDiagnostics || {}), new Date().toISOString()]
    );

    await client.query('COMMIT');
    console.log(`\nReprocess batch BNI ${businessDate} SELESAI. result_count=${finalResults.length}, cross_date_result_count=${crossDateResultCount}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reprocess GAGAL, sudah di-rollback:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
