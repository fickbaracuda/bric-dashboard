'use strict';

/**
 * Jalankan HANYA setelah backend/scripts/repair-reversal-bank-only-duplicates.js
 * --apply memastikan 0 baris duplicate (batch_id, canonical_transaction_key)
 * tersisa -- CREATE UNIQUE INDEX akan GAGAL (bukan silently skip) kalau
 * masih ada duplikat, jadi script ini aman dijalankan kapan saja (gagal
 * dgn error yang jelas kalau belum waktunya, bukan merusak data).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_reconciliation_canonical_transaction_key_unique.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: unique index (batch_id, canonical_transaction_key) aktif, menggantikan uq_recon_results_natural_key lama.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED (kemungkinan masih ada duplicate canonical_transaction_key -- jalankan repair-reversal-bank-only-duplicates.js --apply dulu):', err.message);
  process.exit(1);
});
