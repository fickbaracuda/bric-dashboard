'use strict';

const fs   = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/add_reconciliation_bri_bifast_columns.sql'), 'utf8');
  await pool.query(sql);

  const [fpCol, bankCols, resultCols, constraintRows] = await Promise.all([
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_fp_transactions' AND column_name = 'bill_info1'`),
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_bank_transactions' AND column_name LIKE ANY (ARRAY['beneficiary_account','bank_trace_id','transfer_group_key'])`),
    pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'recon_results' AND column_name LIKE ANY (ARRAY['fp_bill_info1','bank_beneficiary_account','time_order_status'])`),
    pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_finance_balance_requests_bank_code'`),
  ]);

  console.log('Migration OK: kolom Rekonsiliasi BRI BI-FAST siap.');
  console.log('recon_fp_transactions.bill_info1:', fpCol.rows.length ? 'ADA' : 'TIDAK ADA (!)');
  console.log('recon_bank_transactions kolom baru:', bankCols.rows.map(r => r.column_name).join(', '));
  console.log('recon_results kolom baru:', resultCols.rows.map(r => r.column_name).join(', '));
  console.log('finance_balance_requests bank_code constraint:', constraintRows.rows[0]?.def || 'TIDAK DITEMUKAN (!)');

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
