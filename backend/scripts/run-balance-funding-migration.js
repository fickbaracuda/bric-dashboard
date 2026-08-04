'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/create_balance_funding.sql'), 'utf8');
  await pool.query(sql);

  const [plans, hourly, schedules] = await Promise.all([
    pool.query(`SELECT id, bank_code, plan_name, opening_balance, is_active FROM balance_funding_plans ORDER BY bank_code`),
    pool.query(`SELECT hour_of_day, nominal_average, planned_balance FROM balance_funding_hourly_plan hp
                JOIN balance_funding_plans p ON p.id = hp.plan_id WHERE p.bank_code='OCBC' AND p.is_active=TRUE ORDER BY hour_of_day`),
    pool.query(`SELECT scheduled_time, funding_source_code, scheduled_amount, status FROM balance_funding_schedules s
                JOIN balance_funding_plans p ON p.id = s.plan_id WHERE p.bank_code='OCBC' AND p.is_active=TRUE AND s.is_active=TRUE ORDER BY scheduled_time`),
  ]);

  console.log('Migration OK: balance_funding_plans, balance_funding_hourly_plan, balance_funding_schedules, balance_funding_recommendations, balance_funding_alerts, balance_funding_audit_log siap.');
  console.log('\nPlans:', JSON.stringify(plans.rows));
  console.log(`\nOCBC hourly plan: ${hourly.rows.length} baris (harus 24)`);
  hourly.rows.forEach(r => console.log(`  ${String(r.hour_of_day).padStart(2, '0')}:00  avg=${r.nominal_average}  planned=${r.planned_balance}`));
  console.log(`\nOCBC schedules: ${schedules.rows.length} baris (harus 10)`);
  schedules.rows.forEach(r => console.log(`  ${r.scheduled_time}  ${r.funding_source_code}  Rp${Number(r.scheduled_amount).toLocaleString('id-ID')}  ${r.status}`));

  await pool.end();
}

main().catch(err => {
  console.error('Migration FAILED:', err.message);
  process.exit(1);
});
