/**
 * Rekonsiliasi BCA — War Room Rekonsiliasi > Rekonsiliasi BCA
 *
 * Sumber: 2 sheet Google Sheet ("Data FP", "Data Bank BCA") dari spreadsheet
 * 1BkHetxYcM4FzrZIljPER5QRzTHIjRffuQ15IdyZNe3k.
 *
 * Bagian dari "Reconciliation Core Engine" bersama Rekonsiliasi OCBC —
 * REUSE tabel recon_sync_batches/recon_fp_transactions/recon_bank_transactions/
 * recon_results/recon_action_logs (bank_code = 'BCA'), REUSE helper dasar dari
 * warroom-reconciliation.js (parsing angka/tanggal, extractToken, dst).
 * Logic ekstraksi+matching KHUSUS BCA ada di
 * backend/src/reconciliation/bcaAdapter.js (reconcileBcaTransactions, pure
 * function, di-unit-test di backend/scripts/test-reconciliation-bca.js).
 *
 * BEDA dari Mandiri/BRI/BNI: BCA TIDAK punya konsep fee terpisah (satu baris
 * debit = satu transaksi FP, tanpa baris fee Rp100/Rp25 tambahan — lihat
 * catatan section 11 spec & bcaAdapter.js) dan TIDAK memakai FP coverage
 * window (scope_mode SELALU 'FULL_BUSINESS_DATE' — Data FP BCA sudah berupa
 * daftar transaksi sukses harian, tanpa perlu filter waktu tambahan).
 */

const pool = require('../db');
const periodicBalanceNeeds = require('../reconciliation/periodicBalanceNeeds');
const {
  extractToken, nullIfEmpty, cleanNum, isValidIdTransaksi,
  csvEscape, safeDiv, RECON_STATUSES, EXCEPTION_STATUSES, normalizeCanonicalKey,
  todayJakarta, toIsoDate,
} = require('./warroom-reconciliation');
const {
  parseBcaBankRow, reconcileBcaTransactions, validateBcaBalance, numEq,
} = require('../reconciliation/bcaAdapter');

const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN; // token SHARED — sama dengan war-room lain, bukan token baru
const BANK_CODE = 'BCA';

const BCA_HEALTH_THRESHOLDS = {
  GREEN_MIN_MATCH_RATE: 0.99,
  YELLOW_MIN_MATCH_RATE: 0.95,
};

/**
 * Parser tanggal-jam fleksibel utk time_response DATA FP, di-ANCHOR eksplisit
 * ke Asia/Jakarta (+07:00) — sama pola dgn warroom-reconciliation-mandiri.js.
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

function timeDelayBucket(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  const abs = Math.abs(minutes);
  if (abs <= 5) return 'normal';
  if (abs <= 15) return 'warning';
  if (abs <= 30) return 'delayed';
  return 'exception';
}

/**
 * "Satu canonical_transaction_key hanya boleh dihitung satu kali" — dedupe
 * eksplisit SEBELUM agregasi apa pun, pola sama dgn Mandiri/BNI.
 */
function dedupeBcaResultsByCanonicalKey(results) {
  const map = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key || `__row_${r.id}`;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()];
}

function computeBcaDataQualityWarning(results, businessDate) {
  const crossDateRows = results.filter(r => r.bank_transaction_date !== null && r.bank_transaction_date !== undefined && r.bank_transaction_date !== businessDate);

  const canonicalGroups = new Map();
  for (const r of results) {
    const key = r.canonical_transaction_key;
    if (!key) continue;
    if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
    canonicalGroups.get(key).push(r);
  }
  let duplicateCanonicalResultCount = 0;
  for (const rows of canonicalGroups.values()) {
    if (rows.length <= 1) continue;
    duplicateCanonicalResultCount += rows.length;
  }

  const hasIssue = crossDateRows.length > 0 || duplicateCanonicalResultCount > 0;
  const message = [
    crossDateRows.length > 0
      ? `Ditemukan ${crossDateRows.length} baris hasil rekonsiliasi dengan bank_transaction_date di luar tanggal ${businessDate} (data stale, dikecualikan otomatis dari KPI).`
      : null,
    duplicateCanonicalResultCount > 0
      ? `Ditemukan ${duplicateCanonicalResultCount} baris hasil rekonsiliasi berbagi canonical_transaction_key yang sama.`
      : null,
  ].filter(Boolean).join(' ') || null;

  return {
    cross_date_result_count: crossDateRows.length,
    duplicate_canonical_result_count: duplicateCanonicalResultCount,
    has_issue: hasIssue,
    message,
  };
}

// Exception BCA: keanggotaan EXCEPTION_STATUSES (lihat daftar BCA-specific
// yang ditambahkan ke array shared di warroom-reconciliation.js).
function computeBcaActionableException(results) {
  const rows = results.filter(r => EXCEPTION_STATUSES.includes(r.recon_status));
  const nominal = rows.reduce((s, r) => {
    const fpNominal = r.fp_nominal !== null && r.fp_nominal !== undefined ? Number(r.fp_nominal) : null;
    const fallback = r.bank_total_debit !== null && r.bank_total_debit !== undefined ? Number(r.bank_total_debit) : 0;
    return s + (fpNominal !== null ? fpNominal : fallback);
  }, 0);
  return { count: rows.length, nominal };
}

function computeBcaHealthStatus({ validMatchRateTransaction, actionableExceptionCount, dataQualityHasIssue, balanceContinuityStatus, syncStatus }) {
  const syncFailed = syncStatus !== 'success';
  const isMismatch = balanceContinuityStatus === 'BALANCE_CONTINUITY_MISMATCH';
  if (
    syncFailed ||
    (validMatchRateTransaction !== null && validMatchRateTransaction < BCA_HEALTH_THRESHOLDS.YELLOW_MIN_MATCH_RATE) ||
    dataQualityHasIssue ||
    isMismatch
  ) {
    return 'RED';
  }
  if (
    (validMatchRateTransaction !== null && validMatchRateTransaction < BCA_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE) ||
    actionableExceptionCount > 0
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
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const monthName = INDO_MONTHS[Number(map.month) - 1] || '';
  return `${Number(map.day)} ${monthName} ${map.year} pukul ${map.hour}:${map.minute} WIB`;
}
function joinWithDan(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ', dan ' + items[items.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bca/sync
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
  const accountNo = nullIfEmpty(body.account_no);
  const balanceSummary = body.balance_summary || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${BANK_CODE}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches
         (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name,
          account_no, scope_mode, fp_row_count, bank_row_count,
          synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'FULL_BUSINESS_DATE',0,0,NOW(),$8,'pending',$9)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         account_no = EXCLUDED.account_no, scope_mode = 'FULL_BUSINESS_DATE',
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $9::jsonb <> '{}'::jsonb THEN $9::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, BANK_CODE, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'Data FP', nullIfEmpty(body.bank_sheet_name) || 'Data Bank BCA',
        accountNo, nullIfEmpty(body.meta?.synced_by) || 'apps_script',
        JSON.stringify(body.raw_summary || {}),
      ]
    );
    const batchId = batchRes.rows[0].id;

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
      console.warn(`reconciliation-bca sync: ${fpSkippedInvalid} baris FP dilewati (id_transaksi bukan angka murni) untuk business_date ${businessDate}`);
    }

    let bankInserted = 0;
    for (const row of bankRowsRaw) {
      const description = nullIfEmpty(row.description);
      const parsed = parseBcaBankRow(description, row.jumlah);
      const transactionDate = toIsoDate(row.transaction_date);
      await client.query(
        `INSERT INTO recon_bank_transactions
           (batch_id, transaction_date, description, debit, credit, balance,
            source_row_number, raw_data, extracted_transaction_id, bank_row_type, extraction_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          batchId, transactionDate, description, parsed.debit, parsed.credit, cleanNum(row.balance),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify({ ...(row.raw_data || {}), branch: nullIfEmpty(row.branch), raw_jumlah: nullIfEmpty(row.jumlah), credit_classification: parsed.creditClassification, parse_warning: parsed.parseWarning }),
          parsed.extractedTransactionId, parsed.bankRowType, parsed.extractionMethod,
        ]
      );
      bankInserted++;
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({ success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal, fp_rows_inserted: fpInserted, bank_rows_inserted: bankInserted, engine_run: false });
    }

    const [fpAllRes, bankAllRes] = await Promise.all([
      client.query('SELECT * FROM recon_fp_transactions WHERE batch_id = $1', [batchId]),
      client.query('SELECT *, transaction_date::text AS transaction_date FROM recon_bank_transactions WHERE batch_id = $1', [batchId]),
    ]);

    const fpForEngine = fpAllRes.rows.map(r => ({
      idTransaksi: r.id_transaksi, nominal: r.nominal !== null ? Number(r.nominal) : null,
      idProduk: r.id_produk, timeResponse: r.time_response ? new Date(r.time_response) : null,
      idOutlet: r.id_outlet, idBiller: r.id_biller,
    }));
    const bankForEngine = bankAllRes.rows.map(r => ({
      transactionDate: r.transaction_date ? new Date(r.transaction_date) : null,
      description: r.description,
      debit: r.debit !== null ? Number(r.debit) : null, credit: r.credit !== null ? Number(r.credit) : null,
      direction: r.debit !== null && Number(r.debit) > 0 ? 'DB' : (r.credit !== null && Number(r.credit) >= 0 && r.bank_row_type === 'CREDIT' ? 'CR' : null),
      balance: r.balance !== null ? Number(r.balance) : null, sourceRowNumber: r.source_row_number,
      extractedTransactionId: r.extracted_transaction_id, bankRowType: r.bank_row_type, extractionMethod: r.extraction_method,
      creditClassification: (r.raw_data && r.raw_data.credit_classification) || null,
    }));

    const results = reconcileBcaTransactions(fpForEngine, bankForEngine, {}, new Date());
    const balanceContinuity = validateBcaBalance(bankForEngine);

    for (const r of results) {
      const canonicalKey = normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo)
        || (Number.isFinite(r.sourceRowNumber) ? normalizeCanonicalKey(`ROW_${r.sourceRowNumber}`) : null);
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
          r.bankTransactionDate ? toIsoDate(r.bankTransactionDate.toISOString ? r.bankTransactionDate.toISOString() : r.bankTransactionDate) : null,
          r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
          r.variancePrincipal, r.varianceFee, r.timeDifferenceMinutes, r.matchingMethod, r.reconStatus, r.agingMinutes, r.notes,
        ]
      );
    }

    const currentKeys = results
      .map(r => normalizeCanonicalKey(r.idTransaksi) || normalizeCanonicalKey(r.referenceNo)
        || (Number.isFinite(r.sourceRowNumber) ? normalizeCanonicalKey(`ROW_${r.sourceRowNumber}`) : null))
      .filter(Boolean);
    await client.query(
      `DELETE FROM recon_results WHERE batch_id = $1 AND bank_code = $2 AND canonical_transaction_key <> ALL($3::text[])`,
      [batchId, BANK_CODE, currentKeys.length ? currentKeys : ['']]
    );

    const currentBalance = {
      saldo_awal: Number.isFinite(Number(balanceSummary.saldo_awal)) ? Number(balanceSummary.saldo_awal) : null,
      saldo_akhir: Number.isFinite(Number(balanceSummary.saldo_akhir)) ? Number(balanceSummary.saldo_akhir) : null,
      mutasi_debet_total: Number.isFinite(Number(balanceSummary.mutasi_debet_total)) ? Number(balanceSummary.mutasi_debet_total) : null,
      mutasi_debet_count: Number.isFinite(Number(balanceSummary.mutasi_debet_count)) ? Number(balanceSummary.mutasi_debet_count) : null,
      mutasi_kredit_total: Number.isFinite(Number(balanceSummary.mutasi_kredit_total)) ? Number(balanceSummary.mutasi_kredit_total) : null,
      mutasi_kredit_count: Number.isFinite(Number(balanceSummary.mutasi_kredit_count)) ? Number(balanceSummary.mutasi_kredit_count) : null,
      source: Number.isFinite(Number(balanceSummary.saldo_akhir)) ? 'sheet_footer' : 'row_order_fallback',
    };

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW(),
         raw_summary = COALESCE(raw_summary, '{}'::jsonb) || $4::jsonb WHERE id = $1`,
      [batchId, fpAllRes.rows.length, bankAllRes.rows.length, JSON.stringify({
        balance_continuity: balanceContinuity,
        current_balance: currentBalance,
      })]
    );

    await client.query('COMMIT');
    res.json({
      success: true, batch_id: batchId, business_date: businessDate, bank_code: BANK_CODE,
      fp_row_count: fpAllRes.rows.length, bank_row_count: bankAllRes.rows.length,
      result_count: results.length, balance_continuity: balanceContinuity, current_balance: currentBalance,
      engine_run: true, synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation-bca sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bca/analytics?date=YYYY-MM-DD
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
        empty: true, message: 'Belum ada data rekonsiliasi BCA. Jalankan sync Google Sheet terlebih dahulu.',
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
        empty: true, message: 'Belum ada data rekonsiliasi BCA untuk tanggal ini.',
        meta: { date, bank_code: BANK_CODE }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankCountRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE bank_row_type = 'PRINCIPAL') AS principal_rows,
           COUNT(*) FILTER (WHERE bank_row_type = 'CREDIT') AS credit_rows,
           COUNT(*) FILTER (WHERE bank_row_type = 'UNKNOWN') AS unparseable_rows,
           COALESCE(SUM(debit) FILTER (WHERE bank_row_type = 'PRINCIPAL'), 0) AS total_debit,
           COALESCE(SUM(credit) FILTER (WHERE bank_row_type = 'CREDIT'), 0) AS total_credit
         FROM recon_bank_transactions WHERE batch_id = $1`,
        [batch.id]
      ),
    ]);

    const rawResults = resultsRes.rows;
    const dataQualityWarning = computeBcaDataQualityWarning(rawResults, date);

    if (String(batch.business_date) !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const resultsInDate = rawResults.filter(r => r.bank_transaction_date === null || r.bank_transaction_date === date);
    const results = dedupeBcaResultsByCanonicalKey(resultsInDate);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const bankCounts = bankCountRes.rows[0] || {};

    const actionableException = computeBcaActionableException(results);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'UNKNOWN';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || (r.bank_total_debit || 0));
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_AMOUNT_EXACT.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_AMOUNT_EXACT.nominal;
    const totalDebitBank = Number(bankCounts.total_debit || 0);
    const totalCreditBank = Number(bankCounts.total_credit || 0);

    const summary = {
      total_data_fp: totalTransaksiFp,
      total_mutasi_bca: Number(bankCounts.principal_rows || 0) + Number(bankCounts.credit_rows || 0) + Number(bankCounts.unparseable_rows || 0),
      matched: matchedCount,
      matched_nominal: matchedNominal,
      fp_not_found_in_bank_count: byStatus.FP_NOT_FOUND_IN_BANK.count,
      bank_not_found_in_fp_count: byStatus.BANK_NOT_FOUND_IN_FP.count,
      amount_mismatch_count: byStatus.AMOUNT_MISMATCH.count,
      duplicate_count: byStatus.DUPLICATE_FP_TRANSACTION_ID.count + byStatus.DUPLICATE_BANK_TRANSACTION_ID.count,
      unparseable_count: byStatus.UNPARSEABLE_REFERENCE.count,
      credit_count: byStatus.CREDIT_TRANSACTION.count,
      total_nominal_fp: totalNominalFp,
      total_debit_bca: totalDebitBank,
      total_credit_bca: totalCreditBank,
      selisih_nominal: totalDebitBank - totalNominalFp,
      match_rate_transaksi: safeDiv(matchedCount, totalTransaksiFp),
      match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const balanceRaw = batch.raw_summary || {};
    const balance_continuity = balanceRaw.balance_continuity || null;
    const current_balance = balanceRaw.current_balance || null;
    const saldo_bca_terakhir = current_balance?.saldo_akhir ?? balance_continuity?.latest_balance_from_order ?? null;

    // Time analysis (selisih waktu FP vs posting bank) — BCA hanya punya
    // tanggal (bukan jam), jadi selisih dalam MENIT jarang presisi tinggi;
    // tetap dihitung utk konsistensi dgn bank lain, ditandai kasar.
    const timeDiffs = results.map(r => r.time_difference_minutes).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
    const buckets = { normal: 0, warning: 0, delayed: 0, exception: 0 };
    for (const d of timeDiffs) {
      const b = timeDelayBucket(d);
      if (b) buckets[b]++;
    }

    res.json({
      empty: false,
      meta: {
        date, bank_code: BANK_CODE, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
        account_no: batch.account_no, scope_mode: batch.scope_mode,
      },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: date,
        account_no: batch.account_no, synced_at: batch.synced_at, sync_status: batch.status,
      },
      data_quality_warning: dataQualityWarning,
      summary, status_distribution,
      balance_continuity, current_balance, saldo_bca_terakhir,
      time_analysis: { bucket_0_5: buckets.normal, bucket_5_15: buckets.warning, bucket_15_30: buckets.delayed, bucket_gt_30: buckets.exception },
      recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation-bca analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bca/daily-report?date=YYYY-MM-DD
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
        message: 'Belum ada data rekonsiliasi BCA untuk tanggal ini.',
        generated_at: generatedAt, report_status: reportStatus,
        meta: { date, bank_code: BANK_CODE },
      });
    }

    if (batch.business_date !== date) {
      throw new Error(`Integrity guard gagal: active_batch.business_date (${batch.business_date}) != date diminta (${date})`);
    }

    const [resultsRes, fpCountRes] = await Promise.all([
      pool.query('SELECT *, bank_transaction_date::text AS bank_transaction_date FROM recon_results WHERE batch_id = $1 AND bank_code = $2', [batch.id, BANK_CODE]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
    ]);

    const rawResults = resultsRes.rows;
    const dataQualityWarning = computeBcaDataQualityWarning(rawResults, date);
    const resultsInDate = rawResults.filter(r => r.bank_transaction_date === null || r.bank_transaction_date === date);
    const results = dedupeBcaResultsByCanonicalKey(resultsInDate);

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'UNKNOWN';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || (r.bank_total_debit || 0));
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_AMOUNT_EXACT.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_AMOUNT_EXACT.nominal;

    const validMatchRateTransaction = safeDiv(matchedCount, totalTransaksiFp);
    const validMatchRateNominal = safeDiv(matchedNominal, totalNominalFp);
    const actionableException = computeBcaActionableException(results);

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    const balanceRaw = batch.raw_summary || {};
    const balance_continuity = balanceRaw.balance_continuity || null;
    const current_balance = balanceRaw.current_balance || null;

    const healthStatus = computeBcaHealthStatus({
      validMatchRateTransaction,
      actionableExceptionCount: actionableException.count,
      dataQualityHasIssue: dataQualityWarning.has_issue,
      balanceContinuityStatus: balance_continuity?.status || null,
      syncStatus: batch.status,
    });

    const top_10_exception = [...results]
      .filter(r => EXCEPTION_STATUSES.includes(r.recon_status))
      .sort((a, b) => {
        const av = Number(a.fp_nominal !== null ? a.fp_nominal : (a.bank_total_debit || 0));
        const bv = Number(b.fp_nominal !== null ? b.fp_nominal : (b.bank_total_debit || 0));
        return bv - av;
      })
      .slice(0, 10)
      .map(r => ({
        id_transaksi: r.id_transaksi || null, reference_no: r.reference_no || null,
        id_outlet: r.id_outlet || null, id_produk: r.id_produk || null, id_biller: r.id_biller || null,
        recon_status: r.recon_status,
        fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
        bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
        variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
        notes: r.notes || null,
      }));

    const pctMatch = validMatchRateTransaction !== null ? (validMatchRateTransaction * 100).toFixed(2) : '-';
    const balanceStatusText = balance_continuity?.status === 'BALANCE_CONTINUITY_OK' ? 'BALANCE_CONTINUITY_OK'
      : balance_continuity?.status === 'BALANCE_CONTINUITY_MISMATCH' ? 'BALANCE_CONTINUITY_MISMATCH'
      : balance_continuity?.status === 'ORDERING_UNCERTAIN' ? 'ORDERING_UNCERTAIN'
      : 'INSUFFICIENT_DATA';
    const topProblemStatuses = RECON_STATUSES
      .filter(s => EXCEPTION_STATUSES.includes(s) && byStatus[s].count > 0)
      .sort((a, b) => byStatus[b].count - byStatus[a].count)
      .slice(0, 3);

    const summaryLines = [
      `Per ${formatWibLong(new Date(generatedAt))}, sebanyak ${fmtNumId(matchedCount)} dari ${fmtNumId(totalTransaksiFp)} transaksi FP telah berhasil direkonsiliasi dengan Bank BCA, dengan valid match rate sebesar ${pctMatch}%.`,
      actionableException.count > 0
        ? `Saat ini terdapat ${fmtNumId(actionableException.count)} transaksi yang memerlukan tindak lanjut dengan nilai terdampak sebesar ${fmtRpId(actionableException.nominal)}.${topProblemStatuses.length ? ` Permasalahan terbesar berasal dari ${joinWithDan(topProblemStatuses)}.` : ''}`
        : 'Tidak ada transaksi yang memerlukan tindak lanjut pada tanggal ini.',
      `Validasi kontinuitas saldo batch berstatus ${balanceStatusText}${dataQualityWarning.has_issue ? '' : ' dan tidak ditemukan masalah integritas data'}.`,
      dataQualityWarning.has_issue ? `PERHATIAN: ditemukan masalah kualitas data — ${dataQualityWarning.message}` : null,
      `Status kesehatan rekonsiliasi hari ini: ${healthStatus}.`,
    ].filter(Boolean);
    const ringkasan_direktur = summaryLines.join(' ');

    const rekomendasi = [];
    if (dataQualityWarning.has_issue) {
      rekomendasi.push('Segera periksa & bersihkan data quality issue (cross-date/duplikat canonical) sebelum laporan difinalisasi.');
    }
    if (batch.status !== 'success') {
      rekomendasi.push('Sinkronisasi batch ini belum berstatus sukses — cek Apps Script/Execution Log dan jalankan sync ulang.');
    }
    if (balance_continuity?.status === 'BALANCE_CONTINUITY_MISMATCH') {
      rekomendasi.push('Kontinuitas saldo BALANCE_CONTINUITY_MISMATCH — periksa urutan/kelengkapan baris mutasi BCA.');
    }
    if (balance_continuity?.status === 'ORDERING_UNCERTAIN') {
      rekomendasi.push('Urutan baris mutasi BCA tidak dapat dipastikan (ORDERING_UNCERTAIN) — validasi saldo tidak konklusif, periksa manual.');
    }
    if (actionableException.count > 0) {
      rekomendasi.push(`Tindak lanjuti ${fmtNumId(actionableException.count)} transaksi exception senilai ${fmtRpId(actionableException.nominal)} melalui tab Exception Queue.`);
    }
    if (byStatus.BANK_NOT_FOUND_IN_FP.count > 0) {
      rekomendasi.push(`Periksa ${fmtNumId(byStatus.BANK_NOT_FOUND_IN_FP.count)} mutasi BCA yang tidak ditemukan padanannya di DATA FP.`);
    }
    if (validMatchRateTransaction !== null && validMatchRateTransaction < BCA_HEALTH_THRESHOLDS.GREEN_MIN_MATCH_RATE) {
      rekomendasi.push('Match rate di bawah target 99% — eskalasi ke tim terkait untuk investigasi lebih lanjut.');
    }
    if (rekomendasi.length === 0) {
      rekomendasi.push('Tidak ada tindak lanjut mendesak — seluruh transaksi FP telah berhasil direkonsiliasi.');
    }

    res.json({
      success: true, empty: false,
      generated_at: generatedAt, report_status: reportStatus, health_status: healthStatus,
      meta: { date, bank_code: BANK_CODE, batch_no: batch.batch_no, last_sync: batch.synced_at },
      active_batch: {
        batch_id: batch.id, bank_code: batch.bank_code, business_date: batch.business_date,
        account_no: batch.account_no, synced_at: batch.synced_at, sync_status: batch.status,
      },
      total_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      total_bank_row_count: batch.bank_row_count,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      valid_match_rate_transaction: validMatchRateTransaction,
      valid_match_rate_nominal: validMatchRateNominal,
      actionable_exception_count: actionableException.count,
      actionable_exception_nominal: actionableException.nominal,
      status_distribution,
      balance_continuity,
      current_balance,
      data_quality_warning: dataQualityWarning,
      top_10_exception,
      ringkasan_direktur,
      rekomendasi_tindak_lanjut: rekomendasi,
    });
  } catch (e) {
    console.error('reconciliation-bca daily-report error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bca/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', reference_no: 'reference_no', fp_nominal: 'fp_nominal',
  bank_principal: 'bank_principal', bank_total_debit: 'bank_total_debit',
  variance_principal: 'variance_principal', aging_minutes: 'aging_minutes',
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
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.reference_no ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length} OR r.notes ILIKE $${params.length})`);
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
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    bank_total_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    time_difference_minutes: r.time_difference_minutes,
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/bca/raw-bank & /raw-fp
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
      `SELECT id, transaction_date, description, debit, credit, balance,
              extracted_transaction_id, bank_row_type, extraction_method, source_row_number, raw_data
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
// GET /api/warroom/reconciliation/bca/export — CSV
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
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal',
      'bank_credit', 'bank_total_debit', 'variance_principal', 'time_difference_minutes',
      'matching_method', 'recon_status', 'aging_minutes', 'notes',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-bca-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/bca/:id/resolve
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
      return res.status(400).json({ error: 'notes (alasan override) wajib diisi utk manual override' });
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
// GET /api/warroom/reconciliation/bca/resolution-history?date=
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
// GET /api/warroom/reconciliation/bca/:id/logs
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
// GET /api/warroom/reconciliation/bca/balance-needs-periodic
// Wrapper TIPIS: hanya mengunci bank_code='BCA' dan memanggil shared
// service (backend/src/reconciliation/periodicBalanceNeeds.js).
// ─────────────────────────────────────────────────────────────────────────
async function balanceNeedsPeriodicHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    const result = await periodicBalanceNeeds.buildBalanceNeedsResponse({ pool, bankCode: 'BCA', startDate, endDate });
    res.status(result.statusCode).json(result.body);
  } catch (e) {
    console.error('reconciliation-bca balance-needs-periodic error:', e.message);
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
  balanceNeedsPeriodicHandler,
  resolveHandler,
  actionLogsHandler,
  resolutionHistoryHandler,
  // exported untuk unit test (backend/scripts/test-reconciliation-bca.js)
  parseFlexibleDateTime,
  timeDelayBucket,
  dedupeBcaResultsByCanonicalKey,
  computeBcaDataQualityWarning,
  computeBcaActionableException,
  computeBcaHealthStatus,
  BCA_HEALTH_THRESHOLDS,
};
