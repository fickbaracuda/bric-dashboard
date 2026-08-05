'use strict';

/**
 * Balance & Funding — Balance Position Time & Funding Countdown enhancement.
 * DATA-ONLY (tidak ada DDL/migration baru, tabel balance_funding_plans sudah
 * ada). Idempotent: aman dijalankan ulang.
 *
 * Kenapa: OCBC & BCA TIDAK PUNYA timestamp bank-provided ber-presisi jam
 * (recon_bank_transactions OCBC/BCA cuma punya kolom DATE, raw_summary OCBC
 * cuma "RELEASE DATE" tanpa jam -- lihat audit di
 * bankBalanceAdapters.js/resolveDateOnlyPosition & docs/BALANCE_FUNDING.md
 * §18). balance_position_time kedua bank ini sekarang di-anchor ke awal hari
 * (00:00 WIB business_date) -- SATU-SATUNYA instant yang bisa dibuktikan
 * tanpa mengarang jam. Default modul stale_after_minutes (120 menit / 2 jam)
 * TIDAK COCOK utk anchor ini: begitu lewat jam 02:00 WIB SETIAP HARI, OCBC/
 * BCA akan selalu terlihat BALANCE_STALE walau baru saja sync -- regresi
 * nyata dari perilaku sebelumnya (dulu balance_timestamp = sync time, jadi
 * selalu segar).
 *
 * Fix: set stale_after_minutes = 1440 (24 jam) KHUSUS OCBC & BCA. Angka ini
 * dipilih PERSIS supaya secara matematis setara dgn "business_date != hari
 * ini WIB" (0-1439 menit sejak 00:00 = masih business_date hari ini; >=1440
 * menit = business_date sudah berlalu >=1 hari) -- tidak perlu logic
 * precision-aware baru di decision engine (balanceFundingEngine.js TIDAK
 * disentuh sama sekali oleh perubahan ini).
 *
 * Guard `stale_after_minutes IS NULL`: TIDAK menimpa kalau FA sudah pernah
 * kustomisasi manual lewat Manage Plan UI (PUT .../plan) -- hanya mengisi
 * default modul yang belum pernah di-set eksplisit.
 *
 * Run: node backend/scripts/update-balance-funding-stale-threshold-date-precision.js
 */

const pool = require('../src/db');

const DATE_PRECISION_BANKS = ['OCBC', 'BCA'];
const STALE_AFTER_MINUTES = 1440;

async function main() {
  const before = await pool.query(
    `SELECT bank_code, stale_after_minutes FROM balance_funding_plans
     WHERE bank_code = ANY($1) AND is_active = TRUE ORDER BY bank_code`,
    [DATE_PRECISION_BANKS]
  );
  console.log('Sebelum update:', JSON.stringify(before.rows));

  const r = await pool.query(
    `UPDATE balance_funding_plans SET stale_after_minutes = $1, updated_by = $2, updated_at = NOW()
     WHERE bank_code = ANY($3) AND is_active = TRUE AND stale_after_minutes IS NULL
     RETURNING bank_code, stale_after_minutes`,
    [STALE_AFTER_MINUTES, 'system_balance_position_time_enhancement', DATE_PRECISION_BANKS]
  );
  console.log(`Diupdate: ${r.rows.length} plan.`, JSON.stringify(r.rows));

  const skipped = before.rows.filter(b => b.stale_after_minutes !== null && !r.rows.some(u => u.bank_code === b.bank_code));
  if (skipped.length) {
    console.log(`Dilewati (sudah dikustomisasi manual, tidak ditimpa): ${JSON.stringify(skipped)}`);
  }

  const after = await pool.query(
    `SELECT bank_code, stale_after_minutes FROM balance_funding_plans
     WHERE bank_code = ANY($1) AND is_active = TRUE ORDER BY bank_code`,
    [DATE_PRECISION_BANKS]
  );
  console.log('Sesudah update:', JSON.stringify(after.rows));

  await pool.end();
}

main().catch(err => {
  console.error('Update FAILED:', err.message);
  process.exit(1);
});
