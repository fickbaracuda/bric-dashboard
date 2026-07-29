'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_balance_control_tower_policy_thresholds.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: kolom critical/emergency/reserve/sudden-drop policy + reserve_source snapshot siap.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
