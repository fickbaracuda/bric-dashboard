'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/create_warroom_fastpay_outlet.sql'), 'utf8');
  await pool.query(sql);

  const [oldCount, newCount] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM fastpay_snapshot'),
    pool.query('SELECT COUNT(*) FROM warroom_fastpay_outlet'),
  ]);

  console.log('Migration OK: warroom_fastpay_outlet siap.');
  console.log(`fastpay_snapshot (lama, tidak dihapus): ${oldCount.rows[0].count} baris`);
  console.log(`warroom_fastpay_outlet (baru): ${newCount.rows[0].count} baris`);

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
