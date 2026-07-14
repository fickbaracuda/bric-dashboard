'use strict';

/**
 * Perbaikan data recon_results yang terlanjur "cross-date" — akibat bug
 * nyata: runOcbcEngineAndPersist() dulu mengambil recon_bank_archive HANYA
 * difilter bank_code (+account_no), TANPA business_date sama sekali,
 * sehingga baris archive dari tanggal LAIN ikut ditarik ke engine batch
 * aktif dan salah dijadikan BANK_ONLY (atau ikut sbg pasangan match) milik
 * batch yang salah. Bug root cause sudah diperbaiki di
 * backend/src/routes/warroom-reconciliation.js (runOcbcEngineAndPersist kini
 * scoped business_date) — script ini membersihkan recon_results yang SUDAH
 * kadung tersimpan salah SEBELUM fix itu ada.
 *
 * DEFAULT = DRY-RUN. Hanya menampilkan batch mana yang punya recon_results
 * dengan bank_transaction_date != business_date batch-nya sendiri, TIDAK
 * mengubah apa pun.
 *
 * --apply: untuk setiap batch yang terdampak, jalankan ULANG
 * runOcbcEngineAndPersist() (kode yang SUDAH diperbaiki) memakai FP +
 * archive (kini otomatis scoped business_date) batch itu sendiri. Mekanisme
 * upsert-by-natural-key + cleanup stale bawaan runOcbcEngineAndPersist yang
 * membersihkan baris cross-date lama secara otomatis (baris itu tidak akan
 * dihasilkan lagi oleh engine yang sudah diperbaiki, sehingga DELETE
 * stale-nya menghapusnya) — TIDAK ada DELETE manual terpisah di sini, supaya
 * tidak menduplikasi logic cleanup yang sudah teruji.
 *
 * TIDAK PERNAH menyentuh recon_bank_archive (histori tetap permanen) atau
 * menghapus recon_action_logs secara sembarangan (hanya baris yang TIDAK
 * lagi dihasilkan ulang oleh engine yang kena cleanup — sama seperti resync
 * biasa).
 *
 * Usage:
 *   node backend/scripts/repair-reconciliation-cross-date.js
 *   node backend/scripts/repair-reconciliation-cross-date.js --apply
 *   node backend/scripts/repair-reconciliation-cross-date.js --apply --bank-code=OCBC
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/db');
const { runOcbcEngineAndPersist } = require('../src/routes/warroom-reconciliation');

const APPLY = process.argv.includes('--apply');
const bankCodeArg = (process.argv.find(a => a.startsWith('--bank-code=')) || '').split('=')[1];

function buildSnapshotMeta(snap) {
  return snap ? {
    id: snap.id, sourceLimit: snap.source_limit, rowCount: snap.row_count, isTruncated: snap.is_truncated,
    snapshotOldestTime: snap.snapshot_oldest_time, snapshotNewestTime: snap.snapshot_newest_time,
    trustedCoverageStart: snap.trusted_coverage_start, coverageEnd: snap.coverage_end,
    boundaryMinuteStart: snap.trusted_coverage_start ? new Date(new Date(snap.trusted_coverage_start).getTime() - 60000) : null,
    boundaryMinuteEnd: snap.trusted_coverage_start ? new Date(new Date(snap.trusted_coverage_start).getTime() - 1) : null,
  } : {
    id: null, sourceLimit: 5000, rowCount: 0, isTruncated: false,
    snapshotOldestTime: null, snapshotNewestTime: null, trustedCoverageStart: null, coverageEnd: null,
    boundaryMinuteStart: null, boundaryMinuteEnd: null,
  };
}

async function main() {
  const bankCode = bankCodeArg || 'OCBC';
  console.log('='.repeat(70));
  console.log(`Repair Cross-Date Reconciliation Results — bank_code=${bankCode}`);
  console.log(APPLY ? 'MODE: --apply (akan menghapus & regenerasi ulang batch terdampak)' : 'MODE: DRY-RUN (default — hanya menampilkan, TIDAK mengubah apa pun)');
  console.log('='.repeat(70));

  const crossDateRes = await pool.query(
    `SELECT
       r.batch_id,
       b.business_date::text AS business_date,
       b.bank_code,
       b.account_no,
       COUNT(*) AS cross_date_count,
       COUNT(*) FILTER (WHERE r.recon_status = 'BANK_ONLY') AS cross_date_bank_only_count
     FROM recon_results r
     JOIN recon_sync_batches b ON b.id = r.batch_id
     WHERE b.bank_code = $1
       AND r.bank_transaction_date IS NOT NULL
       AND r.bank_transaction_date::text <> b.business_date::text
     GROUP BY r.batch_id, b.business_date, b.bank_code, b.account_no
     ORDER BY b.business_date DESC`,
    [bankCode]
  );

  if (!crossDateRes.rows.length) {
    console.log('\nTidak ditemukan recon_results cross-date. Tidak ada yang perlu diperbaiki.');
    await pool.end();
    return;
  }

  console.log(`\nDitemukan ${crossDateRes.rows.length} batch dengan hasil cross-date:\n`);
  for (const row of crossDateRes.rows) {
    console.log(`  - batch_id=${row.batch_id} business_date=${row.business_date} bank_code=${row.bank_code} account_no=${row.account_no || '(kosong)'}`);
    console.log(`      ${row.cross_date_count} baris cross-date (${row.cross_date_bank_only_count} di antaranya BANK_ONLY)`);
  }

  if (!APPLY) {
    console.log('\nIni DRY-RUN — belum ada perubahan. Jalankan ulang dengan --apply setelah hasil di atas diverifikasi aman.');
    await pool.end();
    return;
  }

  console.log('\n--- Menjalankan perbaikan (--apply) ---\n');

  for (const row of crossDateRes.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const beforeCountRes = await client.query('SELECT COUNT(*) AS c FROM recon_results WHERE batch_id = $1', [row.batch_id]);
      const beforeCount = Number(beforeCountRes.rows[0].c);
      const beforeCrossDateRes = await client.query(
        `SELECT COUNT(*) AS c FROM recon_results WHERE batch_id = $1 AND bank_transaction_date IS NOT NULL AND bank_transaction_date::text <> $2::text`,
        [row.batch_id, row.business_date]
      );
      const beforeCrossDate = Number(beforeCrossDateRes.rows[0].c);

      const snapRes = await client.query(
        'SELECT * FROM recon_bank_snapshots WHERE batch_id = $1 ORDER BY synced_at DESC LIMIT 1',
        [row.batch_id]
      );
      const snapshotMeta = buildSnapshotMeta(snapRes.rows[0]);

      const { resultCount } = await runOcbcEngineAndPersist(client, {
        batchId: row.batch_id, bankCode: row.bank_code, accountNo: row.account_no,
        businessDate: row.business_date, snapshotMeta, configOverride: {}, now: new Date(),
      });

      const afterCountRes = await client.query('SELECT COUNT(*) AS c FROM recon_results WHERE batch_id = $1', [row.batch_id]);
      const afterCount = Number(afterCountRes.rows[0].c);
      const afterCrossDateRes = await client.query(
        `SELECT COUNT(*) AS c FROM recon_results WHERE batch_id = $1 AND bank_transaction_date IS NOT NULL AND bank_transaction_date::text <> $2::text`,
        [row.batch_id, row.business_date]
      );
      const afterCrossDate = Number(afterCrossDateRes.rows[0].c);

      await client.query('COMMIT');

      console.log(`[batch_id=${row.batch_id}, business_date=${row.business_date}] SELESAI.`);
      console.log(`   Jumlah recon_results total   : SEBELUM=${beforeCount}  SESUDAH=${afterCount}  (engine menghasilkan ${resultCount} baris)`);
      console.log(`   Jumlah recon_results cross-date: SEBELUM=${beforeCrossDate}  SESUDAH=${afterCrossDate}`);
      if (afterCrossDate > 0) {
        console.log(`   [PERHATIAN] Masih ada ${afterCrossDate} baris cross-date setelah repair — cek manual, mungkin ada penyebab lain.`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[batch_id=${row.batch_id}] GAGAL: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log('\n=== Repair selesai ===');
  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
