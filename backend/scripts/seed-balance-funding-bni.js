'use strict';

/**
 * Balance & Funding — seed baseline plan BNI. DATA-ONLY (tidak ada DDL,
 * tabel balance_funding_* sudah ada dari create_balance_funding.sql).
 * Idempotent: aman dijalankan ulang (ON CONFLICT DO UPDATE utk plan/hourly,
 * ON CONFLICT DO NOTHING utk scheduler supaya tidak duplikat tiap run --
 * kalau perlu update scheduler pakai endpoint admin PUT existing).
 *
 * Angka divalidasi manual sebelum seed ini ditulis (24/24 baris cocok
 * dengan formula prev_planned + scheduler - nominal_average = current_planned,
 * toleransi Rp1, 0 mismatch) -- lihat docs/BALANCE_FUNDING.md bagian BNI.
 *
 * PENTING -- BNI SELALU BALANCE_UNAVAILABLE (bukan bug, struktural, lihat
 * bankBalanceAdapters.js/getBniBalance): file mutasi BNI dari sumbernya
 * tidak memuat kolom saldo sama sekali. Seed ini TETAP berguna krn
 * current_plan/next_schedule (baseline + countdown scheduler) tampil
 * independen dari actual balance -- FA tetap bisa lihat rencana &
 * scheduler berikutnya, hanya rekomendasi finansial (CANCEL/REDUCE/ADD)
 * yang tidak akan pernah keluar utk BNI sampai ada sumber saldo aktual
 * baru di luar reconciliation existing.
 *
 * Run: node backend/scripts/seed-balance-funding-bni.js
 */

const pool = require('../src/db');

const BANK_CODE = 'BNI';
const OPENING_BALANCE = 200000000;

const HOURLY_PLAN = [
  { hour: 0, avg: 0, trf: null, planned: 200000000 },
  { hour: 1, avg: 0, trf: 100000000, planned: 300000000 },
  { hour: 2, avg: 0, trf: null, planned: 300000000 },
  { hour: 3, avg: 0, trf: null, planned: 300000000 },
  { hour: 4, avg: 0, trf: null, planned: 300000000 },
  { hour: 5, avg: 2496000, trf: null, planned: 297504000 },
  { hour: 6, avg: 17870000, trf: null, planned: 279634000 },
  { hour: 7, avg: 31749000, trf: 100000000, planned: 347885000 },
  { hour: 8, avg: 62097592, trf: null, planned: 285787408 },
  { hour: 9, avg: 75359401, trf: 150000000, planned: 360428007 },
  { hour: 10, avg: 55028666, trf: null, planned: 305399341 },
  { hour: 11, avg: 83295661, trf: 150000000, planned: 372103680 },
  { hour: 12, avg: 43902449, trf: null, planned: 328201231 },
  { hour: 13, avg: 42800000, trf: 150000000, planned: 435401231 },
  { hour: 14, avg: 40048000, trf: null, planned: 395353231 },
  { hour: 15, avg: 29966423, trf: 150000000, planned: 515386808 },
  { hour: 16, avg: 50990000, trf: null, planned: 464396808 },
  { hour: 17, avg: 63790500, trf: 150000000, planned: 550606308 },
  { hour: 18, avg: 67614997, trf: null, planned: 482991311 },
  { hour: 19, avg: 34885500, trf: 150000000, planned: 598105811 },
  { hour: 20, avg: 14988841, trf: null, planned: 583116970 },
  { hour: 21, avg: 22548123, trf: null, planned: 560568847 },
  { hour: 22, avg: 1300127, trf: null, planned: 559268720 },
  { hour: 23, avg: 0, trf: null, planned: 559268720 },
];

// Sumber data (screenshot "BNI Multibiller") punya 2 kolom penanda jam
// scheduler terpisah -- "Data Scheduler BNI"+"Trf via BNI" (funding dari BNI
// sendiri) dan "Schedule"+"Trf via BRI" (funding dari BRI). Beberapa jam lain
// (02:00/03:00/04:00/05:00/21:00 dst) punya PENANDA JAM tapi nominal kosong
// -- itu BUKAN scheduler sungguhan (dikonfirmasi lewat validasi matematis:
// baris itu balance HANYA kalau dianggap trf=0), jadi TIDAK dimasukkan di sini.
const SCHEDULES = [
  { time: '01:00', source: 'BRI', amount: 100000000, note: 'Funding source BRI, target bank tetap BNI.' },
  { time: '07:00', source: 'BNI', amount: 100000000, note: null },
  { time: '09:00', source: 'BNI', amount: 150000000, note: null },
  { time: '11:00', source: 'BNI', amount: 150000000, note: null },
  { time: '13:00', source: 'BNI', amount: 150000000, note: null },
  { time: '15:00', source: 'BNI', amount: 150000000, note: null },
  { time: '17:00', source: 'BNI', amount: 150000000, note: null },
  { time: '19:00', source: 'BNI', amount: 150000000, note: null },
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
      [BANK_CODE, BANK_CODE, OPENING_BALANCE, 'system_seed_bni_baseline']
    );
    const plan = planRes.rows[0];
    console.log(`Plan BNI: id=${plan.id} ${beforePlan ? '(update, sudah ada sebelumnya)' : '(baru dibuat)'}`);

    for (const row of HOURLY_PLAN) {
      await client.query(
        `INSERT INTO balance_funding_hourly_plan (plan_id, hour_of_day, hour_label, nominal_average, transaksi_trf, planned_balance)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (plan_id, hour_of_day) DO UPDATE SET
           hour_label = EXCLUDED.hour_label, nominal_average = EXCLUDED.nominal_average,
           transaksi_trf = EXCLUDED.transaksi_trf, planned_balance = EXCLUDED.planned_balance, updated_at = NOW()`,
        [plan.id, row.hour, `${String(row.hour).padStart(2, '0')}:00`, row.avg, row.trf, row.planned]
      );
    }
    console.log(`Hourly plan: ${HOURLY_PLAN.length} baris upsert.`);

    let schedCreated = 0, schedSkipped = 0;
    for (const s of SCHEDULES) {
      const r = await client.query(
        `INSERT INTO balance_funding_schedules (plan_id, target_bank_code, funding_source_code, scheduled_time, scheduled_amount, status, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,'SCHEDULED',$6,$7,$7)
         ON CONFLICT (plan_id, scheduled_time) WHERE is_active = TRUE DO NOTHING
         RETURNING id`,
        [plan.id, BANK_CODE, s.source, s.time, s.amount, s.note, 'system_seed_bni_baseline']
      );
      if (r.rows.length) schedCreated++; else schedSkipped++;
    }
    console.log(`Scheduler: ${schedCreated} dibuat baru, ${schedSkipped} sudah ada sebelumnya (dilewati, tidak ditimpa).`);

    await client.query(
      `INSERT INTO balance_funding_audit_log (entity_type, entity_id, action, actor_username, notes)
       VALUES ('BALANCE_FUNDING_PLAN', $1, 'SEED_BASELINE', 'system_seed_bni_baseline', 'Seed baseline BNI: opening 200jt, 24 hourly rows, 8 scheduler (7 BNI + 1 BRI di 01:00). BNI selalu BALANCE_UNAVAILABLE (struktural) -- plan/scheduler tetap tampil independen.')`,
      [plan.id]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const finalPlan = await pool.query(`SELECT * FROM balance_funding_plans WHERE bank_code=$1 AND is_active=TRUE`, [BANK_CODE]);
  const finalHourly = await pool.query(`SELECT hour_of_day, nominal_average, planned_balance FROM balance_funding_hourly_plan WHERE plan_id=$1 ORDER BY hour_of_day`, [finalPlan.rows[0].id]);
  const finalSched = await pool.query(`SELECT scheduled_time, funding_source_code, scheduled_amount, note FROM balance_funding_schedules WHERE plan_id=$1 AND is_active=TRUE ORDER BY scheduled_time`, [finalPlan.rows[0].id]);
  console.log(`\n=== VERIFIKASI AKHIR ===`);
  console.log(`Plan aktif: ${JSON.stringify(finalPlan.rows[0])}`);
  console.log(`Hourly rows: ${finalHourly.rows.length} (harus 24)`);
  console.log(`Scheduler rows: ${finalSched.rows.length} (harus 8)`);
  finalSched.rows.forEach(r => console.log(`  ${r.scheduled_time}  ${r.funding_source_code}  Rp${Number(r.scheduled_amount).toLocaleString('id-ID')}${r.note ? '  [note]' : ''}`));

  await pool.end();
}

main().catch(err => {
  console.error('Seed FAILED:', err.message);
  process.exit(1);
});
