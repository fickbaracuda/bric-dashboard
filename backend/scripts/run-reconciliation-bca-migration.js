'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/add_reconciliation_bca_columns.sql'), 'utf8');
  await pool.query(sql);

  const [bankCols, resultCols, constraintRows] = await Promise.all([
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_bank_transactions' AND column_name = ANY(ARRAY['extracted_transaction_id','bank_row_type','extraction_method'])`),
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_results' AND column_name = ANY(ARRAY['bank_code','time_difference_minutes'])`),
    pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'`),
  ]);

  console.log('Migration OK: kolom Rekonsiliasi BCA siap (reuse kolom generic, tidak ada kolom baru).');
  console.log('recon_bank_transactions kolom (reuse):', bankCols.rows.map(r => r.column_name).join(', '));
  console.log('recon_results kolom (reuse):', resultCols.rows.map(r => r.column_name).join(', '));
  console.log('finance_balance_requests bank_code constraint:', constraintRows.rows[0]?.def || 'TIDAK DITEMUKAN (!)');

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
