'use strict';

const path = require('path');
// WAJIB load .env dengan path eksplisit (relatif ke lokasi file ini), BUKAN
// mengandalkan dotenv default yang membaca dari process.cwd() — script ini
// dipanggil dengan working directory di root project (`cd project && node
// backend/scripts/...`), sedangkan file env sebenarnya ada di backend/.env.
// Tanpa ini, DATABASE_URL kosong dan koneksi database gagal (SASL error).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
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
