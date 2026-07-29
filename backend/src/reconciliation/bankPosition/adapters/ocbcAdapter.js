'use strict';

/**
 * OCBC adapter — Balance Control Tower generic bank-position layer.
 *
 * Sumber data (TIDAK mengubah/menduplikasi engine rekonsiliasi OCBC di
 * warroom-reconciliation.js sama sekali — file itu TIDAK disentuh):
 *   - Posisi saldo terverifikasi  : recon_sync_batches.raw_summary
 *     (angka resmi dari statement OCBC sendiri, ditranskrip Apps Script,
 *     BUKAN hasil re-derive kita — available_balance dipakai apa adanya).
 *   - Mutasi kredit (funding)     : recon_bank_archive (arsip kumulatif,
 *     tidak pernah dihapus, dedup via row_fingerprint).
 *
 * SENGAJA TIDAK reuse buildOcbcBankGroups() dari warroom-reconciliation.js:
 * fungsi itu men-skip (continue, bukan sekadar exclude) baris tanpa
 * reference_no yang deskripsinya tidak match pola FP — pola PERSIS yang
 * dipunyai transfer masuk asli (mis. "7996-BI FAST Transfer BIMASAKTI...",
 * reference_no NULL). Grouping di sini SENGAJA inklusif: kunci
 * COALESCE(reference_no, description) supaya baris funding asli tidak
 * pernah hilang.
 */

const REVERSAL_DESCRIPTION_PATTERN = /revers/i;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Kunci grouping inklusif -- reference_no dulu, fallback ke description dinormalisasi. */
function normalizeGroupKey(referenceNo, description) {
  const ref = referenceNo !== null && referenceNo !== undefined ? String(referenceNo).trim() : '';
  if (ref) return `ref:${ref}`;
  const desc = description !== null && description !== undefined ? String(description).trim().toLowerCase() : '';
  return desc ? `desc:${desc}` : null;
}

/**
 * PURE — klasifikasi baris archive jadi funding mutation records. Tidak
 * menyentuh DB, jadi bisa di-unit-test langsung dengan fixture.
 *
 * Aturan reversal exclusion (DUA lapis independen, baris harus lolos
 * KEDUANYA utk dianggap funding baru):
 *   1. Group (COALESCE(reference_no, description)) yang JUGA punya baris
 *      debit -> seluruh credit di group itu reversal (pasangan dalam hari
 *      yang sama).
 *   2. description mengandung "revers" (case-insensitive) -> reversal,
 *      TERLEPAS dari grouping -- menangkap reversal lintas hari (pasangan
 *      debit-nya di luar window archive yang di-query), lihat contoh nyata
 *      "...REVERSAL BIFAST 280726" yang ditemukan saat investigasi.
 *
 * Baris yang gagal salah satu tes TETAP dikembalikan (classification=
 * 'REVERSAL', is_reversal=true) -- utk visibilitas audit, bukan dibuang
 * diam-diam. Pemanggil yang menjumlahkan funding HARUS filter is_reversal=false.
 */
function classifyFundingCandidates(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = normalizeGroupKey(r.reference_no, r.description) || `fp:${r.row_fingerprint}`;
    if (!groups.has(key)) groups.set(key, { hasDebit: false });
    if (numOrNull(r.debit) > 0) groups.get(key).hasDebit = true;
  }

  const out = [];
  for (const r of rows) {
    const credit = numOrNull(r.credit);
    if (!(credit > 0)) continue; // bukan baris kredit -> bukan kandidat funding sama sekali

    const key = normalizeGroupKey(r.reference_no, r.description) || `fp:${r.row_fingerprint}`;
    const groupHasDebit = groups.has(key) ? groups.get(key).hasDebit : false;
    const descriptionLooksReversal = REVERSAL_DESCRIPTION_PATTERN.test(r.description || '');
    const isReversal = groupHasDebit || descriptionLooksReversal;

    out.push({
      bank_code: 'OCBC',
      transaction_id: null,
      reference_no: r.reference_no || null,
      description: r.description || null,
      amount: credit,
      transaction_datetime: r.transaction_date_time || null,
      mutation_type: 'CREDIT',
      classification: isReversal ? 'REVERSAL' : 'FUNDING',
      is_reversal: isReversal,
      // recon_bank_archive HANYA berisi baris yang SUDAH posted di statement
      // bank -- artinya SUDAH otomatis termasuk di available_balance. Field
      // ini adalah sinyal eksplisit ke pemanggil: JANGAN dijumlahkan lagi.
      is_already_reflected_in_balance: true,
      source_table: 'recon_bank_archive',
      dedup_key: r.row_fingerprint,
    });
  }
  return out;
}

/**
 * Posisi saldo terverifikasi terbaru -- available_balance dipakai APA
 * ADANYA (bukan hasil re-derive opening+credit-debit kita sendiri; angka
 * resmi bank sudah termasuk seluruh fee/reversal/adjustment).
 */
async function getLatestVerifiedPosition({ pool }) {
  const r = await pool.query(
    `SELECT business_date::text AS business_date, synced_at, raw_summary
     FROM recon_sync_batches
     WHERE bank_code = 'OCBC' AND status = 'success'
     ORDER BY business_date DESC, synced_at DESC
     LIMIT 1`
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const s = row.raw_summary || {};
  return {
    bank_code: 'OCBC',
    business_date: row.business_date,
    opening_balance: numOrNull(s.opening_balance),
    closing_balance: numOrNull(s.closing_balance),
    ledger_balance: numOrNull(s.ledger_balance),
    available_balance: numOrNull(s.available_balance),
    total_credit_amount: numOrNull(s.total_credit_amount),
    total_debit_amount: numOrNull(s.total_debit_amount),
    synced_at: row.synced_at,
    source_table: 'recon_sync_batches.raw_summary',
    source_reference: row.business_date,
  };
}

/** Mutasi kredit archive dalam rentang [from, to] (business_date, YYYY-MM-DD). */
async function getFundingCandidates({ pool, from, to }) {
  const r = await pool.query(
    `SELECT reference_no, description, debit, credit, transaction_date_time, row_fingerprint
     FROM recon_bank_archive
     WHERE bank_code = 'OCBC' AND business_date BETWEEN $1 AND $2
     ORDER BY transaction_date_time`,
    [from, to]
  );
  return classifyFundingCandidates(r.rows);
}

module.exports = {
  getLatestVerifiedPosition,
  getFundingCandidates,
  classifyFundingCandidates,
  normalizeGroupKey,
};
