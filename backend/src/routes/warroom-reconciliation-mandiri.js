/**
 * Rekonsiliasi Mandiri — War Room Rekonsiliasi > Rekonsiliasi Mandiri
 *
 * Sumber: 2 sheet Google Sheet ("DATA FP", "DATA Mandiri") dari spreadsheet
 * 1iGDzKsoDdcaL2Hfk2_q1y0N50KEMm2c6auaT9DhKPFc.
 *
 * Bagian dari "Reconciliation Core Engine" bersama Rekonsiliasi OCBC —
 * REUSE tabel recon_sync_batches/recon_fp_transactions/recon_bank_transactions/
 * recon_results/recon_action_logs (bank_code = 'MANDIRI'), REUSE helper dasar
 * dari warroom-reconciliation.js (parsing angka/tanggal, extractToken, dst).
 * Logic ekstraksi+matching KHUSUS Mandiri ada di
 * backend/src/reconciliation/mandiriAdapter.js (reconcileMandiriTransactions,
 * pure function, di-unit-test di backend/scripts/test-reconciliation-mandiri.js).
 */

const pool = require('../db');
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
} = require('./warroom-reconciliation');
const {
  extractMandiriRow, reconcileMandiriTransactions, validateMandiriBalance,
  numEq, DEFAULT_FEE_MANDIRI, DEFAULT_GRACE_MINUTES,
} = require('../reconciliation/mandiriAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dengan war-room lain, bukan token baru
const BANK_CODE = 'MANDIRI';

/**
 * Parser tanggal-jam fleksibel, di-ANCHOR eksplisit ke Asia/Jakarta (+07:00)
 * — TIDAK bergantung pada timezone server (server VPS ini Asia/Shanghai,
 * UTC+8, beda dari WIB). Mendukung:
 *   "2026-07-10 3:19:11" / "2026-07-10 03:19:11" (ISO-like, jam 1-2 digit)
 *   "10/07/2026 3:20" / "10/07/2026 03:20" (DD/MM/YYYY, jam 1-2 digit)
 */
function parseFlexibleDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;

  let y, mo, d, h = '0', mi = '0', se = '0';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    y = m[1]; mo = m[2]; d = m[3]; h = m[4] || '0'; mi = m[5] || '0'; se = m[6] || '0';
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) { d = m[1]; mo = m[2]; y = m[3]; h = m[4] || '0'; mi = m[5] || '0'; se = m[6] || '0'; }
  }
  if (y) {
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}+07:00`;
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const generic = new Date(s);
  return Number.isNaN(generic.getTime()) ? null : generic;
}

/**
 * Format sebuah instant (Date) sebagai "YYYY-MM-DD" dalam Asia/Jakarta —
 * BUKAN `.toISOString().slice(0,10)` yang selalu UTC, dan BUKAN pula
 * membiarkan node-pg menerima objek Date mentah utk kolom DATE (pg
 * meng-encode parameter Date pakai komponen UTC, bukan timezone lokal).
 * Insiden nyata: PostDate WIB dini hari (00:00–06:59) tersimpan sebagai
 * tanggal SEBELUMNYA di kolom DATE, karena 02:02 WIB = 19:02 UTC hari
 * sebelumnya. Dipakai tiap kali menulis ke recon_bank_transactions.
 * transaction_date / recon_results.bank_transaction_date.
 */
function formatDateJakarta(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function timeDelayBucket(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  const abs = Math.abs(minutes);
  if (abs <= 5) return 'normal';
  if (abs <= 15) return 'warning';
  if (abs <= 30) return 'delayed';
  return 'exception';
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/mandiri/sync
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
  const expectedFee = Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : DEFAULT_FEE_MANDIRI;
  const graceMinutes = Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : DEFAULT_GRACE_MINUTES;
  const accountNo = nullIfEmpty(body.account_no);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${BANK_CODE}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches
         (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name,
          account_no, scope_mode, expected_fee, grace_period_minutes, fp_row_count, bank_row_count,
          synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,NOW(),$11,'pending',$12)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = EXCLUDED.account_no, scope_mode = EXCLUDED.scope_mode,
         expected_fee = EXCLUDED.expected_fee, grace_period_minutes = EXCLUDED.grace_period_minutes,
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $12::jsonb <> '{}'::jsonb THEN $12::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, BANK_CODE, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'DATA FP', nullIfEmpty(body.bank_sheet_name) || 'DATA Mandiri',
        accountNo, scopeMode, expectedFee, graceMinutes,
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
          parseFlexibleDateTime(row.time_response), nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }
    if (fpSkippedInvalid > 0) {
      console.warn(`reconciliation-mandiri sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) untuk business_date ${businessDate}`);
    }

    let bankInserted = 0;
    for (const row of bankRowsRaw) {
      const remarks = nullIfEmpty(row.remarks);
      const additionalDesc = nullIfEmpty(row.additional_desc);
      const creditAmount = cleanNum(row.credit_amount);
      const debitAmount = cleanNum(row.debit_amount);
      const extraction = extractMandiriRow(remarks, additionalDesc, creditAmount);
      const postDateTime = parseFlexibleDateTime(row.post_date);
      await client.query(
        `INSERT INTO recon_bank_transactions
           (batch_id, transaction_date, post_date_time, description, additional_desc, debit, credit,
            close_balance, source_row_number, raw_data, account_no, currency,
            extracted_transaction_id, bank_row_type, extraction_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          batchId, formatDateJakarta(postDateTime), postDateTime,
          remarks, additionalDesc, debitAmount, creditAmount, cleanNum(row.close_balance),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
          nullIfEmpty(row.account_no) || accountNo, nullIfEmpty(row.ccy),
          extraction.extractedTransactionId, extraction.bankRowType, extraction.extractionMethod,
        ]
      );
      bankInserted++;
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({ success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal, fp_rows_inserted: fpInserted, bank_rows_inserted: bankInserted, engine_run: false });
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
      accountNo: r.account_no, currency: r.currency, postDate: r.post_date_time ? new Date(r.post_date_time) : null,
      remarks: r.description, additionalDesc: r.additional_desc,
      creditAmount: r.credit !== null ? Number(r.credit) : null, debitAmount: r.debit !== null ? Number(r.debit) : null,
      closeBalance: r.close_balance !== null ? Number(r.close_balance) : null, sourceRowNumber: r.source_row_number,
      extractedTransactionId: r.extracted_transaction_id, bankRowType: r.bank_row_type, extractionMethod: r.extraction_method,
    }));

    const results = reconcileMandiriTransactions(fpForEngine, bankForEngine, { expectedFee, graceMinutes, scopeMode }, new Date());
    const balanceValidation = validateMandiriBalance(bankForEngine);

    for (const r of results) {
      // canonical_transaction_key: SAMA formula & kolom dgn Rekonsiliasi
      // OCBC (lihat runOcbcEngineAndPersist di warroom-reconciliation.js) --
      // WAJIB, krn unique index recon_results (shared TABLE lintas bank)
      // sekarang berbasis kolom ini, bukan lagi (id_transaksi, reference_no)
      // literal. reconcileMandiriTransactions() SENDIRI TIDAK disentuh.
      const canonicalKey = normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo);
      await client.query(
        `INSERT INTO recon_results
           (batch_id, bank_code, id_transaksi, reference_no, canonical_transaction_key, id_outlet, id_produk, id_biller, fp_nominal, fp_time_response,
            bank_transaction_date, bank_principal, bank_fee, bank_credit, bank_total_debit,
            variance_principal, variance_fee, time_difference_minutes, matching_method, recon_status, aging_minutes, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
         ON CONFLICT (batch_id, canonical_transaction_key) DO UPDATE SET
           bank_code = EXCLUDED.bank_code, id_transaksi = EXCLUDED.id_transaksi, reference_no = EXCLUDED.reference_no,
           id_outlet = EXCLUDED.id_outlet, id_produk = EXCLUDED.id_produk,
           id_biller = EXCLUDED.id_biller, fp_nominal = EXCLUDED.fp_nominal, fp_time_response = EXCLUDED.fp_time_response,
           bank_transaction_date = EXCLUDED.bank_transaction_date, bank_principal = EXCLUDED.bank_principal,
           bank_fee = EXCLUDED.bank_fee, bank_credit = EXCLUDED.bank_credit, bank_total_debit = EXCLUDED.bank_total_debit,
           variance_principal = EXCLUDED.variance_principal, variance_fee = EXCLUDED.variance_fee,
           time_difference_minutes = EXCLUDED.time_difference_minutes,
           matching_method = EXCLUDED.matching_method, recon_status = EXCLUDED.recon_status,
           aging_minutes = EXCLUDED.aging_minutes, notes = EXCLUDED.notes, updated_at = NOW()`,
        [
          batchId, BANK_CODE, r.idTransaksi, r.referenceNo, canonicalKey, r.idOutlet, r.idProduk, r.idBiller, r.fpNominal, r.fpTimeResponse,
          formatDateJakarta(r.bankTransactionDate), r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
          r.variancePrincipal, r.varianceFee, r.timeDifferenceMinutes, r.matchingMethod, r.reconStatus, r.agingMinutes, r.notes,
        ]
      );
    }

    const currentKeys = results
      .map(r => normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo))
      .filter(Boolean);
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
      result_count: results.length, balance_validation: balanceValidation,
      engine_run: true, synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation-mandiri sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/mandiri/analytics?date=YYYY-MM-DD
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
        empty: true, message: 'Belum ada data rekonsiliasi Mandiri. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { date: null, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const batchRes = await pool.query(
      'SELECT * FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, BANK_CODE]
    );
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi Mandiri untuk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankIdCountRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT extracted_transaction_id) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND extracted_transaction_id IS NOT NULL', [batch.id]),
    ]);
    const results = resultsRes.rows;

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const uniqueBankTransactionId = Number(bankIdCountRes.rows[0]?.c || 0);

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
    const expectedFee = Number(batch.expected_fee) || DEFAULT_FEE_MANDIRI;
    const transactionWithFeeCount = results.filter(r => r.bank_fee !== null).length;
    const expectedTotalFee = transactionWithFeeCount * expectedFee;

    const summary = {
      total_transaksi_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      unique_bank_transaction_id: uniqueBankTransactionId,
      total_principal_bank: totalPrincipalBank,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      pending_bank_count: byStatus.PENDING_BANK.count,
      fp_only_count: byStatus.FP_ONLY.count,
      bank_only_count: byStatus.BANK_ONLY.count,
      nominal_mismatch_count: byStatus.NOMINAL_MISMATCH.count,
      fee_mismatch_count: byStatus.FEE_MISMATCH.count,
      duplicate_count: byStatus.DUPLICATE_FP.count + byStatus.DUPLICATE_BANK.count,
      reversal_count: byStatus.REVERSAL.count,
      total_actual_fee: totalActualFee,
      expected_fee: expectedFee,
      expected_total_fee: expectedTotalFee,
      fee_variance: totalActualFee - expectedTotalFee,
      match_rate_transaksi: safeDiv(matchedCount, totalTransaksiFp),
      match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

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
      transaction_without_fee_count: noFeeRows.length,
      fee_mismatch_count: feeMismatchRows.length,
      distribution: [
        { fee: expectedFee, count: feeRows.filter(r => numEq(Number(r.bank_fee), expectedFee)).length },
        { fee: 0, count: feeRows.filter(r => Number(r.bank_fee) === 0).length },
        { fee: 'lainnya', count: feeRows.filter(r => !numEq(Number(r.bank_fee), expectedFee) && Number(r.bank_fee) !== 0).length },
      ],
      by_produk: groupFeeBy(r => r.id_produk),
      by_outlet: groupFeeBy(r => r.id_outlet).slice(0, 20),
      by_biller: groupFeeBy(r => r.id_biller),
      by_account_no: groupFeeBy(() => batch.account_no),
    };

    // Time & posting analysis
    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const absDiffs = timeDiffs.map(Math.abs).sort((a, b) => a - b);
    const sum = absDiffs.reduce((s, v) => s + v, 0);
    const avg = absDiffs.length ? sum / absDiffs.length : null;
    const median = absDiffs.length ? absDiffs[Math.floor((absDiffs.length - 1) / 2)] : null;
    const p95 = absDiffs.length ? absDiffs[Math.min(absDiffs.length - 1, Math.floor(absDiffs.length * 0.95))] : null;
    const max = absDiffs.length ? absDiffs[absDiffs.length - 1] : null;
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
        id_transaksi: r.id_transaksi, fp_time_response: r.fp_time_response, bank_transaction_date: r.bank_transaction_date,
        time_difference_minutes: r.time_difference_minutes, recon_status: r.recon_status,
      }));
    const time_analysis = {
      avg_minutes: avg, median_minutes: median, p95_minutes: p95, max_minutes: max,
      bucket_0_5: buckets.normal, bucket_5_15: buckets.warning, bucket_15_30: buckets.delayed, bucket_gt_30: buckets.exception,
      late_postings: lateRows,
    };

    const balance_validation = (batch.raw_summary && batch.raw_summary.balance_validation) || null;

    res.json({
      empty: false,
      meta: {
        date, bank_code: BANK_CODE, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
        account_no: batch.account_no, scope_mode: batch.scope_mode,
        expected_fee: expectedFee, grace_period_minutes: batch.grace_period_minutes,
      },
      summary, status_distribution, fee_analysis, time_analysis, balance_validation,
      recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-mandiri analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/mandiri/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', reference_no: 'reference_no', fp_nominal: 'fp_nominal',
  bank_principal: 'bank_principal', bank_fee: 'bank_fee', bank_total_debit: 'bank_total_debit',
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
  const accountNo = nullIfEmpty(req.query.account_no);
  const search = nullIfEmpty(req.query.search);

  const conditions = ['b.bank_code = $1', "r.bank_code = $1"];
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
  if (accountNo) { params.push(accountNo); conditions.push(`b.account_no = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.reference_no ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length} OR r.id_produk ILIKE $${params.length})`);
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
    reference_no: r.reference_no,
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
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/mandiri/raw-bank & /raw-fp
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
      `SELECT id, account_no, currency, post_date_time, description AS remarks, additional_desc, debit, credit,
              close_balance, extracted_transaction_id, bank_row_type, extraction_method, source_row_number, raw_data
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
// GET /api/warroom/reconciliation/mandiri/export — CSV
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
      'business_date', 'id_transaksi', 'reference_no', 'account_no', 'id_outlet', 'id_produk', 'id_biller',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal', 'bank_fee',
      'bank_credit', 'bank_total_debit', 'variance_principal', 'variance_fee', 'time_difference_minutes',
      'matching_method', 'recon_status', 'aging_minutes', 'notes',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-mandiri-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/mandiri/:id/resolve
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
// GET /api/warroom/reconciliation/mandiri/resolution-history?date=
// Riwayat resolve (audit log) utk SELURUH batch tanggal ini — dipakai
// sub-tab "Resolution History" di Raw Data & Audit (bukan per-baris seperti
// tombol "Riwayat" di Exception Queue, tapi rekap semua aksi manual).
// ─────────────────────────────────────────────────────────────────────────
async function resolutionHistoryHandler(req, res) {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) return res.json([]);
    const r = await pool.query(
      `SELECT l.*, r.id_transaksi, r.reference_no
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
// GET /api/warroom/reconciliation/mandiri/:id/logs
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
  // exported untuk unit test (backend/scripts/test-reconciliation-mandiri.js)
  parseFlexibleDateTime,
  timeDelayBucket,
  formatDateJakarta,
};
