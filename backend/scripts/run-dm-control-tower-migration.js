'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/create_dm_control_tower.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: dm_ct_raw_register/aktivasi/trx/sync_log siap (dibuat atau sudah ada).');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
