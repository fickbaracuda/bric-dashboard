'use strict';

/**
 * Reprocess 1 batch OCBC (business_date tertentu) yang SUDAH ADA di DB,
 * memakai engine yang SUDAH diperbaiki (resolveOcbcTransactionDateTime tidak
 * lagi mempercayai jam palsu 00:00 dari sel date-only, + dedupe logis archive
 * di dedupeOcbcArchiveRowsForMatching) -- supaya recon_results lama yang
 * masih terkontaminasi DUPLICATE_BANK palsu ikut terkoreksi TANPA perlu
 * resync ulang dari Google Sheet.
 *
 * TIDAK ADA rumus matching baru ditulis di sini -- script ini REUSE
 * runOcbcEngineAndPersist() yang SAMA PERSIS dipakai oleh chunk terakhir
 * syncHandler OCBC (lihat backend/src/routes/warroom-reconciliation.js),
 * supaya preview dry-run TIDAK PERNAH bisa berbeda dari apa yang akan benar2
 * terjadi saat --apply.
 *
 * DEFAULT = DRY-RUN. Seluruh proses (termasuk pemanggilan
 * runOcbcEngineAndPersist, yang menulis recon_results) tetap dijalankan di
 * dalam SATU transaction supaya distribusi AFTER bisa dihitung dari state DB
 * yang sungguhan -- tapi transaction itu SELALU di-ROLLBACK di akhir kalau
 * --apply tidak diberikan, sehingga TIDAK ADA perubahan permanen apa pun.
 *
 * --apply: transaction di-COMMIT setelah preview yang sama ditampilkan.
 *
 * Safety:
 *   - TIDAK PERNAH menyentuh recon_bank_archive / recon_fp_transactions /
 *     recon_bank_transactions (raw & archive data tetap utuh).
 *   - TIDAK PERNAH DELETE recon_results di luar cleanup "stale" bawaan
 *     runOcbcEngineAndPersist (canonical key yang tidak lagi dihasilkan
 *     ulang oleh engine).
 *   - Dry-run TIDAK meninggalkan jejak perubahan apa pun di database
 *     (ROLLBACK selalu dipanggil kecuali --apply).
 *
 * Usage:
 *   node backend/scripts/reprocess-ocbc-batch.js --date=2026-07-29
 *   node backend/scripts/reprocess-ocbc-batch.js --date=2026-07-29 --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/db');
const { runOcbcEngineAndPersist, RECON_STATUSES } = require('../src/routes/warroom-reconciliation');

const APPLY = process.argv.includes('--apply');
const dateArg = (process.argv.find(a => a.startsWith('--date=')) || '').split('=')[1];
const BANK_CODE = 'OCBC';

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

// Formula SAMA PERSIS dgn actionable_exception_count di analyticsHandler
// (lihat warroom-reconciliation.js ~line 1568-1573): hanya baris FP asli
// (id_transaksi bukan null), coverage IN_BANK_COVERAGE (atau belum diisi),
// is_actionable=true, dan bukan MATCHED/MATCHED_NO_FEE.
async function fetchDistribution(client, batchId) {
  const res = await client.query(
    `SELECT recon_status, coverage_status, is_actionable, id_transaksi
     FROM recon_results WHERE batch_id = $1`,
    [batchId]
  );
  const byStatus = {};
  for (const s of RECON_STATUSES) byStatus[s] = 0;
  let actionableCount = 0;
  for (const r of res.rows) {
    if (byStatus[r.recon_status] === undefined) byStatus[r.recon_status] = 0;
    byStatus[r.recon_status]++;
    const inCoverage = r.coverage_status === 'IN_BANK_COVERAGE' || r.coverage_status === null;
    if (r.id_transaksi !== null && inCoverage && r.is_actionable && !['MATCHED', 'MATCHED_NO_FEE'].includes(r.recon_status)) {
      actionableCount++;
    }
  }
  return { total: res.rows.length, byStatus, actionableCount };
}

function printDistribution(label, dist) {
  console.log(`\n${label} (total=${dist.total}, actionable_count=${dist.actionableCount}):`);
  for (const s of RECON_STATUSES) {
    if (dist.byStatus[s]) console.log(`   ${s.padEnd(20)} : ${dist.byStatus[s]}`);
  }
}

async function main() {
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error('Usage: node backend/scripts/reprocess-ocbc-batch.js --date=YYYY-MM-DD [--apply]');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log(`Reprocess OCBC Batch — business_date=${dateArg}`);
  console.log(APPLY ? 'MODE: --apply (perubahan akan DI-COMMIT permanen)' : 'MODE: DRY-RUN (default — engine dijalankan utk preview, TAPI di-ROLLBACK, TIDAK ada perubahan permanen)');
  console.log('='.repeat(70));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchRes = await client.query(
      `SELECT * FROM recon_sync_batches WHERE bank_code = $1 AND business_date = $2 FOR UPDATE`,
      [BANK_CODE, dateArg]
    );
    const batch = batchRes.rows[0];
    if (!batch) {
      console.error(`Tidak ada batch OCBC utk business_date ${dateArg}.`);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }
    const batchId = batch.id;
    console.log(`\nBatch ditemukan: id=${batchId}, account_no=${batch.account_no || '(kosong)'}, status=${batch.status}`);

    const before = await fetchDistribution(client, batchId);
    printDistribution('SEBELUM (BEFORE)', before);

    const snapRes = await client.query(
      'SELECT * FROM recon_bank_snapshots WHERE batch_id = $1 ORDER BY synced_at DESC LIMIT 1',
      [batchId]
    );
    const snapshotMeta = buildSnapshotMeta(snapRes.rows[0]);

    const { resultCount } = await runOcbcEngineAndPersist(client, {
      batchId, bankCode: BANK_CODE, accountNo: batch.account_no,
      businessDate: dateArg, snapshotMeta, configOverride: {}, now: new Date(),
    });
    console.log(`\nEngine dijalankan ulang: ${resultCount} baris hasil.`);

    const after = await fetchDistribution(client, batchId);
    printDistribution('SESUDAH (AFTER)', after);

    console.log('\nPerubahan per status:');
    let anyChange = false;
    for (const s of RECON_STATUSES) {
      const b = before.byStatus[s] || 0;
      const a = after.byStatus[s] || 0;
      if (b !== a) { anyChange = true; console.log(`   ${s.padEnd(20)} : ${b} -> ${a}  (${a - b >= 0 ? '+' : ''}${a - b})`); }
    }
    if (!anyChange) console.log('   (tidak ada perubahan distribusi status)');
    console.log(`   actionable_count       : ${before.actionableCount} -> ${after.actionableCount}  (${after.actionableCount - before.actionableCount >= 0 ? '+' : ''}${after.actionableCount - before.actionableCount})`);

    if (!APPLY) {
      await client.query('ROLLBACK');
      console.log('\nIni DRY-RUN — semua di atas di-ROLLBACK, TIDAK ada perubahan permanen. Jalankan ulang dengan --apply setelah hasil ini diverifikasi aman.');
    } else {
      await client.query('COMMIT');
      console.log('\n--apply: perubahan di atas SUDAH DI-COMMIT.');
    }
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
