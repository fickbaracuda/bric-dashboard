'use strict';

/**
 * Recompute `row_fingerprint` utk SELURUH recon_bank_archive memakai
 * computeBankRowFingerprint() versi TERBARU (Description dinormalisasi —
 * strip tanda baca/spasi, uppercase — supaya variasi apostrof pada nama
 * pelanggan, mis. "A'ISYAH" vs "AISYAH", tidak lagi dianggap 2 mutasi
 * bank berbeda). Insiden nyata: mutasi bank yang IDENTIK (reference_no,
 * jam, debit/credit sama persis) tersimpan sbg 2 baris archive terpisah
 * hanya krn Description-nya kebetulan beda tanda baca antar sync —
 * menyebabkan `bankByRef` menemukan >1 "principal" candidate ->
 * `DUPLICATE_BANK` palsu.
 *
 * WAJIB dijalankan SEKALI setelah deploy fix normalizeDescriptionForFingerprint()
 * di warroom-reconciliation.js — kalau tidak, baris archive LAMA (fingerprint
 * dihitung dgn algoritma lama, dari Description mentah) tidak akan pernah
 * di-upsert (ON CONFLICT row_fingerprint) oleh sync berikutnya yang sudah
 * pakai fingerprint baru (ter-normalisasi) — malah akan INSERT baris BARU
 * lagi, menambah duplikat, bukan memperbaikinya.
 *
 * DEFAULT = DRY-RUN. Menampilkan ringkasan (berapa baris fingerprint-nya
 * cuma di-refresh tanpa collision, berapa grup collision/duplikat yang
 * akan di-merge) TANPA mengubah apa pun.
 *
 * --apply:
 *   1. Baris yang fingerprint barunya TIDAK collide dgn baris lain -> cukup
 *      UPDATE kolom row_fingerprint in-place (row_fingerprint refresh, id
 *      SAMA, tidak ada data hilang).
 *   2. Baris yang fingerprint barunya SAMA dgn baris lain (collision, mis.
 *      2 baris utk mutasi bank yg SAMA persis) -> gabung jadi 1: pertahankan
 *      baris dgn first_seen_at PALING AWAL (row_fingerprint di-update ke
 *      versi baru, last_seen_at diambil paling baru di antara yg di-merge),
 *      baris lainnya DIHAPUS.
 *
 * TIDAK PERNAH menyentuh recon_results/recon_action_logs — archive murni
 * data mentah histori, tidak ada FK dari tabel lain ke recon_bank_archive.
 *
 * Usage:
 *   node backend/scripts/repair-bank-archive-fingerprint.js
 *   node backend/scripts/repair-bank-archive-fingerprint.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/db');
const { computeBankRowFingerprint } = require('../src/routes/warroom-reconciliation');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log('='.repeat(70));
  console.log('Repair Bank Archive Fingerprint (Description ternormalisasi)');
  console.log(APPLY ? 'MODE: --apply (akan update fingerprint & merge duplikat)' : 'MODE: DRY-RUN (default — hanya menampilkan, TIDAK mengubah apa pun)');
  console.log('='.repeat(70));

  const res = await pool.query(
    `SELECT *, business_date::text AS business_date, value_date::text AS value_date FROM recon_bank_archive ORDER BY id`
  );
  const rows = res.rows;
  console.log(`\nTotal baris archive: ${rows.length}`);

  const groups = new Map(); // newFingerprint -> [row...]
  for (const r of rows) {
    const newFingerprint = computeBankRowFingerprint({
      bankCode: r.bank_code,
      accountNo: r.account_no,
      transactionDateTime: r.transaction_date_time ? new Date(r.transaction_date_time) : null,
      valueDate: r.value_date,
      referenceNo: r.reference_no,
      description: r.description,
      debit: r.debit !== null ? Number(r.debit) : null,
      credit: r.credit !== null ? Number(r.credit) : null,
    });
    if (!groups.has(newFingerprint)) groups.set(newFingerprint, []);
    groups.get(newFingerprint).push({ ...r, newFingerprint });
  }

  const unchanged = [];
  const needsRefreshOnly = [];
  const collisions = [];
  for (const g of groups.values()) {
    if (g.length > 1) { collisions.push(g); continue; }
    if (g[0].row_fingerprint === g[0].newFingerprint) unchanged.push(g[0]);
    else needsRefreshOnly.push(g[0]);
  }

  console.log(`Baris tidak berubah (fingerprint sudah sesuai algoritma baru): ${unchanged.length}`);
  console.log(`Baris perlu refresh fingerprint saja (tidak collide dgn baris lain): ${needsRefreshOnly.length}`);
  console.log(`Grup collision (duplikat, perlu di-merge): ${collisions.length}\n`);

  for (const g of collisions) {
    console.log(`  - reference_no=${g[0].reference_no} debit=${g[0].debit} credit=${g[0].credit} ids=${JSON.stringify(g.map(r => r.id))}`);
    console.log(`      descriptions=${JSON.stringify(g.map(r => r.description))}`);
  }

  if (!APPLY) {
    console.log('\nIni DRY-RUN — belum ada perubahan. Jalankan ulang dengan --apply setelah hasil di atas diverifikasi aman.');
    await pool.end();
    return;
  }

  console.log('\n--- Menjalankan perbaikan (--apply) ---\n');

  let refreshed = 0;
  for (const row of needsRefreshOnly) {
    await pool.query('UPDATE recon_bank_archive SET row_fingerprint = $1 WHERE id = $2', [row.newFingerprint, row.id]);
    refreshed++;
  }
  console.log(`Fingerprint di-refresh (tanpa merge): ${refreshed} baris.`);

  let merged = 0;
  for (const g of collisions) {
    g.sort((a, b) => new Date(a.first_seen_at) - new Date(b.first_seen_at));
    const keep = g[0];
    const drop = g.slice(1);
    const latestSeenAt = g.reduce((max, r) => (new Date(r.last_seen_at) > max ? new Date(r.last_seen_at) : max), new Date(keep.last_seen_at));
    await pool.query(
      'UPDATE recon_bank_archive SET row_fingerprint = $1, last_seen_at = $2 WHERE id = $3',
      [keep.newFingerprint, latestSeenAt, keep.id]
    );
    const dropIds = drop.map(d => d.id);
    await pool.query('DELETE FROM recon_bank_archive WHERE id = ANY($1::bigint[])', [dropIds]);
    merged += dropIds.length;
    console.log(`[reference_no=${keep.reference_no}] dipertahankan id=${keep.id}, dihapus ${dropIds.length} duplikat (id=${JSON.stringify(dropIds)}).`);
  }

  console.log(`\n=== Repair selesai — ${refreshed} fingerprint di-refresh, ${collisions.length} grup di-merge (${merged} baris duplikat dihapus) ===`);

  const verifyRes = await pool.query(
    `SELECT bank_code, account_no, reference_no, transaction_date_time, debit, credit, COUNT(*) AS c
     FROM recon_bank_archive
     GROUP BY bank_code, account_no, reference_no, transaction_date_time, value_date, debit, credit
     HAVING COUNT(*) > 1`
  );
  console.log(`Verifikasi ulang: ${verifyRes.rows.length} grup (bank_code/account_no/reference_no/jam/debit/credit) masih punya >1 baris archive (harus 0).`);

  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
