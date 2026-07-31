'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/create_ekspedisi_monthly.sql'), 'utf8');
  await pool.query(sql);

  const [oldCount, newCount, bulanList] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM ekspedisi_snapshot'),
    pool.query('SELECT COUNT(*) FROM ekspedisi_monthly'),
    pool.query('SELECT bulan, COUNT(*) FROM ekspedisi_monthly GROUP BY bulan ORDER BY bulan'),
  ]);

  console.log('Migration OK: ekspedisi_monthly siap.');
  console.log(`ekspedisi_snapshot (lama, tidak dihapus): ${oldCount.rows[0].count} baris`);
  console.log(`ekspedisi_monthly (baru): ${newCount.rows[0].count} baris`);
  console.log('Distribusi per bulan:', bulanList.rows);

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
