'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/add_reconciliation_bni_columns.sql'), 'utf8');
  await pool.query(sql);

  const [batchCols, bankCols, resultCols, constraintRows] = await Promise.all([
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_sync_batches' AND column_name LIKE 'coverage_tolerance_%'`),
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_bank_transactions' AND column_name = ANY(ARRAY['transaction_id_from_hash','transaction_id_from_reference','recipient_name','branch'])`),
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_results' AND column_name = ANY(ARRAY['recipient_name','bank_branch','bank_journal_no','transaction_id_from_hash','transaction_id_from_reference','time_difference_seconds','extraction_confidence'])`),
    pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'`),
  ]);

  console.log('Migration OK: kolom Rekonsiliasi BNI siap.');
  console.log('recon_sync_batches kolom baru:', batchCols.rows.map(r => r.column_name).join(', '));
  console.log('recon_bank_transactions kolom baru:', bankCols.rows.map(r => r.column_name).join(', '));
  console.log('recon_results kolom baru:', resultCols.rows.map(r => r.column_name).join(', '));
  console.log('finance_balance_requests bank_code constraint:', constraintRows.rows[0]?.def || 'TIDAK DITEMUKAN (!)');

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
