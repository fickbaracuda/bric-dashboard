'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_reconciliation_ocbc_coverage.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: coverage-aware reconciliation + rolling bank archive (recon_bank_archive, recon_bank_snapshots, kolom baru recon_results/recon_bank_transactions) siap.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
