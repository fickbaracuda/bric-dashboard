'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/add_balance_control_tower_funding_scheduler.sql'), 'utf8'
  );
  await pool.query(sql);

  const [hourlyPlan, schedulerPlan, policyCols, alertTypes] = await Promise.all([
    pool.query(`SELECT hour_of_day, average_burn, planned_balance FROM bct_hourly_balance_plan WHERE is_active = TRUE ORDER BY hour_of_day`),
    pool.query(`SELECT scheduled_time, funding_source_code, scheduled_amount, status FROM bct_funding_scheduler_plan WHERE is_active = TRUE ORDER BY scheduled_time`),
    pool.query(`SELECT bank_account_id, funding_plan_variance_tolerance, funding_scheduler_tolerance FROM bct_balance_policies`),
    pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_bct_alerts_type'`),
  ]);

  console.log('Migration OK: bct_hourly_balance_plan, bct_funding_scheduler_plan, bct_funding_recommendation_history siap.');
  console.log(`\nHourly plan aktif: ${hourlyPlan.rows.length} baris (harus 24)`);
  hourlyPlan.rows.forEach(r => console.log(`  ${String(r.hour_of_day).padStart(2, '0')}:00  burn=${r.average_burn}  planned=${r.planned_balance}`));
  console.log(`\nScheduler plan aktif: ${schedulerPlan.rows.length} baris (harus 8)`);
  schedulerPlan.rows.forEach(r => console.log(`  ${r.scheduled_time}  ${r.funding_source_code}  Rp${Number(r.scheduled_amount).toLocaleString('id-ID')}  ${r.status}`));
  console.log('\nToleransi per bank:', JSON.stringify(policyCols.rows));
  console.log('\nalert_type constraint saat ini:', alertTypes.rows[0]?.def);

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
