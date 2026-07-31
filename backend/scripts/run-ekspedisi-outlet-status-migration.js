'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/create_ekspedisi_outlet_status.sql'), 'utf8');
  await pool.query(sql);

  const [statusCount, notesCount] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM ekspedisi_outlet_status'),
    pool.query('SELECT COUNT(*) FROM ekspedisi_outlet_notes'),
  ]);

  console.log('Migration OK: ekspedisi_outlet_status & ekspedisi_outlet_notes siap.');
  console.log(`ekspedisi_outlet_status: ${statusCount.rows[0].count} baris`);
  console.log(`ekspedisi_outlet_notes: ${notesCount.rows[0].count} baris`);

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
