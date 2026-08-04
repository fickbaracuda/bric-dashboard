'use strict';

/**
 * Balance & Funding — Bank Balance Adapters.
 *
 * STANDALONE dari Balance Control Tower lama: file ini TIDAK mengimpor apa
 * pun dari backend/src/balanceControlTower/ atau
 * backend/src/reconciliation/bankPosition/ (adapter OCBC BCT lama). Balance
 * & Funding adalah READ CONSUMER dari data rekonsiliasi (recon_sync_batches/
 * recon_bank_transactions) — query di sini BARU dan independen, walau boleh
 * (dan memang) reuse fungsi validasi PURE read-only dari modul rekonsiliasi
 * (mandiriAdapter/briAdapter/bcaAdapter) supaya tidak menduplikasi logic
 * continuity-check yang sudah ada & teruji (spec section 58: "prefer
 * querying existing raw/batch data").
 *
 * Bukti sumber saldo per bank (Balance Source Matrix lengkap ada di
 * docs/BALANCE_FUNDING.md), ringkas:
 *   OCBC        -> recon_sync_batches.raw_summary.available_balance (resmi, HIGH)
 *   BCA         -> recon_sync_batches.raw_summary.current_balance.saldo_akhir
 *                  (footer resmi kalau source='sheet_footer' -> HIGH,
 *                  fallback row-order -> MEDIUM/LOW)
 *   MANDIRI     -> recon_bank_transactions.close_balance baris terakhir
 *                  (arah ASC/DESC dari validateMandiriBalance) -> MEDIUM/LOW
 *   BRI         -> recon_bank_transactions.balance baris terakhir
 *                  (balance_check_status sudah dihitung saat sync) -> MEDIUM/LOW
 *   BRI_BIFAST  -> sama pola BRI, tabel/kolom sama, bank_code beda -> MEDIUM/LOW
 *   BNI         -> TIDAK TERSEDIA -- file mutasi BNI tidak punya kolom saldo
 *                  sama sekali (dikonfirmasi & didisclaim eksplisit di kode
 *                  warroom-reconciliation-bni.js) -> SELALU UNAVAILABLE
 */

const { validateMandiriBalance } = require('../reconciliation/mandiriAdapter');

const BANK_CODES = ['OCBC', 'MANDIRI', 'BRI', 'BRI_BIFAST', 'BNI', 'BCA'];

const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNAVAILABLE: 'UNAVAILABLE' };

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unavailable(bankCode, reason) {
  return {
    bank_code: bankCode, account_no: null, balance: null, balance_timestamp: null, business_date: null,
    source: null, source_batch_id: null, verification_status: 'UNAVAILABLE', confidence: CONFIDENCE.UNAVAILABLE,
    warnings: [reason],
  };
}

// ── OCBC ──────────────────────────────────────────────────────────────────
async function getOcbcBalance(pool) {
  const r = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no, raw_summary
     FROM recon_sync_batches WHERE bank_code = 'OCBC' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT 1`
  );
  if (!r.rows.length) return unavailable('OCBC', 'Belum ada batch rekonsiliasi OCBC yang sukses.');
  const row = r.rows[0];
  const s = row.raw_summary || {};
  const balance = numOrNull(s.available_balance);
  if (balance === null) return unavailable('OCBC', 'raw_summary.available_balance kosong pada batch rekonsiliasi terakhir.');
  return {
    bank_code: 'OCBC', account_no: row.account_no || null, balance,
    balance_timestamp: row.synced_at, business_date: row.business_date,
    source: 'recon_sync_batches.raw_summary.available_balance', source_batch_id: String(row.id),
    verification_status: 'OFFICIAL_STATEMENT_VALUE', confidence: CONFIDENCE.HIGH, warnings: [],
  };
}

// ── BCA ───────────────────────────────────────────────────────────────────
async function getBcaBalance(pool) {
  const r = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no, raw_summary
     FROM recon_sync_batches WHERE bank_code = 'BCA' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT 1`
  );
  if (!r.rows.length) return unavailable('BCA', 'Belum ada batch rekonsiliasi BCA yang sukses.');
  const row = r.rows[0];
  const s = row.raw_summary || {};
  const cb = s.current_balance || {};
  const continuity = s.balance_continuity || {};
  const warnings = [];

  let balance = numOrNull(cb.saldo_akhir);
  let confidence = CONFIDENCE.HIGH;
  let verification = 'OFFICIAL_STATEMENT_FOOTER';
  let source = 'recon_sync_batches.raw_summary.current_balance.saldo_akhir';

  if (balance !== null && cb.source === 'row_order_fallback') {
    confidence = CONFIDENCE.MEDIUM;
    verification = 'ROW_ORDER_FALLBACK';
    warnings.push('Footer "Saldo Akhir" tidak terbaca saat sync — nilai dari fallback urutan baris.');
  }
  if (balance === null) {
    balance = numOrNull(continuity.latest_balance_from_order);
    if (balance !== null) {
      confidence = continuity.status === 'BALANCE_CONTINUITY_OK' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
      verification = 'CONTINUITY_DERIVED';
      source = 'recon_sync_batches.raw_summary.balance_continuity.latest_balance_from_order';
      warnings.push('Footer saldo akhir tidak tersedia — nilai diturunkan dari validasi kontinuitas baris mutasi.');
    }
  }
  if (balance === null) return unavailable('BCA', 'Footer saldo akhir maupun fallback kontinuitas tidak tersedia pada batch terakhir.');

  return {
    bank_code: 'BCA', account_no: row.account_no || null, balance,
    balance_timestamp: row.synced_at, business_date: row.business_date,
    source, source_batch_id: String(row.id), verification_status: verification, confidence, warnings,
  };
}

// ── MANDIRI ───────────────────────────────────────────────────────────────
async function getMandiriBalance(pool) {
  const batchRes = await pool.query(
    `SELECT id, business_date::text AS business_date, synced_at, account_no
     FROM recon_sync_batches WHERE bank_code = 'MANDIRI' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC LIMIT 1`
  );
  if (!batchRes.rows.length) return unavailable('MANDIRI', 'Belum ada batch rekonsiliasi Mandiri yang sukses.');
  const batch = batchRes.rows[0];

  const rowsRes = await pool.query(
    `SELECT close_balance, source_row_number, debit, credit
     FROM recon_bank_transactions
     WHERE batch_id = $1 AND close_balance IS NOT NULL AND source_row_number IS NOT NULL
     ORDER BY source_row_number ASC`,
    [batch.id]
  );
  if (!rowsRes.rows.length) return unavailable('MANDIRI', 'Tidak ada baris mutasi Mandiri dengan close_balance pada batch terakhir.');

  const bankRows = rowsRes.rows.map(r => ({
    closeBalance: numOrNull(r.close_balance), sourceRowNumber: Number(r.source_row_number),
    debitAmount: numOrNull(r.debit) || 0, creditAmount: numOrNull(r.credit) || 0,
  }));
  const validation = validateMandiriBalance(bankRows);
  const sorted = [...bankRows].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
  // ASC: baris teratas (source_row_number terkecil) = mutasi TERLAMA -> terbaru = index terakhir.
  // DESC: baris teratas = mutasi TERBARU -> terbaru = index 0.
  const direction = validation.direction || 'ASC';
  const latestRow = direction === 'DESC' ? sorted[0] : sorted[sorted.length - 1];

  const confidence = validation.status === 'BALANCED' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  const warnings = [];
  if (validation.status !== 'BALANCED') {
    warnings.push(`Validasi kontinuitas saldo Mandiri: ${validation.status} (${validation.matched}/${validation.checked} baris cocok).`);
  }
  warnings.push('Saldo Mandiri diturunkan dari close_balance baris mutasi terakhir (bukan field ringkasan resmi terpisah).');

  return {
    bank_code: 'MANDIRI', account_no: batch.account_no || null, balance: latestRow.closeBalance,
    balance_timestamp: batch.synced_at, business_date: batch.business_date,
    source: 'recon_bank_transactions.close_balance', source_batch_id: String(batch.id),
    verification_status: `ROW_CHRONOLOGY_${validation.status}`, confidence, warnings,
  };
}

// ── BRI & BRI_BIFAST (pola sama, tabel/kolom sama, bank_code beda) ────────
async function getBriLikeBalance(pool, bankCode) {
  const r = await pool.query(
    `SELECT sb.id AS batch_id, sb.business_date::text AS business_date, sb.synced_at, sb.account_no,
            rbt.balance, rbt.balance_check_status, rbt.effective_date_time, rbt.sequence_no
     FROM recon_sync_batches sb
     JOIN recon_bank_transactions rbt ON rbt.batch_id = sb.id
     WHERE sb.bank_code = $1 AND sb.status = 'success' AND rbt.balance IS NOT NULL
     ORDER BY sb.business_date DESC, sb.synced_at DESC,
              rbt.effective_date_time DESC NULLS LAST, rbt.sequence_no DESC NULLS LAST
     LIMIT 1`,
    [bankCode]
  );
  if (!r.rows.length) return unavailable(bankCode, `Tidak ada baris mutasi ${bankCode} dengan saldo (balance) pada batch rekonsiliasi.`);
  const row = r.rows[0];
  const balance = numOrNull(row.balance);
  if (balance === null) return unavailable(bankCode, `Kolom balance ${bankCode} kosong pada baris terakhir.`);

  const status = row.balance_check_status;
  const confidence = status === 'BALANCED' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  const warnings = ['Saldo diturunkan dari kolom balance (SALDO_AKHIR_MUTASI) baris mutasi terakhir, bukan field ringkasan resmi terpisah.'];
  if (status && status !== 'BALANCED') warnings.push(`balance_check_status baris terakhir: ${status}.`);
  if (!status) warnings.push('balance_check_status baris terakhir tidak tersedia (belum divalidasi).');

  return {
    bank_code: bankCode, account_no: row.account_no || null, balance,
    balance_timestamp: row.synced_at, business_date: row.business_date,
    source: 'recon_bank_transactions.balance', source_batch_id: String(row.batch_id),
    verification_status: `ROW_BALANCE_CHECK_${status || 'UNKNOWN'}`, confidence, warnings,
  };
}

// ── BNI — TIDAK TERSEDIA secara struktural (lihat komentar atas) ─────────
async function getBniBalance() {
  return unavailable(
    'BNI',
    'File mutasi BNI tidak memuat kolom saldo (opening/closing balance) — hanya data debit/kredit (Net Cash Movement). ' +
    'Saldo aktual BNI TIDAK DAPAT diturunkan dari data rekonsiliasi yang ada saat ini (bukan keterbatasan sementara, tapi struktur data sumbernya).'
  );
}

const ADAPTERS = {
  OCBC: getOcbcBalance,
  BCA: getBcaBalance,
  MANDIRI: getMandiriBalance,
  BRI: (pool) => getBriLikeBalance(pool, 'BRI'),
  BRI_BIFAST: (pool) => getBriLikeBalance(pool, 'BRI_BIFAST'),
  BNI: getBniBalance,
};

/**
 * Interface standar (spec section 39) — frontend/engine TIDAK PERNAH tahu
 * detail field per-bank, hanya konsumsi shape ini.
 */
async function getActualBankBalance(pool, bankCode) {
  const code = String(bankCode || '').toUpperCase();
  const fn = ADAPTERS[code];
  if (!fn) return unavailable(code, `Bank code "${bankCode}" tidak dikenal/didukung Balance & Funding.`);
  try {
    return await fn(pool);
  } catch (e) {
    console.error(`getActualBankBalance(${code}) error:`, e.message);
    return unavailable(code, `Gagal membaca saldo: ${e.message}`);
  }
}

module.exports = {
  BANK_CODES,
  CONFIDENCE,
  getActualBankBalance,
  // exported untuk testability (pola sama seperti warroom-qris-control-tower.js)
  getOcbcBalance,
  getBcaBalance,
  getMandiriBalance,
  getBriLikeBalance,
  getBniBalance,
};
