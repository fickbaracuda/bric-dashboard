'use strict';

const path = require('path');
// WAJIB path eksplisit — script ini dipanggil dengan cwd di root project,
// sedangkan file .env asli ada di backend/.env (lihat catatan yang sama di
// run-dm-control-tower-migration.js — tanpa ini DATABASE_URL kosong).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/create_quick_win_q3_iqwm.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Migration OK: iqwm_qw_resume/breakdown/sync_log/period_config siap (dibuat atau sudah ada).');
  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
