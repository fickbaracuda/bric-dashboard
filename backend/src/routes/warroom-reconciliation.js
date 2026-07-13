/**
 * Rekonsiliasi FP vs Bank OCBC — War Room Payment Agent > Rekonsiliasi OCBC
 *
 * Sumber: 2 sheet Google Sheet ("DATA FP", "DATA BANK OCBC") dari spreadsheet
 * 1V8NwLKeVUo2zV4ez-K4V-Ymt3_PNk7DyNrsJktcb2tE — domain baru, terpisah dari
 * war-room lain manapun.
 *
 * Engine rekonsiliasi (reconcileTransactions) SENGAJA pure function (tidak
 * menyentuh DB) supaya bisa di-unit-test langsung — lihat
 * backend/scripts/test-reconciliation-ocbc.js.
 */

const pool = require('../db');

// Reuse token sync UMUM (sesuai instruksi) — BUKAN token khusus baru.
const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN;

const DEFAULT_FEE_BIFAST = Number(process.env.RECON_OCBC_FEE_DEFAULT) || 25;
const DEFAULT_GRACE_MINUTES = Number(process.env.RECON_OCBC_GRACE_MINUTES) || 30;
const NUM_EPS = 0.5; // toleransi pembulatan rupiah saat membandingkan nominal

const RECON_STATUSES = [
  'MATCHED', 'MATCHED_NO_FEE', 'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY',
  'NOMINAL_MISMATCH', 'FEE_MISMATCH', 'DUPLICATE_FP', 'DUPLICATE_BANK',
  'REVERSAL', 'NEED_REVIEW',
];
const EXCEPTION_STATUSES = [
  'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'DUPLICATE_FP', 'DUPLICATE_BANK', 'REVERSAL', 'NEED_REVIEW',
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers dasar
// ─────────────────────────────────────────────────────────────────────────
function extractToken(req) {
  return (
    req.headers['x-sync-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.body?.token ||
    null
  );
}

function nullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Parser angka aman — WAJIB cek typeof number DULU (insiden Speedcash: titik
 * desimal number asli ikut terhapus kalau diproses sebagai string). Titik &
 * koma di sini berarti pemisah ribuan (Rupiah, tidak ada desimal bermakna).
 */
function cleanNum(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (raw === '' || raw === '-') return null;
  let cleaned = raw.replace(/rp/gi, '').trim();
  cleaned = cleaned.replace(/[.,]/g, '');
  cleaned = cleaned.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(value) {
  const s = nullIfEmpty(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseTimeResponse(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function numEq(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < NUM_EPS;
}

function safeDiv(numerator, denominator) {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Fallback dari Description bank ketika Reference No. kosong/tidak match.
 * Pola OCBC: "..../<id_outlet><id_transaksi>" — id_outlet diasumsikan 2
 * huruf + 5 digit (contoh nyata: "HH82915"), sisanya (>=6 digit) id_transaksi.
 * Kalau pola tidak cocok -> null (dianggap di luar scope rekon, BUKAN error).
 */
function parseDescriptionFallback(description) {
  if (!description) return null;
  const segments = String(description).split('/');
  const last = (segments[segments.length - 1] || '').trim();
  const m = /^([A-Za-z]{2}\d{5})(\d{6,})$/.exec(last);
  if (!m) return null;
  return { idOutlet: m[1], idTransaksi: m[2] };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine rekonsiliasi — PURE FUNCTION, tidak menyentuh DB (lihat unit test)
// ─────────────────────────────────────────────────────────────────────────
function reconcileTransactions(fpRows, bankRows, config = {}, now = new Date()) {
  const expectedFee = typeof config.expectedFee === 'number' && Number.isFinite(config.expectedFee) ? config.expectedFee : DEFAULT_FEE_BIFAST;
  const graceMinutes = typeof config.graceMinutes === 'number' && Number.isFinite(config.graceMinutes) ? config.graceMinutes : DEFAULT_GRACE_MINUTES;

  // Group bank rows by reference_no (trimmed, non-empty)
  const bankByRef = new Map();
  for (const b of bankRows) {
    const ref = String(b.referenceNo || '').trim();
    if (!ref) continue;
    if (!bankByRef.has(ref)) bankByRef.set(ref, []);
    bankByRef.get(ref).push(b);
  }

  // Index fallback: bank rows TANPA reference, diparse dari description
  const bankFallbackByIdTransaksi = new Map();
  for (const b of bankRows) {
    const ref = String(b.referenceNo || '').trim();
    if (ref) continue;
    const parsed = parseDescriptionFallback(b.description);
    if (!parsed) continue;
    if (!bankFallbackByIdTransaksi.has(parsed.idTransaksi)) bankFallbackByIdTransaksi.set(parsed.idTransaksi, []);
    bankFallbackByIdTransaksi.get(parsed.idTransaksi).push(b);
  }

  // Deteksi duplikat id_transaksi di FP
  const fpCountById = new Map();
  for (const f of fpRows) {
    const id = String(f.idTransaksi || '').trim();
    if (!id) continue;
    fpCountById.set(id, (fpCountById.get(id) || 0) + 1);
  }

  const results = [];
  const processedIds = new Set();

  for (const fp of fpRows) {
    const idTransaksi = String(fp.idTransaksi || '').trim();
    if (!idTransaksi || processedIds.has(idTransaksi)) continue;
    processedIds.add(idTransaksi);

    const isDuplicateFp = (fpCountById.get(idTransaksi) || 0) > 1;

    let matchedBankRows = bankByRef.get(idTransaksi) || null;
    let matchingMethod = matchedBankRows ? 'reference_exact' : null;
    if (!matchedBankRows) {
      matchedBankRows = bankFallbackByIdTransaksi.get(idTransaksi) || null;
      matchingMethod = matchedBankRows ? 'description_fallback' : null;
    }

    const fpTimeResponse = fp.timeResponse instanceof Date && !Number.isNaN(fp.timeResponse.getTime()) ? fp.timeResponse : null;
    const agingMinutes = fpTimeResponse ? Math.round((now.getTime() - fpTimeResponse.getTime()) / 60000) : null;

    const result = {
      idTransaksi, referenceNo: null, idOutlet: fp.idOutlet || null, idProduk: fp.idProduk || null, idBiller: fp.idBiller || null,
      fpNominal: typeof fp.nominal === 'number' ? fp.nominal : null, fpTimeResponse, bankTransactionDate: null,
      bankPrincipal: null, bankFee: null, bankCredit: null, bankTotalDebit: null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: matchingMethod || 'none', reconStatus: 'NEED_REVIEW', agingMinutes, notes: null,
    };

    if (isDuplicateFp) {
      result.reconStatus = 'DUPLICATE_FP';
      result.notes = `id_transaksi muncul ${fpCountById.get(idTransaksi)} kali di DATA FP.`;
      results.push(result);
      continue;
    }

    if (!matchedBankRows || !matchedBankRows.length) {
      result.reconStatus = (agingMinutes !== null && agingMinutes < graceMinutes) ? 'PENDING_BANK' : 'FP_ONLY';
      results.push(result);
      continue;
    }

    result.referenceNo = matchingMethod === 'reference_exact' ? idTransaksi : (matchedBankRows[0].referenceNo || null);
    result.bankTransactionDate = matchedBankRows[0].transactionDate || null;

    const debitRows = matchedBankRows.filter(b => typeof b.debit === 'number' && b.debit > 0);
    const creditRows = matchedBankRows.filter(b => typeof b.credit === 'number' && b.credit > 0);
    const bankCreditTotal = creditRows.reduce((s, b) => s + b.credit, 0);
    const bankTotalDebit = debitRows.reduce((s, b) => s + b.debit, 0);

    result.bankCredit = creditRows.length ? bankCreditTotal : null;
    result.bankTotalDebit = debitRows.length ? bankTotalDebit : null;

    const fpNominal = result.fpNominal;
    const principalCandidates = (fpNominal !== null) ? debitRows.filter(b => numEq(b.debit, fpNominal)) : [];

    if (principalCandidates.length === 0) {
      if (debitRows.length === 0) {
        result.reconStatus = 'NEED_REVIEW';
        result.notes = 'Reference/deskripsi ditemukan tapi tidak ada baris debit sama sekali (hanya credit).';
      } else {
        result.reconStatus = 'NOMINAL_MISMATCH';
        result.notes = `Tidak ada debit yang sama dengan nominal FP (Rp${fpNominal}). Debit ditemukan: ${debitRows.map(b => b.debit).join(', ')}.`;
      }
    } else if (principalCandidates.length > 1) {
      result.reconStatus = 'DUPLICATE_BANK';
      result.bankPrincipal = principalCandidates[0].debit;
      result.notes = `${principalCandidates.length} baris debit bank sama-sama cocok dengan nominal FP pada reference yang sama.`;
    } else {
      const principalRow = principalCandidates[0];
      result.bankPrincipal = principalRow.debit;
      const feeRows = debitRows.filter(b => b !== principalRow);
      const bankFee = feeRows.reduce((s, b) => s + b.debit, 0);
      result.bankFee = feeRows.length ? bankFee : 0;
      result.variancePrincipal = 0;
      result.varianceFee = result.bankFee - expectedFee;

      if (feeRows.length === 0) result.reconStatus = 'MATCHED_NO_FEE';
      else if (numEq(bankFee, expectedFee)) result.reconStatus = 'MATCHED';
      else result.reconStatus = 'FEE_MISMATCH';
    }

    // Credit/reversal MENIMPA status di atas — sinyal reversal lebih kuat
    if (creditRows.length > 0) {
      result.reconStatus = 'REVERSAL';
      result.notes = [result.notes, `Ditemukan ${creditRows.length} baris credit (reversal/refund) sebesar Rp${bankCreditTotal}.`].filter(Boolean).join(' ');
    }

    results.push(result);
  }

  // BANK_ONLY — reference/description yang pola-nya "dalam scope" FP (outlet+id
  // transaksi) tapi tidak match FP manapun. Mutasi bank yang polanya TIDAK
  // cocok sama sekali (bukan format id_outlet+id_transaksi) DIABAIKAN, bukan
  // otomatis jadi bank-only (instruksi eksplisit — supaya tidak flood exception
  // dengan mutasi bank yang sama sekali tidak terkait FP).
  const fpIdSet = new Set(fpRows.map(f => String(f.idTransaksi || '').trim()).filter(Boolean));
  const seenBankOnly = new Set();
  for (const b of bankRows) {
    const ref = String(b.referenceNo || '').trim();
    let candidateId = null;
    let candidateOutlet = null;

    if (ref) {
      if (fpIdSet.has(ref)) continue;
      candidateId = ref;
    } else {
      const parsed = parseDescriptionFallback(b.description);
      if (!parsed) continue;
      if (fpIdSet.has(parsed.idTransaksi)) continue;
      candidateId = parsed.idTransaksi;
      candidateOutlet = parsed.idOutlet;
    }

    if (typeof b.debit !== 'number' || b.debit <= 0) continue; // fokus baris debit, bukan mutasi credit murni
    if (seenBankOnly.has(candidateId)) continue;
    seenBankOnly.add(candidateId);

    const group = ref ? (bankByRef.get(ref) || [b]) : [b];
    const debitRows = group.filter(x => typeof x.debit === 'number' && x.debit > 0);
    const creditRows = group.filter(x => typeof x.credit === 'number' && x.credit > 0);
    const bankTotalDebit = debitRows.reduce((s, x) => s + x.debit, 0);
    const bankCredit = creditRows.reduce((s, x) => s + x.credit, 0);

    results.push({
      // referenceNo diisi candidateId kalau ref asli kosong (hasil parse
      // description) — WAJIB tidak null, supaya key upsert (batch_id,
      // id_transaksi, reference_no) unik per kandidat BANK_ONLY (kalau
      // dibiarkan null, semua baris fallback tanpa reference akan tabrakan
      // jadi 1 baris saja karena id_transaksi & reference_no sama-sama null).
      idTransaksi: null, referenceNo: ref || candidateId, idOutlet: candidateOutlet, idProduk: null, idBiller: null,
      fpNominal: null, fpTimeResponse: null, bankTransactionDate: group[0].transactionDate || null,
      bankPrincipal: null, bankFee: null, bankCredit: creditRows.length ? bankCredit : null,
      bankTotalDebit: debitRows.length ? bankTotalDebit : null,
      variancePrincipal: null, varianceFee: null,
      matchingMethod: ref ? 'reference_exact' : 'description_fallback',
      reconStatus: 'BANK_ONLY', agingMinutes: null,
      notes: `Ditemukan di bank (kandidat id_transaksi: ${candidateId}) tapi tidak ada di DATA FP.`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/sync
// ─────────────────────────────────────────────────────────────────────────
async function syncHandler(req, res) {
  const token = extractToken(req);
  if (!SYNC_TOKEN || token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const businessDate = nullIfEmpty(body.business_date);
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return res.status(400).json({ error: 'business_date wajib diisi, format YYYY-MM-DD' });
  }
  const bankCode = nullIfEmpty(body.bank_code) || 'OCBC';
  const chunkIndex = Number.isFinite(Number(body.chunk_index)) ? Number(body.chunk_index) : 0;
  const chunkTotal = (Number.isFinite(Number(body.chunk_total)) && Number(body.chunk_total) > 0) ? Number(body.chunk_total) : 1;
  const isFirstChunk = chunkIndex === 0;
  const isLastChunk = chunkIndex >= chunkTotal - 1;

  const fpRowsRaw = Array.isArray(body.fp) ? body.fp : [];
  const bankRowsRaw = Array.isArray(body.bank) ? body.bank : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchNo = `${bankCode}-${businessDate}`;
    const batchRes = await client.query(
      `INSERT INTO recon_sync_batches (batch_no, business_date, bank_code, spreadsheet_id, fp_sheet_name, bank_sheet_name, fp_row_count, bank_row_count, synced_at, created_by, status, raw_summary)
       VALUES ($1,$2,$3,$4,$5,$6,0,0,NOW(),$7,'pending',$8)
       ON CONFLICT (business_date, bank_code) DO UPDATE SET
         batch_no = EXCLUDED.batch_no, spreadsheet_id = EXCLUDED.spreadsheet_id,
         fp_sheet_name = EXCLUDED.fp_sheet_name, bank_sheet_name = EXCLUDED.bank_sheet_name,
         synced_at = NOW(), created_by = EXCLUDED.created_by, status = 'pending',
         raw_summary = CASE WHEN $8::jsonb <> '{}'::jsonb THEN $8::jsonb ELSE recon_sync_batches.raw_summary END
       RETURNING id`,
      [
        batchNo, businessDate, bankCode, nullIfEmpty(body.spreadsheet_id),
        nullIfEmpty(body.fp_sheet_name) || 'DATA FP', nullIfEmpty(body.bank_sheet_name) || 'DATA BANK OCBC',
        nullIfEmpty(body.meta?.synced_by) || 'apps_script',
        JSON.stringify(body.bank_summary || {}),
      ]
    );
    const batchId = batchRes.rows[0].id;

    // Chunk pertama -> mulai fresh (hapus data mentah lama batch ini). Ini
    // yang menjamin resync tidak menggandakan row (acceptance test 9).
    if (isFirstChunk) {
      await client.query('DELETE FROM recon_fp_transactions WHERE batch_id = $1', [batchId]);
      await client.query('DELETE FROM recon_bank_transactions WHERE batch_id = $1', [batchId]);
    }

    let fpInserted = 0;
    for (const row of fpRowsRaw) {
      const idTransaksi = nullIfEmpty(row.id_transaksi);
      if (!idTransaksi) continue;
      await client.query(
        `INSERT INTO recon_fp_transactions (batch_id, id_transaksi, nominal, id_produk, time_response, id_outlet, id_biller, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          batchId, idTransaksi, cleanNum(row.nominal), nullIfEmpty(row.id_produk),
          parseTimeResponse(row.time_response), nullIfEmpty(row.id_outlet), nullIfEmpty(row.id_biller),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      fpInserted++;
    }

    let bankInserted = 0;
    for (const row of bankRowsRaw) {
      await client.query(
        `INSERT INTO recon_bank_transactions (batch_id, transaction_date, value_date, reference_no, cheque_no, description, debit, credit, balance, source_row_number, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          batchId, toIsoDate(row.transaction_date), toIsoDate(row.value_date),
          nullIfEmpty(row.reference_no), nullIfEmpty(row.cheque_no), nullIfEmpty(row.description),
          cleanNum(row.debit), cleanNum(row.credit), cleanNum(row.balance),
          Number.isFinite(Number(row.source_row)) ? Number(row.source_row) : null,
          JSON.stringify(row.raw_data || {}),
        ]
      );
      bankInserted++;
    }

    if (!isLastChunk) {
      await client.query('COMMIT');
      return res.json({ success: true, batch_id: batchId, chunk_index: chunkIndex, chunk_total: chunkTotal, fp_rows_inserted: fpInserted, bank_rows_inserted: bankInserted, engine_run: false });
    }

    // Chunk terakhir -> jalankan engine atas SELURUH data batch ini
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
      transactionDate: r.transaction_date, referenceNo: r.reference_no, description: r.description,
      debit: r.debit !== null ? Number(r.debit) : null, credit: r.credit !== null ? Number(r.credit) : null,
    }));

    const configOverride = {
      expectedFee: Number.isFinite(Number(body.config?.expected_fee)) ? Number(body.config.expected_fee) : undefined,
      graceMinutes: Number.isFinite(Number(body.config?.grace_period_minutes)) ? Number(body.config.grace_period_minutes) : undefined,
    };

    const results = reconcileTransactions(fpForEngine, bankForEngine, configOverride, new Date());

    for (const r of results) {
      await client.query(
        `INSERT INTO recon_results
           (batch_id, id_transaksi, reference_no, id_outlet, id_produk, id_biller, fp_nominal, fp_time_response,
            bank_transaction_date, bank_principal, bank_fee, bank_credit, bank_total_debit,
            variance_principal, variance_fee, matching_method, recon_status, aging_minutes, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
         ON CONFLICT (batch_id, COALESCE(id_transaksi, ''), COALESCE(reference_no, '')) DO UPDATE SET
           id_outlet = EXCLUDED.id_outlet, id_produk = EXCLUDED.id_produk, id_biller = EXCLUDED.id_biller,
           fp_nominal = EXCLUDED.fp_nominal, fp_time_response = EXCLUDED.fp_time_response,
           bank_transaction_date = EXCLUDED.bank_transaction_date, bank_principal = EXCLUDED.bank_principal,
           bank_fee = EXCLUDED.bank_fee, bank_credit = EXCLUDED.bank_credit, bank_total_debit = EXCLUDED.bank_total_debit,
           variance_principal = EXCLUDED.variance_principal, variance_fee = EXCLUDED.variance_fee,
           matching_method = EXCLUDED.matching_method, recon_status = EXCLUDED.recon_status,
           aging_minutes = EXCLUDED.aging_minutes, notes = EXCLUDED.notes, updated_at = NOW()`,
        [
          batchId, r.idTransaksi, r.referenceNo, r.idOutlet, r.idProduk, r.idBiller, r.fpNominal, r.fpTimeResponse,
          r.bankTransactionDate, r.bankPrincipal, r.bankFee, r.bankCredit, r.bankTotalDebit,
          r.variancePrincipal, r.varianceFee, r.matchingMethod, r.reconStatus, r.agingMinutes, r.notes,
        ]
      );
    }

    // Hapus recon_results lama yang tidak lagi dihasilkan engine (mis. baris FP dihapus dari sheet)
    const currentKeys = results.map(r => `${r.idTransaksi || ''}|${r.referenceNo || ''}`);
    await client.query(
      `DELETE FROM recon_results WHERE batch_id = $1 AND (COALESCE(id_transaksi,'') || '|' || COALESCE(reference_no,'')) <> ALL($2::text[])`,
      [batchId, currentKeys.length ? currentKeys : ['']]
    );

    await client.query(
      `UPDATE recon_sync_batches SET fp_row_count = $2, bank_row_count = $3, status = 'success', synced_at = NOW() WHERE id = $1`,
      [batchId, fpAllRes.rows.length, bankAllRes.rows.length]
    );

    await client.query('COMMIT');
    res.json({
      success: true, batch_id: batchId, business_date: businessDate, bank_code: bankCode,
      fp_row_count: fpAllRes.rows.length, bank_row_count: bankAllRes.rows.length,
      result_count: results.length, engine_run: true, synced_at: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconciliation sync error:', err.message);
    res.status(500).json({ error: 'Sync gagal, sudah di-rollback (tidak ada data parsial).' });
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/analytics?date=YYYY-MM-DD&bank_code=OCBC
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
    let date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    if (!date) {
      const latest = await pool.query(
        'SELECT business_date FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 1',
        [bankCode]
      );
      date = latest.rows[0] ? latest.rows[0].business_date.toISOString().slice(0, 10) : null;
    }

    const recentBatchesRes = await pool.query(
      `SELECT batch_no, business_date, bank_code, fp_row_count, bank_row_count, synced_at, status
       FROM recon_sync_batches WHERE bank_code = $1 ORDER BY business_date DESC LIMIT 14`,
      [bankCode]
    );
    const recentBatches = recentBatchesRes.rows.map(r => ({
      batch_no: r.batch_no, business_date: r.business_date, bank_code: r.bank_code,
      fp_row_count: r.fp_row_count, bank_row_count: r.bank_row_count, synced_at: r.synced_at, status: r.status,
    }));

    if (!date) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi. Jalankan sync Google Sheet terlebih dahulu.',
        meta: { date: null, bank_code: bankCode }, recent_batches: recentBatches,
      });
    }

    const batchRes = await pool.query(
      'SELECT * FROM recon_sync_batches WHERE business_date = $1 AND bank_code = $2',
      [date, bankCode]
    );
    const batch = batchRes.rows[0] || null;
    if (!batch) {
      return res.json({
        empty: true, message: 'Belum ada data rekonsiliasi untuk tanggal ini.',
        meta: { date, bank_code: bankCode }, recent_batches: recentBatches,
      });
    }

    const [resultsRes, fpCountRes, bankRefCountRes] = await Promise.all([
      pool.query('SELECT * FROM recon_results WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(*) AS c, COALESCE(SUM(nominal),0) AS s FROM recon_fp_transactions WHERE batch_id = $1', [batch.id]),
      pool.query('SELECT COUNT(DISTINCT reference_no) AS c FROM recon_bank_transactions WHERE batch_id = $1 AND reference_no IS NOT NULL', [batch.id]),
    ]);
    const results = resultsRes.rows;

    const totalTransaksiFp = Number(fpCountRes.rows[0]?.c || 0);
    const totalNominalFp = Number(fpCountRes.rows[0]?.s || 0);
    const referenceBankUnik = Number(bankRefCountRes.rows[0]?.c || 0);

    const byStatus = {};
    for (const s of RECON_STATUSES) byStatus[s] = { count: 0, nominal: 0 };
    for (const r of results) {
      const s = byStatus[r.recon_status] ? r.recon_status : 'NEED_REVIEW';
      byStatus[s].count++;
      byStatus[s].nominal += Number(r.fp_nominal || 0);
    }
    const matchedCount = byStatus.MATCHED.count + byStatus.MATCHED_NO_FEE.count;
    const matchedNominal = byStatus.MATCHED.nominal + byStatus.MATCHED_NO_FEE.nominal;
    const totalFeeBank = results.reduce((s, r) => s + (r.bank_fee !== null ? Number(r.bank_fee) : 0), 0);

    const summary = {
      total_transaksi_fp: totalTransaksiFp,
      total_nominal_fp: totalNominalFp,
      reference_bank_unik: referenceBankUnik,
      matched_transaksi: matchedCount,
      matched_nominal: matchedNominal,
      pending_bank_count: byStatus.PENDING_BANK.count,
      fp_only_count: byStatus.FP_ONLY.count,
      bank_only_count: byStatus.BANK_ONLY.count,
      nominal_mismatch_count: byStatus.NOMINAL_MISMATCH.count,
      total_fee_bank: totalFeeBank,
      match_rate_transaksi: safeDiv(matchedCount, totalTransaksiFp),
      match_rate_nominal: safeDiv(matchedNominal, totalNominalFp),
    };

    const status_distribution = RECON_STATUSES.map(s => ({ status: s, count: byStatus[s].count, nominal: byStatus[s].nominal }));

    // Statement validation: opening + credit - debit = closing
    const raw = batch.raw_summary || {};
    const opening = cleanNum(raw.opening_balance);
    const closing = cleanNum(raw.closing_balance);
    const totalDebitAmount = cleanNum(raw.total_debit_amount);
    const totalCreditAmount = cleanNum(raw.total_credit_amount);
    let expectedClosing = null, statementVariance = null, statementValid = null;
    if (opening !== null && totalCreditAmount !== null && totalDebitAmount !== null) {
      expectedClosing = opening + totalCreditAmount - totalDebitAmount;
      if (closing !== null) {
        statementVariance = closing - expectedClosing;
        statementValid = Math.abs(statementVariance) < 1;
      }
    }
    const statement_validation = {
      period: raw.period || null, account_number: raw.account_number || null, account_name: raw.account_name || null,
      opening_balance: opening, closing_balance: closing,
      total_debit_count: raw.total_debit_count ?? null, total_debit_amount: totalDebitAmount,
      total_credit_count: raw.total_credit_count ?? null, total_credit_amount: totalCreditAmount,
      ledger_balance: cleanNum(raw.ledger_balance), available_balance: cleanNum(raw.available_balance),
      release_date: raw.release_date || null,
      expected_closing_balance: expectedClosing, variance: statementVariance, is_valid: statementValid,
    };

    // Fee analysis — expected vs actual, distribusi per produk/outlet/biller
    const feeRows = results.filter(r => r.bank_fee !== null);
    const feeMismatchRows = results.filter(r => r.recon_status === 'FEE_MISMATCH');
    const totalActualFee = feeRows.reduce((s, r) => s + Number(r.bank_fee), 0);
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
      expected_fee: DEFAULT_FEE_BIFAST,
      actual_fee_total: totalActualFee,
      actual_fee_avg: safeDiv(totalActualFee, feeRows.length),
      fee_variance_count: feeMismatchRows.length,
      transaction_with_fee_count: feeRows.length,
      distribution: [
        { fee: DEFAULT_FEE_BIFAST, count: feeRows.filter(r => numEq(Number(r.bank_fee), DEFAULT_FEE_BIFAST)).length },
        { fee: 0, count: feeRows.filter(r => Number(r.bank_fee) === 0).length },
        { fee: 'lainnya', count: feeRows.filter(r => !numEq(Number(r.bank_fee), DEFAULT_FEE_BIFAST) && Number(r.bank_fee) !== 0).length },
      ],
      by_produk: groupFeeBy(r => r.id_produk),
      by_outlet: groupFeeBy(r => r.id_outlet).slice(0, 20),
      by_biller: groupFeeBy(r => r.id_biller),
    };

    res.json({
      empty: false,
      meta: {
        date, bank_code: bankCode, batch_no: batch.batch_no,
        fp_row_count: batch.fp_row_count, bank_row_count: batch.bank_row_count,
        last_sync: batch.synced_at, source_spreadsheet_id: batch.spreadsheet_id,
      },
      summary, status_distribution, statement_validation, fee_analysis, recent_batches: recentBatches,
    });
  } catch (e) {
    console.error('reconciliation analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/transactions
// ─────────────────────────────────────────────────────────────────────────
const SORT_COLUMNS = {
  id_transaksi: 'id_transaksi', reference_no: 'reference_no', fp_nominal: 'fp_nominal',
  bank_principal: 'bank_principal', bank_fee: 'bank_fee', bank_total_debit: 'bank_total_debit',
  variance_principal: 'variance_principal', variance_fee: 'variance_fee', aging_minutes: 'aging_minutes',
  recon_status: 'recon_status', fp_time_response: 'fp_time_response', bank_transaction_date: 'bank_transaction_date',
  updated_at: 'updated_at',
};

function buildTransactionsQuery(req) {
  const bankCode = nullIfEmpty(req.query.bank_code) || 'OCBC';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const status = nullIfEmpty(req.query.status);
  const idOutlet = nullIfEmpty(req.query.id_outlet);
  const idProduk = nullIfEmpty(req.query.id_produk);
  const search = nullIfEmpty(req.query.search);

  const conditions = ['b.bank_code = $1'];
  const params = [bankCode];
  if (date) { params.push(date); conditions.push(`b.business_date = $${params.length}`); }
  if (status) {
    const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
    params.push(statusList);
    conditions.push(`r.recon_status = ANY($${params.length}::text[])`);
  }
  if (idOutlet) { params.push(idOutlet); conditions.push(`r.id_outlet = $${params.length}`); }
  if (idProduk) { params.push(idProduk); conditions.push(`r.id_produk = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(r.id_transaksi ILIKE $${params.length} OR r.reference_no ILIKE $${params.length} OR r.id_outlet ILIKE $${params.length})`);
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
      `SELECT r.*, b.business_date FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
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
    fp_nominal: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
    fp_time_response: r.fp_time_response,
    bank_transaction_date: r.bank_transaction_date,
    bank_principal: r.bank_principal !== null ? Number(r.bank_principal) : null,
    bank_fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
    bank_credit: r.bank_credit !== null ? Number(r.bank_credit) : null,
    bank_total_debit: r.bank_total_debit !== null ? Number(r.bank_total_debit) : null,
    variance_principal: r.variance_principal !== null ? Number(r.variance_principal) : null,
    variance_fee: r.variance_fee !== null ? Number(r.variance_fee) : null,
    matching_method: r.matching_method,
    recon_status: r.recon_status,
    aging_minutes: r.aging_minutes,
    notes: r.notes,
    updated_at: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/reconciliation/export — CSV
// ─────────────────────────────────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportHandler(req, res) {
  try {
    const { whereClause, params } = buildTransactionsQuery(req);
    const rowsRes = await pool.query(
      `SELECT r.*, b.business_date FROM recon_results r JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE ${whereClause} ORDER BY r.updated_at DESC LIMIT 20000`,
      params
    );
    const headers = [
      'business_date', 'id_transaksi', 'reference_no', 'id_outlet', 'id_produk', 'id_biller',
      'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal', 'bank_fee',
      'bank_credit', 'bank_total_debit', 'variance_principal', 'variance_fee', 'matching_method',
      'recon_status', 'aging_minutes', 'notes',
    ];
    const lines = [headers.join(',')];
    for (const row of rowsRes.rows.map(mapResultRow)) {
      lines.push(headers.map(h => csvEscape(row[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-ocbc-${nullIfEmpty(req.query.date) || 'export'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/warroom/reconciliation/:id/resolve
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

    const current = await pool.query('SELECT recon_status FROM recon_results WHERE id = $1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Data rekonsiliasi tidak ditemukan' });
    const statusBefore = current.rows[0].recon_status;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE recon_results SET recon_status = $2, notes = COALESCE($3, notes), updated_at = NOW() WHERE id = $1`,
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
// GET /api/warroom/reconciliation/:id/logs — riwayat audit 1 baris hasil
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
  exportHandler,
  resolveHandler,
  actionLogsHandler,
  // exported untuk unit test (backend/scripts/test-reconciliation-ocbc.js)
  reconcileTransactions,
  parseDescriptionFallback,
  cleanNum,
  toIsoDate,
  numEq,
  RECON_STATUSES,
  EXCEPTION_STATUSES,
  DEFAULT_FEE_BIFAST,
  DEFAULT_GRACE_MINUTES,
};
