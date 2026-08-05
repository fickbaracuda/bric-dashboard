'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/create_mgm_pa_control_tower.sql'),
    'utf8'
  );
  await pool.query(sql);

  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (
      'mgm_pa_registrasi', 'mgm_pa_aktivasi', 'mgm_pa_aktivasi_detail',
      'mgm_pa_sync_runs', 'mgm_pa_actions', 'mgm_pa_pb_targets'
    )
    ORDER BY table_name
  `);
  console.log(`Migration OK: ${rows.length}/6 tabel MGM PA Control Tower (mgm_pa_*) siap:`);
  rows.forEach(r => console.log(`  - ${r.table_name}`));

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
