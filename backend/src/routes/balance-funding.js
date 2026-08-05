/**
 * Balance & Funding — reminder & decision support operasional 6 bank (OCBC,
 * Mandiri, BRI, BRI BI-FAST, BNI, BCA): Actual vs Planned Balance per jam,
 * evaluasi scheduler funding berikutnya, rekomendasi CANCEL/REDUCE/KEEP/ADD.
 *
 * STANDALONE dari Balance Control Tower lama — TIDAK ADA import dari
 * backend/src/balanceControlTower/ atau backend/src/reconciliation/
 * bankPosition/ (adapter OCBC BCT). Balance & Funding adalah READ CONSUMER
 * dari data rekonsiliasi (recon_sync_batches/recon_bank_transactions) lewat
 * bankBalanceAdapters.js — TIDAK PERNAH menulis ke tabel recon_*.
 *
 * ADVISORY ONLY: tidak ada endpoint yang transfer/cancel/edit scheduler bank
 * sungguhan — semua mutation di sini hanya menyentuh tabel balance_funding_*
 * milik modul ini sendiri.
 *
 * RBAC (backend, bukan cuma sembunyikan tombol) — pola sama dgn BCT (unit
 * OP/FA/admin), TAPI middleware ditulis ulang lokal di sini (tidak diimpor
 * dari balance-control-tower.js) supaya modul ini genuinely independen:
 *   requireAdmin -> kelola plan/hourly-plan/schedule/tolerance
 *   requireFinanceOrOps -> acknowledge rekomendasi
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { BANK_CODES } = require('../balanceFunding/bankBalanceAdapters');
const { computeBalanceFundingForBank, computeBalanceFundingOverview } = require('../balanceFunding/balanceFundingDataAccess');

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Aksi ini khusus admin.' });
  next();
}
function requireFinanceOrOps(req, res, next) {
  const unit = req.user?.unit;
  if (unit === 'FA' || unit === 'OP' || req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Akses terbatas untuk unit Finance/Operation.' });
}

function assertValidBankCode(req, res) {
  const code = String(req.params.bankCode || '').toUpperCase();
  if (!BANK_CODES.includes(code)) {
    res.status(400).json({ error: `bankCode harus salah satu: ${BANK_CODES.join(', ')}.` });
    return null;
  }
  return code;
}

async function logAudit(client, { entityType, entityId, action, actorUserId, actorUsername, before, after, notes }) {
  await client.query(
    `INSERT INTO balance_funding_audit_log (entity_type, entity_id, action, actor_user_id, actor_username, before_data, after_data, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entityType, entityId, action, actorUserId || null, actorUsername || null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, notes || null]
  );
}

const FUNDING_ALERT_TYPES = ['BALANCE_ABOVE_PLAN', 'BALANCE_BELOW_PLAN', 'SCHEDULER_CANCEL', 'SCHEDULER_REDUCE', 'SCHEDULER_ADD', 'SCHEDULER_MISSED', 'BALANCE_STALE', 'BALANCE_UNAVAILABLE'];

function neededAlerts(bankCode, computed) {
  const needed = new Map();
  const { result } = computed;
  if (!result) return needed;
  const cp = result.current_plan;
  if (cp && cp.status === 'ABOVE_PLAN') {
    needed.set('BALANCE_ABOVE_PLAN', { severity: 'INFO', message: `Saldo Rp${Math.round(Math.abs(cp.variance)).toLocaleString('id-ID')} di atas rencana.` });
  } else if (cp && cp.status === 'BELOW_PLAN') {
    needed.set('BALANCE_BELOW_PLAN', { severity: 'WARNING', message: `Saldo Rp${Math.round(Math.abs(cp.variance)).toLocaleString('id-ID')} di bawah rencana.` });
  }
  const ns = result.next_schedule;
  if (ns && ns.recommendation === 'CANCEL') {
    needed.set('SCHEDULER_CANCEL', { severity: 'INFO', message: `Scheduler ${ns.funding_source_code} ${ns.scheduled_time} dapat dibatalkan.` });
  } else if (ns && ns.recommendation === 'REDUCE') {
    needed.set('SCHEDULER_REDUCE', { severity: 'INFO', message: `Kurangi scheduler ${ns.funding_source_code} ${ns.scheduled_time} sebesar Rp${Math.round(Math.abs(ns.adjustment_amount)).toLocaleString('id-ID')}.` });
  } else if (ns && ns.recommendation === 'ADD') {
    needed.set('SCHEDULER_ADD', { severity: 'WARNING', message: `Tambahkan scheduler ${ns.funding_source_code} ${ns.scheduled_time} sebesar Rp${Math.round(Math.abs(ns.adjustment_amount)).toLocaleString('id-ID')}.` });
  }
  if (result.recommendation === 'BALANCE_STALE') {
    needed.set('BALANCE_STALE', { severity: 'WARNING', message: result.reason });
  }
  if (result.recommendation === 'BALANCE_UNAVAILABLE') {
    needed.set('BALANCE_UNAVAILABLE', { severity: 'CRITICAL', message: 'Saldo aktual belum dapat diverifikasi.' });
  }
  return needed;
}

/** Dedupe alert (spec section 35) — resolve tipe yang tidak lagi relevan, insert-if-not-open utk yang relevan. */
async function syncAlertsForBank(client, bankCode, computed) {
  const needed = neededAlerts(bankCode, computed);
  const neededTypes = [...needed.keys()];
  await client.query(
    `UPDATE balance_funding_alerts SET status = 'RESOLVED', acknowledged_by = COALESCE(acknowledged_by, 'system'),
            updated_at = NOW()
     WHERE bank_code = $1 AND status = 'OPEN' AND alert_type = ANY($2::text[]) AND NOT (alert_type = ANY($3::text[]))`,
    [bankCode, FUNDING_ALERT_TYPES, neededTypes]
  );
  for (const [type, { severity, message }] of needed) {
    await client.query(
      `INSERT INTO balance_funding_alerts (bank_code, alert_type, severity, message, status)
       VALUES ($1,$2,$3,$4,'OPEN')
       ON CONFLICT (bank_code, alert_type) WHERE status = 'OPEN' DO NOTHING`,
      [bankCode, type, severity, message]
    );
  }
}

/** Persist history HANYA kalau rekomendasi berubah material (spec section 35) atau saat acknowledge. */
async function maybePersistRecommendation(client, bankCode, computed) {
  const { result, plan, balance_info: balanceInfo } = computed;
  if (!result) return null;
  const latestRes = await client.query(
    `SELECT * FROM balance_funding_recommendations WHERE bank_code = $1 ORDER BY calculated_at DESC LIMIT 1`,
    [bankCode]
  );
  const latest = latestRes.rows[0] || null;
  const ns = result.next_schedule;
  const nextId = ns ? Number(ns.id) : null;
  const adjustment = ns ? ns.adjustment_amount : null;
  const latestNextId = latest && latest.next_schedule_id !== null && latest.next_schedule_id !== undefined ? Number(latest.next_schedule_id) : null;
  const changed = !latest
    || latest.recommendation !== result.recommendation
    || latestNextId !== nextId
    || Number(latest.adjustment_amount ?? 0) !== Number(adjustment ?? 0);
  if (!changed) return latest;

  const inserted = await client.query(
    `INSERT INTO balance_funding_recommendations
      (bank_code, plan_id, business_date, actual_balance, actual_balance_source, actual_balance_timestamp,
       current_hour, planned_balance, variance_amount, variance_pct, variance_status, next_schedule_id,
       projected_balance, required_funding, existing_schedule_amount, adjustment_amount, recommendation, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      bankCode, plan ? plan.id : null, balanceInfo ? balanceInfo.business_date : null,
      balanceInfo ? balanceInfo.balance : null, balanceInfo ? balanceInfo.source : null, balanceInfo ? balanceInfo.balance_timestamp : null,
      result.current_hour, result.current_plan ? result.current_plan.planned_balance : null,
      result.current_plan ? result.current_plan.variance : null, result.current_plan ? result.current_plan.variance_pct : null,
      result.current_plan ? result.current_plan.status : null, nextId,
      ns ? ns.projected_balance : null, ns ? ns.required_funding : null, ns ? ns.scheduled_amount : null, adjustment,
      result.recommendation, result.reason,
    ]
  );
  return inserted.rows[0];
}

// ── Actionable sorting (spec section 8) -- urgency lebih penting daripada
// sekadar tipe recommendation. Cuma ADD/CANCEL/REDUCE yang "actionable";
// KEEP TIDAK PERNAH ditonjolkan mendekati atas hanya krn scheduler dekat.
const URGENT_LIKE = new Set(['URGENT', 'OVERDUE']);
const ACTIONABLE_RECO = new Set(['ADD', 'CANCEL', 'REDUCE']);
function overviewSortPriority(row) {
  const reco = row.result?.recommendation;
  const urgency = row.result?.next_schedule?.urgency;
  if (ACTIONABLE_RECO.has(reco)) {
    if (URGENT_LIKE.has(urgency)) {
      if (reco === 'ADD') return 0;
      if (reco === 'CANCEL') return 1;
      return 2; // REDUCE
    }
    if (urgency === 'WARNING') return 3;
    return 6; // actionable lain (urgency NORMAL/WATCH/tidak ada scheduler mendekat)
  }
  if (reco === 'BALANCE_STALE') return 4;
  if (reco === 'BALANCE_UNAVAILABLE') return 5;
  if (reco === 'INSUFFICIENT_DATA' || reco === 'NO_UPCOMING_SCHEDULER') return 7;
  if (reco === 'KEEP') return 8;
  return 9;
}

// ── GET /overview — spec section 28/8, 6 card + sorting actionable+urgency-first ────
router.get('/overview', async (req, res) => {
  const client = await pool.connect();
  try {
    const now = new Date();
    const rows = await computeBalanceFundingOverview({ pool, now });
    for (const r of rows) {
      try { await syncAlertsForBank(client, r.bank_code, r); } catch (e) { console.error('syncAlertsForBank error:', e.message); }
      try { await maybePersistRecommendation(client, r.bank_code, r); } catch (e) { console.error('maybePersistRecommendation error:', e.message); }
    }
    const sorted = [...rows].sort((a, b) => {
      const diff = overviewSortPriority(a) - overviewSortPriority(b);
      if (diff !== 0) return diff;
      // Tie-break dalam tier yang sama: scheduler yang lebih dekat waktunya duluan.
      const am = a.result?.next_schedule?.minutes_to_next_scheduler;
      const bm = b.result?.next_schedule?.minutes_to_next_scheduler;
      if (Number.isFinite(am) && Number.isFinite(bm)) return am - bm;
      return 0;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, banks: sorted });
  } catch (e) {
    console.error('balance-funding overview error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /banks/:bankCode — detail 1 bank ─────────────────────────────────
router.get('/banks/:bankCode', async (req, res) => {
  const client = await pool.connect();
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const now = new Date();
    const computed = await computeBalanceFundingForBank({ pool, bankCode: code, now });
    try { await syncAlertsForBank(client, code, computed); } catch (e) { console.error('syncAlertsForBank error:', e.message); }
    try { await maybePersistRecommendation(client, code, computed); } catch (e) { console.error('maybePersistRecommendation error:', e.message); }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...computed });
  } catch (e) {
    console.error('balance-funding bank detail error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /banks/:bankCode/plan — hourly plan + config ─────────────────────
router.get('/banks/:bankCode/plan', async (req, res) => {
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const planRes = await pool.query(`SELECT * FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE`, [code]);
    const plan = planRes.rows[0] || null;
    if (!plan) return res.json({ success: true, plan: null, hourly_plan: [] });
    const hourlyRes = await pool.query(`SELECT * FROM balance_funding_hourly_plan WHERE plan_id = $1 ORDER BY hour_of_day`, [plan.id]);
    res.json({ success: true, plan, hourly_plan: hourlyRes.rows });
  } catch (e) {
    console.error('balance-funding plan get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /banks/:bankCode/plan — admin: opening_balance/timezone/tolerance ─
router.put('/banks/:bankCode/plan', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const { opening_balance, timezone, variance_tolerance, scheduler_tolerance, stale_after_minutes, plan_name, source, reason } = req.body || {};

    for (const [label, v] of [['opening_balance', opening_balance], ['variance_tolerance', variance_tolerance], ['scheduler_tolerance', scheduler_tolerance]]) {
      if (v !== undefined && v !== null && (Number.isNaN(Number(v)) || Number(v) < 0)) {
        return res.status(400).json({ error: `${label} harus angka >= 0.` });
      }
    }
    if (stale_after_minutes !== undefined && stale_after_minutes !== null && (!Number.isInteger(Number(stale_after_minutes)) || Number(stale_after_minutes) <= 0)) {
      return res.status(400).json({ error: 'stale_after_minutes harus bilangan bulat > 0.' });
    }
    if (source !== undefined && source !== null && !['MANUAL', 'GOOGLE_SHEET', 'CSV', 'API'].includes(String(source).toUpperCase())) {
      return res.status(400).json({ error: 'source harus salah satu: MANUAL, GOOGLE_SHEET, CSV, API.' });
    }

    await client.query('BEGIN');
    const existingRes = await client.query(`SELECT * FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE FOR UPDATE`, [code]);
    const before = existingRes.rows[0] || null;

    const r = await client.query(
      `INSERT INTO balance_funding_plans (bank_code, plan_name, opening_balance, timezone, source, variance_tolerance, scheduler_tolerance, stale_after_minutes, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
       ON CONFLICT (bank_code) WHERE is_active = TRUE DO UPDATE SET
         plan_name = EXCLUDED.plan_name, opening_balance = EXCLUDED.opening_balance, timezone = EXCLUDED.timezone,
         source = EXCLUDED.source, variance_tolerance = EXCLUDED.variance_tolerance,
         scheduler_tolerance = EXCLUDED.scheduler_tolerance, stale_after_minutes = EXCLUDED.stale_after_minutes,
         updated_by = $9, updated_at = NOW()
       RETURNING *`,
      [
        code, plan_name || before?.plan_name || code,
        opening_balance !== undefined && opening_balance !== null ? Number(opening_balance) : (before ? before.opening_balance : 0),
        timezone || before?.timezone || 'Asia/Jakarta',
        source ? String(source).toUpperCase() : (before ? before.source : 'MANUAL'),
        variance_tolerance !== undefined ? (variance_tolerance === null ? null : Number(variance_tolerance)) : (before ? before.variance_tolerance : null),
        scheduler_tolerance !== undefined ? (scheduler_tolerance === null ? null : Number(scheduler_tolerance)) : (before ? before.scheduler_tolerance : null),
        stale_after_minutes !== undefined ? (stale_after_minutes === null ? null : Number(stale_after_minutes)) : (before ? before.stale_after_minutes : null),
        req.user?.username || null,
      ]
    );
    await logAudit(client, {
      entityType: 'BALANCE_FUNDING_PLAN', entityId: r.rows[0].id, action: before ? 'UPDATE_PLAN' : 'CREATE_PLAN',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: reason,
    });
    await client.query('COMMIT');
    res.json({ success: true, plan: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-funding plan put error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /banks/:bankCode/plan/hourly/:hour — admin: satu baris jam ───────
router.put('/banks/:bankCode/plan/hourly/:hour', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const hour = parseInt(req.params.hour, 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: 'hour harus 0-23.' });

    const planRes = await client.query(`SELECT id FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE`, [code]);
    if (!planRes.rows.length) return res.status(404).json({ error: `Plan untuk ${code} belum ada — buat plan dulu lewat PUT .../plan.` });
    const planId = planRes.rows[0].id;

    const { nominal_average, transaksi_trf, dana_disiapkan, planned_balance, reason } = req.body || {};
    for (const [label, v] of [['nominal_average', nominal_average], ['transaksi_trf', transaksi_trf], ['dana_disiapkan', dana_disiapkan], ['planned_balance', planned_balance]]) {
      if (v !== null && v !== undefined && (Number.isNaN(Number(v)) || Number(v) < 0)) {
        return res.status(400).json({ error: `${label} harus angka >= 0.` });
      }
    }

    await client.query('BEGIN');
    const existingRes = await client.query(`SELECT * FROM balance_funding_hourly_plan WHERE plan_id = $1 AND hour_of_day = $2 FOR UPDATE`, [planId, hour]);
    const before = existingRes.rows[0] || null;
    const r = await client.query(
      `INSERT INTO balance_funding_hourly_plan (plan_id, hour_of_day, hour_label, nominal_average, transaksi_trf, dana_disiapkan, planned_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (plan_id, hour_of_day) DO UPDATE SET
         nominal_average = EXCLUDED.nominal_average, transaksi_trf = EXCLUDED.transaksi_trf,
         dana_disiapkan = EXCLUDED.dana_disiapkan, planned_balance = EXCLUDED.planned_balance, updated_at = NOW()
       RETURNING *`,
      [planId, hour, `${String(hour).padStart(2, '0')}:00`, nominal_average ?? null, transaksi_trf ?? null, dana_disiapkan ?? null, planned_balance ?? null]
    );
    await logAudit(client, {
      entityType: 'BALANCE_FUNDING_HOURLY_PLAN', entityId: r.rows[0].id, action: before ? 'UPDATE' : 'CREATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: reason,
    });
    await client.query('COMMIT');
    res.json({ success: true, hourly_plan: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-funding hourly put error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /banks/:bankCode/schedules ────────────────────────────────────────
router.get('/banks/:bankCode/schedules', async (req, res) => {
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const planRes = await pool.query(`SELECT id FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE`, [code]);
    if (!planRes.rows.length) return res.json({ success: true, schedules: [] });
    const r = await pool.query(`SELECT * FROM balance_funding_schedules WHERE plan_id = $1 AND is_active = TRUE ORDER BY scheduled_time`, [planRes.rows[0].id]);
    res.json({ success: true, schedules: r.rows });
  } catch (e) {
    console.error('balance-funding schedules get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const VALID_SCHEDULE_STATUS = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'ADJUSTED', 'MISSED'];

// ── POST /banks/:bankCode/schedules — admin: tambah scheduler baru ───────
router.post('/banks/:bankCode/schedules', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const planRes = await client.query(`SELECT id FROM balance_funding_plans WHERE bank_code = $1 AND is_active = TRUE`, [code]);
    if (!planRes.rows.length) return res.status(404).json({ error: `Plan untuk ${code} belum ada.` });
    const planId = planRes.rows[0].id;

    const scheduledTime = String(req.body?.scheduled_time || '').trim();
    const fundingSourceCode = String(req.body?.funding_source_code || '').trim().toUpperCase();
    const scheduledAmount = req.body?.scheduled_amount;
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(scheduledTime)) return res.status(400).json({ error: 'scheduled_time harus format HH:mm.' });
    if (!BANK_CODES.includes(fundingSourceCode)) return res.status(400).json({ error: `funding_source_code harus salah satu: ${BANK_CODES.join(', ')}.` });
    if (scheduledAmount === undefined || scheduledAmount === null || Number.isNaN(Number(scheduledAmount)) || Number(scheduledAmount) < 0) {
      return res.status(400).json({ error: 'scheduled_amount harus angka >= 0.' });
    }

    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO balance_funding_schedules (plan_id, target_bank_code, funding_source_code, scheduled_time, scheduled_amount, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'SCHEDULED',$6,$6) RETURNING *`,
      [planId, code, fundingSourceCode, scheduledTime, Number(scheduledAmount), req.user?.username || null]
    );
    await logAudit(client, {
      entityType: 'BALANCE_FUNDING_SCHEDULE', entityId: r.rows[0].id, action: 'CREATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: null, after: r.rows[0], notes: req.body?.reason || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, schedule: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).includes('uq_balance_funding_schedules_active')) {
      return res.status(409).json({ error: 'Sudah ada scheduler aktif pada jam tersebut untuk bank ini.' });
    }
    console.error('balance-funding schedules post error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /banks/:bankCode/schedules/:id — admin: edit scheduler ───────────
router.put('/banks/:bankCode/schedules/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT s.* FROM balance_funding_schedules s JOIN balance_funding_plans p ON p.id = s.plan_id
       WHERE s.id = $1 AND p.bank_code = $2 FOR UPDATE`,
      [id, code]
    );
    const before = existingRes.rows[0];
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Scheduler tidak ditemukan.' }); }

    const scheduledTime = req.body?.scheduled_time !== undefined ? String(req.body.scheduled_time).trim() : before.scheduled_time;
    const fundingSourceCode = req.body?.funding_source_code !== undefined ? String(req.body.funding_source_code).trim().toUpperCase() : before.funding_source_code;
    const scheduledAmount = req.body?.scheduled_amount !== undefined ? Number(req.body.scheduled_amount) : Number(before.scheduled_amount);
    const status = req.body?.status !== undefined ? String(req.body.status).trim().toUpperCase() : before.status;
    const isActive = req.body?.is_active !== undefined ? !!req.body.is_active : before.is_active;
    const actualAmount = req.body?.actual_amount !== undefined ? req.body.actual_amount : before.actual_amount;
    const note = req.body?.note !== undefined ? String(req.body.note).trim().slice(0, 2000) : before.note;

    if (!VALID_SCHEDULE_STATUS.includes(status)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `status harus salah satu: ${VALID_SCHEDULE_STATUS.join(', ')}.` }); }
    if (!BANK_CODES.includes(fundingSourceCode)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `funding_source_code harus salah satu: ${BANK_CODES.join(', ')}.` }); }
    if (Number.isNaN(scheduledAmount) || scheduledAmount < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'scheduled_amount harus angka >= 0.' }); }

    const r = await client.query(
      `UPDATE balance_funding_schedules SET
         scheduled_time = $1, funding_source_code = $2, scheduled_amount = $3, status = $4,
         is_active = $5, actual_amount = $6, note = $7, updated_by = $8, updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [scheduledTime, fundingSourceCode, scheduledAmount, status, isActive, actualAmount, note, req.user?.username || null, id]
    );

    if (status === 'MISSED' && before.status !== 'MISSED') {
      await client.query(
        `INSERT INTO balance_funding_alerts (bank_code, alert_type, severity, status, message) VALUES ($1,'SCHEDULER_MISSED','WARNING','OPEN',$2)
         ON CONFLICT (bank_code, alert_type) WHERE status = 'OPEN' DO NOTHING`,
        [code, `Scheduler ${fundingSourceCode} ${scheduledTime} ditandai MISSED oleh ${req.user?.username || 'admin'}.`]
      );
    }
    await logAudit(client, {
      entityType: 'BALANCE_FUNDING_SCHEDULE', entityId: id, action: 'UPDATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: req.body?.reason || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, schedule: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).includes('uq_balance_funding_schedules_active')) {
      return res.status(409).json({ error: 'Sudah ada scheduler aktif pada jam tersebut untuk bank ini.' });
    }
    console.error('balance-funding schedules put error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /banks/:bankCode/recommendations — riwayat ────────────────────────
router.get('/banks/:bankCode/recommendations', async (req, res) => {
  try {
    const code = assertValidBankCode(req, res); if (!code) return;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT * FROM balance_funding_recommendations WHERE bank_code = $1 ORDER BY calculated_at DESC LIMIT $2`,
      [code, limit]
    );
    res.json({ success: true, recommendations: r.rows });
  } catch (e) {
    console.error('balance-funding recommendations get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /recommendations/:id/acknowledge — FA/OP menandai "sudah ditindaklanjuti" ──
router.post('/recommendations/:id/acknowledge', requireFinanceOrOps, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;

    await client.query('BEGIN');
    const existingRes = await client.query(`SELECT * FROM balance_funding_recommendations WHERE id = $1 FOR UPDATE`, [id]);
    const before = existingRes.rows[0];
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rekomendasi tidak ditemukan.' }); }

    const r = await client.query(
      `UPDATE balance_funding_recommendations SET acknowledged_at = NOW(), acknowledged_by = $1, acknowledgement_note = $2 WHERE id = $3 RETURNING *`,
      [req.user?.username || null, note, id]
    );
    await logAudit(client, {
      entityType: 'BALANCE_FUNDING_RECOMMENDATION', entityId: id, action: 'ACKNOWLEDGE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: note,
    });
    await client.query('COMMIT');
    res.json({ success: true, recommendation: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-funding acknowledge error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /alerts ────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE status = $1`; }
    const r = await pool.query(`SELECT * FROM balance_funding_alerts ${where} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ success: true, alerts: r.rows });
  } catch (e) {
    console.error('balance-funding alerts get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/alerts/:id/acknowledge', requireFinanceOrOps, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const r = await pool.query(
      `UPDATE balance_funding_alerts SET status = 'ACKNOWLEDGED', acknowledged_at = NOW(), acknowledged_by = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user?.username || null, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Alert tidak ditemukan.' });
    res.json({ success: true, alert: r.rows[0] });
  } catch (e) {
    console.error('balance-funding alert acknowledge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
