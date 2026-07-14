'use strict';

/**
 * Perbaikan data recon_results yang terlanjur DUPLIKAT per canonical
 * transaction key — akibat bug nyata: unique index LAMA
 * (batch_id, id_transaksi, reference_no) menganggap baris FP-based (mis.
 * REVERSAL, id_transaksi TERISI) dan baris BANK_ONLY (id_transaksi NULL,
 * reference_no SAMA) sbg 2 identitas BERBEDA, padahal keduanya mewakili 1
 * transaksi logis yang sama begitu FP-nya ditemukan/pasangan bank-nya
 * ditemukan.
 *
 * Root cause SUDAH diperbaiki di kode:
 *   - reconcileTransactions()/reconcileTransactionsWithCoverage(): grouping
 *     bank per canonical key (buildOcbcBankGroups) + consumedBankKeys.
 *   - runOcbcEngineAndPersist() & warroom-reconciliation-mandiri.js: upsert
 *     & cleanup stale kini berbasis kolom canonical_transaction_key.
 * Script ini HANYA membersihkan baris yang SUDAH kadung tersimpan duplikat
 * SEBELUM fix itu di-deploy (data historis).
 *
 * DEFAULT = DRY-RUN. Menampilkan setiap kandidat duplikat (batch, canonical
 * key, status yang ditemukan, id row) TANPA mengubah apa pun.
 *
 * --apply: untuk tiap grup duplikat:
 *   1. Pilih row yang DIPERTAHANKAN berdasarkan prioritas status (REVERSAL
 *      di puncak, BANK_ONLY/NEED_REVIEW di bawah — lihat STATUS_PRIORITY_ORDER,
 *      persis urutan yang diminta).
 *   2. Lengkapi field row yang dipertahankan dari row lain kalau field itu
 *      NULL di row yang dipertahankan tapi TERISI di row lain (JANGAN
 *      pernah menimpa field yang sudah terisi dengan NULL).
 *   3. Pindahkan recon_action_logs dari row yang akan DIHAPUS ke row yang
 *      DIPERTAHANKAN (reparent recon_result_id) — riwayat audit TIDAK hilang.
 *   4. Hapus row-row selain yang dipertahankan.
 *   5. Tampilkan before/after count + verifikasi ulang 0 duplikat tersisa.
 *
 * TIDAK PERNAH menyentuh recon_bank_archive. TIDAK menghapus SEMUA
 * BANK_ONLY — hanya baris yang canonical key-nya SUDAH punya pasangan row
 * lain (mis. REVERSAL) dalam batch yang sama.
 *
 * Usage:
 *   node backend/scripts/repair-reversal-bank-only-duplicates.js
 *   node backend/scripts/repair-reversal-bank-only-duplicates.js --apply
 *   node backend/scripts/repair-reversal-bank-only-duplicates.js --apply --bank-code=OCBC
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/db');

const APPLY = process.argv.includes('--apply');
const bankCodeArg = (process.argv.find(a => a.startsWith('--bank-code=')) || '').split('=')[1];

// Prioritas status saat memilih row mana yang DIPERTAHANKAN kalau 1
// canonical key punya >1 row — index lebih kecil = prioritas lebih tinggi
// (persis urutan yang diminta: REVERSAL di puncak).
const STATUS_PRIORITY_ORDER = [
  'REVERSAL', 'DUPLICATE_BANK', 'DUPLICATE_FP', 'NOMINAL_MISMATCH', 'FEE_MISMATCH',
  'MATCHED', 'MATCHED_NO_FEE', 'PENDING_BANK', 'FP_ONLY', 'BANK_ONLY', 'NEED_REVIEW',
];
function statusRank(status) {
  const idx = STATUS_PRIORITY_ORDER.indexOf(status);
  return idx === -1 ? STATUS_PRIORITY_ORDER.length : idx;
}

// Kolom yang boleh "dilengkapi" dari row lain kalau NULL di row yang
// dipertahankan (JANGAN PERNAH menimpa nilai yang sudah terisi dgn NULL).
const FILLABLE_COLUMNS = [
  'id_transaksi', 'reference_no', 'id_outlet', 'id_produk', 'id_biller',
  'fp_nominal', 'fp_time_response', 'bank_transaction_date', 'bank_principal',
  'bank_fee', 'bank_credit', 'bank_total_debit', 'variance_principal', 'variance_fee',
  'matching_method', 'aging_minutes', 'notes', 'time_difference_minutes',
];

async function main() {
  const bankCodeFilter = bankCodeArg || null;
  console.log('='.repeat(70));
  console.log(`Repair Duplicate Canonical Transaction Key${bankCodeFilter ? ` — bank_code=${bankCodeFilter}` : ' (semua bank_code)'}`);
  console.log(APPLY ? 'MODE: --apply (akan melengkapi field, memindahkan audit log, menghapus row duplikat)' : 'MODE: DRY-RUN (default — hanya menampilkan, TIDAK mengubah apa pun)');
  console.log('='.repeat(70));

  const params = [];
  let bankFilterSql = '';
  if (bankCodeFilter) { params.push(bankCodeFilter); bankFilterSql = `AND b.bank_code = $${params.length}`; }

  const dupRes = await pool.query(
    `SELECT r.batch_id, b.business_date::text AS business_date, b.bank_code, r.canonical_transaction_key,
            COUNT(*) AS result_count, ARRAY_AGG(r.recon_status ORDER BY r.id) AS statuses, ARRAY_AGG(r.id ORDER BY r.id) AS ids,
            ARRAY_AGG(r.id_transaksi ORDER BY r.id) AS id_transaksis, ARRAY_AGG(r.reference_no ORDER BY r.id) AS reference_nos
     FROM recon_results r
     JOIN recon_sync_batches b ON b.id = r.batch_id
     WHERE r.canonical_transaction_key IS NOT NULL ${bankFilterSql}
     GROUP BY r.batch_id, b.business_date, b.bank_code, r.canonical_transaction_key
     HAVING COUNT(*) > 1
     ORDER BY b.business_date DESC, r.canonical_transaction_key`,
    params
  );

  if (!dupRes.rows.length) {
    console.log('\nTidak ditemukan duplicate canonical_transaction_key. Tidak ada yang perlu diperbaiki.');
    await pool.end();
    return;
  }

  console.log(`\nDitemukan ${dupRes.rows.length} canonical_transaction_key duplikat:\n`);
  for (const row of dupRes.rows) {
    console.log(`  - batch_id=${row.batch_id} business_date=${row.business_date} bank_code=${row.bank_code} canonical_key=${row.canonical_transaction_key}`);
    console.log(`      result_count=${row.result_count} statuses=${JSON.stringify(row.statuses)} ids=${JSON.stringify(row.ids)}`);
    console.log(`      id_transaksis=${JSON.stringify(row.id_transaksis)} reference_nos=${JSON.stringify(row.reference_nos)}`);
  }

  if (!APPLY) {
    console.log('\nIni DRY-RUN — belum ada perubahan. Jalankan ulang dengan --apply setelah hasil di atas diverifikasi aman.');
    await pool.end();
    return;
  }

  console.log('\n--- Menjalankan perbaikan (--apply) ---\n');

  let totalRowsBefore = 0, groupsRepaired = 0, totalDeleted = 0;

  for (const row of dupRes.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const rowsRes = await client.query('SELECT * FROM recon_results WHERE id = ANY($1::bigint[]) ORDER BY id', [row.ids]);
      const candidates = rowsRes.rows;
      if (candidates.length <= 1) { await client.query('ROLLBACK'); continue; } // sudah berubah sejak diagnostic, lewati

      candidates.sort((a, b) => {
        const rankDiff = statusRank(a.recon_status) - statusRank(b.recon_status);
        if (rankDiff !== 0) return rankDiff;
        return a.id - b.id; // seri -> pertahankan row lebih lama (id terkecil)
      });
      const keep = candidates[0];
      const drop = candidates.slice(1);

      totalRowsBefore += candidates.length;

      // Lengkapi field NULL di `keep` dari row lain — JANGAN PERNAH menimpa
      // nilai yang sudah terisi dengan NULL.
      const fillValues = {};
      for (const col of FILLABLE_COLUMNS) {
        if (keep[col] !== null && keep[col] !== undefined) continue;
        for (const other of drop) {
          if (other[col] !== null && other[col] !== undefined) { fillValues[col] = other[col]; break; }
        }
      }
      const fillCols = Object.keys(fillValues);
      if (fillCols.length) {
        const setClause = fillCols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await client.query(`UPDATE recon_results SET ${setClause}, updated_at = NOW() WHERE id = $1`, [keep.id, ...fillCols.map(c => fillValues[c])]);
      }

      // Pindahkan audit log dari row yang akan dihapus ke row yang dipertahankan.
      const dropIds = drop.map(d => d.id);
      await client.query('UPDATE recon_action_logs SET recon_result_id = $1 WHERE recon_result_id = ANY($2::bigint[])', [keep.id, dropIds]);

      const delRes = await client.query('DELETE FROM recon_results WHERE id = ANY($1::bigint[])', [dropIds]);

      await client.query('COMMIT');

      groupsRepaired += 1;
      totalDeleted += delRes.rowCount;

      console.log(`[batch_id=${row.batch_id} canonical_key=${row.canonical_transaction_key}] SELESAI.`);
      console.log(`   Dipertahankan: id=${keep.id} status=${keep.recon_status} (field dilengkapi: ${fillCols.length ? fillCols.join(', ') : '-'})`);
      console.log(`   Dihapus: ${dropIds.length} row (id=${JSON.stringify(dropIds)}), audit log dipindahkan ke id=${keep.id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[batch_id=${row.batch_id} canonical_key=${row.canonical_transaction_key}] GAGAL: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`\n=== Repair selesai — ${groupsRepaired} grup diperbaiki, ${totalRowsBefore} baris duplikat awal -> ${totalDeleted} baris dihapus ===`);

  const verifyRes = await pool.query(
    `SELECT COUNT(*) AS c FROM (
       SELECT r.batch_id, r.canonical_transaction_key FROM recon_results r
       JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE r.canonical_transaction_key IS NOT NULL ${bankFilterSql}
       GROUP BY r.batch_id, r.canonical_transaction_key HAVING COUNT(*) > 1
     ) t`,
    params
  );
  console.log(`Verifikasi ulang: ${verifyRes.rows[0].c} canonical_transaction_key masih duplikat (harus 0 sebelum menjalankan migration unique index baru).`);

  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
