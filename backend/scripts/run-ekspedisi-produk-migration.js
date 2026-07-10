'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/create_ekspedisi_produk.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: ekspedisi_produk_summary/outlet/sync_log/config siap (dibuat atau sudah ada).');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
