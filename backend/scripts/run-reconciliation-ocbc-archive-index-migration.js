'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_reconciliation_ocbc_archive_business_date_index.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: index (bank_code, account_no, business_date) pada recon_bank_archive siap.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
