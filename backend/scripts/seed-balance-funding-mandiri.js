'use strict';

/**
 * Balance & Funding — seed baseline plan MANDIRI. DATA-ONLY (tidak ada DDL,
 * tabel balance_funding_* sudah ada dari create_balance_funding.sql).
 * Idempotent: aman dijalankan ulang (ON CONFLICT DO UPDATE utk plan/hourly,
 * ON CONFLICT DO NOTHING utk scheduler supaya tidak duplikat tiap run --
 * kalau perlu update scheduler pakai endpoint admin PUT existing).
 *
 * Angka divalidasi manual sebelum seed ini ditulis (24/24 baris cocok
 * dengan formula prev_planned + scheduler - nominal_average = current_planned,
 * toleransi Rp1) -- lihat docs/BALANCE_FUNDING.md bagian Mandiri.
 *
 * Catatan 19:00: source mentah FA menulis label "Data Schedule 18:00" utk
 * funding Rp300jt, tapi validasi matematis 24 baris HANYA konsisten kalau
 * funding itu masuk di baris 19:00 (18:00 sendiri valid TANPA scheduler:
 * 349132566 - 154325742 = 194806824, cocok persis; 19:00 HANYA cocok kalau
 * +300jt: 194806824 + 300000000 - 168905616 = 325901208, cocok persis).
 * scheduled_time diset 19:00, catatan discrepancy disimpan di kolom `note`.
 *
 * Run: node backend/scripts/seed-balance-funding-mandiri.js
 */

const pool = require('../src/db');

const BANK_CODE = 'MANDIRI';
const OPENING_BALANCE = 200000000;

const HOURLY_PLAN = [
  { hour: 0, avg: 0, trf: null, planned: 200000000 },
  { hour: 1, avg: 0, trf: null, planned: 200000000 },
  { hour: 2, avg: 0, trf: null, planned: 200000000 },
  { hour: 3, avg: 0, trf: null, planned: 200000000 },
  { hour: 4, avg: 0, trf: null, planned: 200000000 },
  { hour: 5, avg: 69846664, trf: 69846664, planned: 280153336 },
  { hour: 6, avg: 16512556, trf: null, planned: 263640780 },
  { hour: 7, avg: 109210049, trf: 125722605, planned: 304430731 },
  { hour: 8, avg: 133352061, trf: null, planned: 171078670 },
  { hour: 9, avg: 177751110, trf: 311103171, planned: 293327560 },
  { hour: 10, avg: 198012542, trf: null, planned: 95315018 },
  { hour: 11, avg: 109536265, trf: 307548807, planned: 285778753 },
  { hour: 12, avg: 131177461, trf: null, planned: 154601292 },
  { hour: 13, avg: 76144273, trf: 207321734, planned: 278457019 },
  { hour: 14, avg: 97408968, trf: null, planned: 181048051 },
  { hour: 15, avg: 104362960, trf: 201771928, planned: 276685091 },
  { hour: 16, avg: 103322079, trf: null, planned: 173363012 },
  { hour: 17, avg: 124230446, trf: 227552525, planned: 349132566 },
  { hour: 18, avg: 154325742, trf: null, planned: 194806824 },
  { hour: 19, avg: 168905616, trf: 323231358, planned: 325901208 },
  { hour: 20, avg: 107143604, trf: null, planned: 218757604 },
  { hour: 21, avg: 102199771, trf: 209343375, planned: 366557833 },
  { hour: 22, avg: 29855806, trf: 29855806, planned: 336702027 },
  { hour: 23, avg: 0, trf: null, planned: 336702027 },
];

const SCHEDULES = [
  { time: '05:00', source: 'MANDIRI', amount: 150000000, note: null },
  { time: '07:00', source: 'MANDIRI', amount: 150000000, note: null },
  { time: '09:00', source: 'MANDIRI', amount: 300000000, note: null },
  { time: '11:00', source: 'MANDIRI', amount: 300000000, note: null },
  { time: '13:00', source: 'MANDIRI', amount: 200000000, note: null },
  { time: '15:00', source: 'MANDIRI', amount: 200000000, note: null },
  { time: '17:00', source: 'MANDIRI', amount: 300000000, note: null },
  {
    time: '19:00', source: 'MANDIRI', amount: 300000000,
    note: 'Source data FA menulis label "Data Schedule 18:00" untuk funding ini. Validasi matematis 24 baris hourly plan HANYA konsisten kalau funding masuk di baris 19:00 (18:00 valid tanpa scheduler apa pun; 19:00 hanya cocok +Rp300jt). scheduled_time diset 19:00 mengikuti bukti matematis, bukan label mentah.',
  },
  { time: '21:00', source: 'BRI', amount: 250000000, note: 'Funding source BRI, target bank tetap MANDIRI.' },
];

// ── Validasi 24 baris SEBELUM tulis apa pun (fail loud kalau ada mismatch) ──
function validate() {
  let prev = OPENING_BALANCE;
  const schedByHour = new Map(SCHEDULES.map(s => [parseInt(s.time.slice(0, 2), 10), s.amount]));
  const errors = [];
  for (const row of HOURLY_PLAN) {
    const scheduler = schedByHour.get(row.hour) || 0;
    const computed = prev + scheduler - row.avg;
    if (Math.abs(computed - row.planned) > 1) {
      errors.push(`hour=${row.hour}: computed=${computed} vs source planned=${row.planned} (diff=${computed - row.planned})`);
    }
    prev = row.planned; // pakai planned_balance SOURCE (bukan computed) sbg basis baris berikutnya -- source of truth
  }
  if (errors.length) {
    console.error('VALIDASI GAGAL, seed DIBATALKAN:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('Validasi 24 baris: OK (0 mismatch, toleransi Rp1).');
}

async function main() {
  validate();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Plan aktif -- upsert (tidak duplikat kalau sudah ada, sesuai pola PUT /plan existing)
    const existingPlanRes = await client.query(
      `SELECT * FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE FOR UPDATE`,
      [BANK_CODE]
    );
    const beforePlan = existingPlanRes.rows[0] || null;
    const planRes = await client.query(
      `INSERT INTO balance_funding_plans (bank_code, plan_name, opening_balance, source, is_active, created_by)
       VALUES ($1,$2,$3,'MANUAL',TRUE,$4)
       ON CONFLICT (bank_code) WHERE is_active = TRUE DO UPDATE SET
         opening_balance = EXCLUDED.opening_balance, updated_by = $4, updated_at = NOW()
       RETURNING *`,
      [BANK_CODE, BANK_CODE, OPENING_BALANCE, 'system_seed_mandiri_baseline']
    );
    const plan = planRes.rows[0];
    console.log(`Plan MANDIRI: id=${plan.id} ${beforePlan ? '(update, sudah ada sebelumnya)' : '(baru dibuat)'}`);

    // Hourly plan -- upsert per jam (24 baris, tidak duplikat)
    for (const row of HOURLY_PLAN) {
      await client.query(
        `INSERT INTO balance_funding_hourly_plan (plan_id, hour_of_day, hour_label, nominal_average, transaksi_trf, planned_balance)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (plan_id, hour_of_day) DO UPDATE SET
           hour_label = EXCLUDED.hour_label, nominal_average = EXCLUDED.nominal_average,
           transaksi_trf = EXCLUDED.transaksi_trf, planned_balance = EXCLUDED.planned_balance, updated_at = NOW()`,
        [plan.id, row.hour, `${String(row.hour).padStart(2, '0')}:00 - ${String(row.hour).padStart(2, '0')}:59`, row.avg, row.trf, row.planned]
      );
    }
    console.log(`Hourly plan: ${HOURLY_PLAN.length} baris upsert.`);

    // Scheduler -- ON CONFLICT DO NOTHING (tidak menimpa status/actual_amount kalau FA sudah pernah update manual lewat UI)
    let schedCreated = 0, schedSkipped = 0;
    for (const s of SCHEDULES) {
      const r = await client.query(
        `INSERT INTO balance_funding_schedules (plan_id, target_bank_code, funding_source_code, scheduled_time, scheduled_amount, status, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,'SCHEDULED',$6,$7,$7)
         ON CONFLICT (plan_id, scheduled_time) WHERE is_active = TRUE DO NOTHING
         RETURNING id`,
        [plan.id, BANK_CODE, s.source, s.time, s.amount, s.note, 'system_seed_mandiri_baseline']
      );
      if (r.rows.length) schedCreated++; else schedSkipped++;
    }
    console.log(`Scheduler: ${schedCreated} dibuat baru, ${schedSkipped} sudah ada sebelumnya (dilewati, tidak ditimpa).`);

    await client.query(
      `INSERT INTO balance_funding_audit_log (entity_type, entity_id, action, actor_username, notes)
       VALUES ('BALANCE_FUNDING_PLAN', $1, 'SEED_BASELINE', 'system_seed_mandiri_baseline', 'Seed baseline Mandiri: opening 200jt, 24 hourly rows, 9 scheduler (8 MANDIRI + 1 BRI di 21:00)')`,
      [plan.id]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Verifikasi akhir
  const finalPlan = await pool.query(`SELECT * FROM balance_funding_plans WHERE bank_code=$1 AND is_active=TRUE`, [BANK_CODE]);
  const finalHourly = await pool.query(`SELECT hour_of_day, nominal_average, planned_balance FROM balance_funding_hourly_plan WHERE plan_id=$1 ORDER BY hour_of_day`, [finalPlan.rows[0].id]);
  const finalSched = await pool.query(`SELECT scheduled_time, funding_source_code, scheduled_amount, note FROM balance_funding_schedules WHERE plan_id=$1 AND is_active=TRUE ORDER BY scheduled_time`, [finalPlan.rows[0].id]);
  console.log(`\n=== VERIFIKASI AKHIR ===`);
  console.log(`Plan aktif: ${JSON.stringify(finalPlan.rows[0])}`);
  console.log(`Hourly rows: ${finalHourly.rows.length} (harus 24)`);
  console.log(`Scheduler rows: ${finalSched.rows.length} (harus 9)`);
  finalSched.rows.forEach(r => console.log(`  ${r.scheduled_time}  ${r.funding_source_code}  Rp${Number(r.scheduled_amount).toLocaleString('id-ID')}${r.note ? '  [note]' : ''}`));

  await pool.end();
}

main().catch(err => {
  console.error('Seed FAILED:', err.message);
  process.exit(1);
});
