'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_reconciliation_canonical_transaction_key.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: kolom canonical_transaction_key ditambahkan + di-backfill pada recon_results.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
