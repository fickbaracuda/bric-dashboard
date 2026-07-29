'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_balance_control_tower_operational_engine.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: kolom operational engine (policy + forecast_snapshots) siap.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
