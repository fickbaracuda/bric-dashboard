/**
 * Balance Control Tower — monitoring saldo bank lintas rekening (Winpay/BMS
 * Retail), rekomendasi top up, dan workflow top up maker-checker.
 *
 * Semua endpoint di sini pakai JWT (requireAuth didaftarkan di app.js) —
 * TIDAK ada endpoint sync token seperti war-room lain, karena data saldo
 * diinput manual oleh tim Operation/Finance (belum ada integrasi API bank
 * real-time — field `source` sudah disiapkan utk API/RECONCILIATION di
 * masa depan tanpa perlu migration baru).
 *
 * RBAC (backend, bukan cuma sembunyikan tombol di frontend):
 *   - requireAdmin        -> kelola master bank/account & policy
 *   - requireOpsOrFinance -> input snapshot, ajukan/batalkan top up
 *   - requireFinance      -> approve/reject/transfer/confirm-balance/complete
 * Maker-checker: requester tidak boleh approve permintaannya sendiri
 * (dicek eksplisit di /approve, terlepas dari role/unit).
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const {
  computeEffectiveBalance,
  classifyBankStatus,
  classifyBankStatusDetailed,
  evaluateSuddenDrop,
  resolveReserveBalance,
  alertTypeForStatus,
  canTransitionTopup,
  isSelfApproval,
  pickCurrentAndPrevious,
  computeBalanceMovement,
  enrichSnapshotHistory,
  STATUS,
} = require('../utils/balanceControlTower');
const { computeBurnRateStats, buildForecastOutput } = require('../reconciliation/balanceForecast');
const { getLatestVerifiedBankPosition, getConfirmedFundingMutations, isSupportedBank } = require('../reconciliation/bankPosition');
const { computeOperationalCalculationForBank, fetchRecentMatchedOutflows } = require('../balanceControlTower/operationalDataAccess');
const { computeFundingSchedulerForBank } = require('../balanceControlTower/fundingSchedulerDataAccess');
const { validateBaselineFormula } = require('../balanceControlTower/fundingSchedulerEngine');

function isoDateJakarta(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
}
function round2(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? n : Math.round(n * 100) / 100;
}

/**
 * Resolusi status FINAL — SATU tempat, dipakai summary/detail/alert engine
 * SEKALIGUS, supaya old & new formula TIDAK PERNAH aktif bersamaan utk bank
 * yang sama:
 *   1. Sudden-drop (evaluateSuddenDrop) -- prioritas tertinggi, TIDAK berubah.
 *   2. Kalau bank didukung mesin operasional (operationalDataAccess) DAN
 *      berhasil dihitung -> pakai status/alasan dari SANA (intraday burn
 *      window, BUKAN average_burn_rate 14 hari). Cascade forecast lama
 *      (classifyBankStatusDetailed dgn `forecast`) TIDAK dipanggil sama
 *      sekali utk bank ini lagi.
 *   3. Excess balance (legacy, manual policy) -- tetap dicek SETELAH mesin
 *      baru, HANYA kalau hasilnya SAFE (mempertahankan perilaku lama tanpa
 *      duplikasi threshold dinamis).
 *   4. Fallback: bank TANPA adapter rekonsiliasi -> cascade manual-policy
 *      lama TANPA forecast (backward-compatible, tidak berubah).
 */
async function resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now }) {
  const suddenDrop = evaluateSuddenDrop({ snapshot, previousSnapshot, policy: policy || {}, now });
  if (suddenDrop.triggered) {
    return {
      status: STATUS.SUDDEN_DROP,
      reason: `Penurunan saldo Rp${Math.round(suddenDrop.dropAmount).toLocaleString('id-ID')} (${suddenDrop.dropPercentage.toFixed(1)}%) terdeteksi dalam window sudden-drop.`,
      operational: null,
    };
  }

  let operational = null;
  try {
    operational = await computeOperationalCalculationForBank({ pool, bank, policy, STATUS, now });
  } catch (e) {
    console.error(`computeOperationalCalculationForBank(${bank.bank_code}) error:`, e.message);
  }

  if (operational) {
    let status = operational.operational_status;
    let reason = operational.status_reason;
    if (status === STATUS.SAFE && policy && policy.excess_balance_threshold !== null && policy.excess_balance_threshold !== undefined) {
      const excess = Number(policy.excess_balance_threshold);
      if (operational.available_balance !== undefined && Number(operational.available_balance) >= excess) {
        status = STATUS.EXCESS_BALANCE;
        reason = `Saldo tersedia melebihi excess_balance_threshold Rp${Math.round(excess).toLocaleString('id-ID')}.`;
      }
    }
    return { status, reason, operational };
  }

  // Fallback: bank tanpa adapter rekonsiliasi -- cascade manual-policy lama, forecast TIDAK dipakai lagi.
  const legacy = classifyBankStatusDetailed({ snapshot, policy, previousSnapshot, forecast: null, now });
  return { status: legacy.status, reason: legacy.reason, operational: null };
}

/**
 * Refresh-on-read: kalau bank ini punya adapter rekonsiliasi (lihat
 * backend/src/reconciliation/bankPosition) DAN ada batch sukses lebih baru
 * dari snapshot RECONCILIATION terakhir, buat snapshot baru otomatis.
 * available_balance dipakai APA ADANYA dari recon_sync_batches.raw_summary
 * (angka resmi bank) -- TIDAK di-re-derive dari mutasi manapun. Dedup
 * FINAL dijamin di level DB (partial unique index bank_account_id +
 * source_synced_at), INSERT di sini pakai ON CONFLICT DO NOTHING sbg lapis
 * kedua thd race condition saat banyak user buka dashboard bersamaan.
 * TIDAK PERNAH menyentuh/mengubah snapshot lama.
 */
async function refreshBankPositionIfNeeded(bank) {
  if (!isSupportedBank(bank.bank_code)) return null;

  const result = await getLatestVerifiedBankPosition({ pool, bankCode: bank.bank_code, bankAccountId: bank.id });
  if (!result.available || !result.position) return null;
  const position = result.position;
  if (position.available_balance === null || position.available_balance === undefined) return null;
  if (!position.synced_at) return null;

  const lastReconRes = await pool.query(
    `SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 AND source = 'RECONCILIATION'
     ORDER BY source_synced_at DESC NULLS LAST, captured_at DESC LIMIT 1`,
    [bank.id]
  );
  const lastRecon = lastReconRes.rows[0] || null;
  if (lastRecon && lastRecon.source_synced_at && new Date(lastRecon.source_synced_at).getTime() >= new Date(position.synced_at).getTime()) {
    return null; // sudah up to date -- tidak perlu snapshot baru
  }

  const policyRes = await pool.query(`SELECT reserve_balance FROM bct_balance_policies WHERE bank_account_id = $1`, [bank.id]);
  const policyReserveBalance = policyRes.rows[0] ? policyRes.rows[0].reserve_balance : null;
  const { value: reserveBalance, source: reserveSource } = resolveReserveBalance({
    providedReserveBalance: undefined, policyReserveBalance,
  });
  const effectiveBalance = computeEffectiveBalance({
    available_balance: position.available_balance, held_balance: 0, pending_amount: 0, reserve_balance: reserveBalance,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO bct_balance_snapshots
        (bank_account_id, available_balance, held_balance, pending_amount, reserve_balance, reserve_source, effective_balance, source, sync_status, source_synced_at, created_by)
       VALUES ($1,$2,0,0,$3,$4,$5,'RECONCILIATION','OK',$6,'system')
       ON CONFLICT (bank_account_id, source_synced_at) WHERE source = 'RECONCILIATION' AND source_synced_at IS NOT NULL DO NOTHING
       RETURNING *`,
      [bank.id, position.available_balance, reserveBalance, reserveSource, effectiveBalance, position.synced_at]
    );
    if (insertRes.rows.length) {
      await logAudit(client, {
        entityType: 'BALANCE_SNAPSHOT', entityId: insertRes.rows[0].id, action: 'CREATE_BALANCE_SNAPSHOT',
        actorUserId: null, actorUsername: 'system',
        before: null, after: insertRes.rows[0],
        notes: `auto-refresh dari rekonsiliasi ${bank.bank_code} (${position.source_table}), synced_at=${position.synced_at}`,
      });
    }
    await client.query('COMMIT');
    return insertRes.rows[0] || null;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`refreshBankPositionIfNeeded(${bank.bank_code}) error:`, e.message);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Bangun forecast lengkap utk satu bank (REUSE evaluateSuddenDrop yang sama
 * dipakai classifier + computeBurnRateStats yang REUSE penuh mesin
 * "Kebutuhan Saldo" Rekonsiliasi). null kalau belum ada snapshot sama sekali
 * (belum ada apa pun utk diforecast).
 */
async function computeForecastForBank(dbPool, bank, snapshot, previousSnapshot, policy, now) {
  if (!snapshot) return null;
  const suddenDrop = evaluateSuddenDrop({ snapshot, previousSnapshot, policy: policy || {}, now });
  const burnStats = await computeBurnRateStats({ pool: dbPool, bankCode: bank.bank_code, now });
  return buildForecastOutput({ snapshot, previousSnapshot, policy: policy || {}, burnStats, bankCode: bank.bank_code, suddenDrop, now });
}

const VALID_SOURCES = ['MANUAL', 'API', 'RECONCILIATION'];
const VALID_SYNC_STATUS = ['OK', 'STALE', 'ERROR'];
const VALID_RECOMMENDATION_SOURCE = ['MANUAL', 'AUTOMATIC'];

// ─────────────────────────────────────────────────────────────────────────
// RBAC middleware
// ─────────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Aksi ini khusus admin.' });
  }
  next();
}
function requireOpsOrFinance(req, res, next) {
  const unit = req.user?.unit;
  if (unit === 'OP' || unit === 'FA' || req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Akses terbatas untuk unit Operation/Finance.' });
}
function requireFinance(req, res, next) {
  if (req.user?.unit !== 'FA' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Aksi ini khusus unit Finance (FA).' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
async function logAudit(client, { entityType, entityId, action, actorUserId, actorUsername, before, after, notes }) {
  await client.query(
    `INSERT INTO bct_audit_log (entity_type, entity_id, action, actor_user_id, actor_username, before_data, after_data, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entityType, entityId, action, actorUserId || null, actorUsername || null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, notes || null]
  );
}

/** Ambil bank + policy + snapshot terbaru sekaligus (dipakai summary & list). */
async function fetchBanksWithStatus(client, { onlyActive = true } = {}) {
  const banksRes = await client.query(
    `SELECT * FROM bct_bank_accounts ${onlyActive ? 'WHERE is_active = TRUE' : ''} ORDER BY bank_name, account_number`
  );
  const banks = banksRes.rows;
  if (!banks.length) return [];

  // Refresh-on-read: bank yang punya adapter rekonsiliasi (lihat
  // isSupportedBank) di-cek dulu -- auto-buat snapshot baru kalau ada
  // batch sukses lebih baru dari snapshot RECONCILIATION terakhir, SEBELUM
  // query snapshot di bawah supaya hasilnya langsung terlihat di response ini.
  await Promise.all(banks.map(async bank => {
    try { await refreshBankPositionIfNeeded(bank); }
    catch (e) { console.error(`refresh position (${bank.bank_code}) error:`, e.message); }
  }));

  const ids = banks.map(b => b.id);
  const [policiesRes, snapshotsRankedRes, topupTodayRes] = await Promise.all([
    client.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = ANY($1)`, [ids]),
    // Ambil sampai 20 snapshot terbaru per bank (bukan cuma 2) -- perlu
    // headroom supaya pickCurrentAndPrevious bisa cari baris RECONCILIATION
    // terbaru walau ada beberapa baris MANUAL yang captured_at-nya lebih baru.
    client.query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY bank_account_id ORDER BY captured_at DESC) AS rn
         FROM bct_balance_snapshots WHERE bank_account_id = ANY($1)
       ) t WHERE rn <= 20 ORDER BY bank_account_id, rn`,
      [ids]
    ),
    client.query(
      `SELECT bank_account_id, COALESCE(SUM(COALESCE(actual_amount, approved_amount, requested_amount)), 0) AS total
       FROM bct_topup_requests
       WHERE bank_account_id = ANY($1)
         AND status IN ('TRANSFERRED','BALANCE_CONFIRMED','COMPLETED')
         AND (transferred_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
       GROUP BY bank_account_id`,
      [ids]
    ),
  ]);

  const policyByBank = new Map(policiesRes.rows.map(p => [String(p.bank_account_id), p]));
  const rowsByBank = new Map();
  for (const row of snapshotsRankedRes.rows) {
    const key = String(row.bank_account_id);
    if (!rowsByBank.has(key)) rowsByBank.set(key, []);
    rowsByBank.get(key).push(row);
  }
  const snapshotByBank = new Map();
  const previousSnapshotByBank = new Map();
  for (const bank of banks) {
    const key = String(bank.id);
    const { snapshot, previousSnapshot } = pickCurrentAndPrevious(rowsByBank.get(key) || [], isSupportedBank(bank.bank_code));
    if (snapshot) snapshotByBank.set(key, snapshot);
    if (previousSnapshot) previousSnapshotByBank.set(key, previousSnapshot);
  }
  const topupTodayByBank = new Map(topupTodayRes.rows.map(t => [String(t.bank_account_id), Number(t.total)]));

  const now = new Date();
  return Promise.all(banks.map(async bank => {
    const policy = policyByBank.get(String(bank.id)) || null;
    const snapshot = snapshotByBank.get(String(bank.id)) || null;
    const previousSnapshot = previousSnapshotByBank.get(String(bank.id)) || null;
    // Forecast lama (average_burn_rate 14 hari) TETAP dihitung -- HANYA utk
    // "Historical Analytics" (lihat frontend), TIDAK LAGI dipakai menentukan
    // status/alert utk bank yang punya mesin operasional (resolveFinalStatus).
    let forecast = null;
    try { forecast = await computeForecastForBank(pool, bank, snapshot, previousSnapshot, policy, now); }
    catch (e) { console.error(`computeForecastForBank(${bank.bank_code}) error:`, e.message); }
    const { status, reason, operational } = await resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now });
    return {
      bank,
      policy,
      snapshot,
      previousSnapshot,
      forecast,
      operational,
      status,
      status_reason: reason,
      topup_today: topupTodayByBank.get(String(bank.id)) || 0,
    };
  }));
}

/** Sinkronkan alert OPEN sesuai status terkini — dedup via partial unique index, auto-resolve saat kondisi normal. */
async function syncAlertsForBank(client, bankId, status) {
  const neededType = alertTypeForStatus(status);

  await client.query(
    `UPDATE bct_alerts SET status = 'RESOLVED', resolved_by = 'system', resolved_at = NOW(), updated_at = NOW(),
            reason = COALESCE(reason || ' ', '') || '[auto-resolved: kondisi kembali normal]'
     WHERE bank_account_id = $1 AND status = 'OPEN' AND alert_type IS DISTINCT FROM $2`,
    [bankId, neededType]
  );

  if (neededType) {
    await client.query(
      `INSERT INTO bct_alerts (bank_account_id, alert_type, status, message)
       VALUES ($1, $2, 'OPEN', $3)
       ON CONFLICT (bank_account_id, alert_type) WHERE status = 'OPEN' DO NOTHING`,
      [bankId, neededType, `Status bank: ${status}`]
    );
  }
}

function mapBankRow({ bank, policy, snapshot, status, status_reason, topup_today, forecast, operational }) {
  // operational (mesin baru, intraday) adalah SUMBER UTAMA runway/rekomendasi
  // top-up kalau tersedia -- forecast lama (average_burn_rate 14 hari) HANYA
  // fallback utk bank yang belum didukung adapter rekonsiliasi. Tidak pernah
  // campur: satu bank pakai SATU sumber saja per field ini.
  return {
    id: bank.id,
    bank_code: bank.bank_code,
    bank_name: bank.bank_name,
    account_number: bank.account_number,
    account_name: bank.account_name,
    is_active: bank.is_active,
    available_balance: snapshot ? Number(snapshot.available_balance) : null,
    held_balance: snapshot ? Number(snapshot.held_balance) : null,
    pending_amount: snapshot ? Number(snapshot.pending_amount) : null,
    reserve_balance: snapshot ? Number(snapshot.reserve_balance) : null,
    effective_balance: snapshot ? Number(snapshot.effective_balance) : null,
    top_up_hari_ini: topup_today,
    status,
    status_reason: status_reason || null,
    sync_status: snapshot ? snapshot.sync_status : null,
    last_captured_at: snapshot ? snapshot.captured_at : null,
    has_policy: !!(policy && policy.is_active),
    calculation_source: operational ? 'OPERATIONAL_ENGINE' : (forecast && forecast.forecast_available ? 'LEGACY_FORECAST' : null),
    calculation_version: operational ? operational.calculation_version : null,
    usable_balance: operational ? operational.usable_balance : null,
    burn_rate_per_minute: operational ? operational.burn_rate_per_minute : null,
    usable_runway_minutes: operational ? operational.usable_runway_minutes : (forecast ? forecast.estimated_runway_minutes : null),
    recommended_topup_amount: operational ? operational.recommended_topup : (forecast ? forecast.recommended_topup_amount : null),
    topup_deadline: operational ? operational.topup_deadline : (forecast ? forecast.recommended_topup_deadline : null),
    forecast_available: !!(forecast && forecast.forecast_available),
    forecast_source: forecast ? forecast.forecast_source : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /summary — dashboard seluruh bank
// ─────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = await fetchBanksWithStatus(client);

    // Sinkron alert per bank (best-effort, tidak boleh gagalkan summary).
    for (const r of rows) {
      try { await syncAlertsForBank(client, r.bank.id, r.status); }
      catch (e) { console.error('syncAlertsForBank error:', e.message); }
    }

    const totalSaldoBank = rows.reduce((s, r) => s + (r.snapshot ? Number(r.snapshot.available_balance) : 0), 0);
    const totalSaldoEfektif = rows.reduce((s, r) => s + (r.snapshot ? Number(r.snapshot.effective_balance) : 0), 0);
    const totalTopUpHariIni = rows.reduce((s, r) => s + r.topup_today, 0);
    const bankPerluPerhatian = rows.filter(r => r.status !== STATUS.SAFE).length;

    const alertRes = await client.query(`SELECT COUNT(*) AS c FROM bct_alerts WHERE status = 'OPEN'`);

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      total_saldo_bank: totalSaldoBank,
      total_saldo_efektif: totalSaldoEfektif,
      total_topup_hari_ini: totalTopUpHariIni,
      bank_perlu_perhatian: bankPerluPerhatian,
      alert_aktif: Number(alertRes.rows[0]?.c || 0),
      banks: rows.map(mapBankRow),
    });
  } catch (e) {
    console.error('balance-control-tower summary error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /banks — tabel bank (sama data dengan summary.banks, endpoint terpisah biar konsisten pola war-room lain)
// ─────────────────────────────────────────────────────────────────────────
router.get('/banks', async (req, res) => {
  const client = await pool.connect();
  try {
    const onlyActive = req.query.include_inactive !== 'true';
    const rows = await fetchBanksWithStatus(client, { onlyActive });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, banks: rows.map(mapBankRow) });
  } catch (e) {
    console.error('balance-control-tower banks error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /banks — buat bank/account baru (admin only)
// ─────────────────────────────────────────────────────────────────────────
router.post('/banks', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const bankCode = String(req.body?.bank_code || '').trim().toUpperCase();
    const bankName = String(req.body?.bank_name || '').trim();
    const accountNumber = String(req.body?.account_number || '').trim();
    const accountName = req.body?.account_name ? String(req.body.account_name).trim() : null;
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;

    if (!bankCode || !bankName || !accountNumber) {
      return res.status(400).json({ error: 'bank_code, bank_name, account_number wajib diisi.' });
    }

    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO bct_bank_accounts (bank_code, bank_name, account_number, account_name, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [bankCode, bankName, accountNumber, accountName, req.user?.username || null]
    );
    await logAudit(client, {
      entityType: 'BANK_ACCOUNT', entityId: r.rows[0].id, action: 'CREATE_BANK_ACCOUNT',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: null, after: r.rows[0], notes: reason,
    });
    await client.query('COMMIT');
    res.json({ success: true, bank: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Bank/rekening ini sudah terdaftar.' });
    console.error('balance-control-tower create bank error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /banks/:id — update master bank/account (admin only)
// ─────────────────────────────────────────────────────────────────────────
router.put('/banks/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    const fields = [];
    const params = [];
    for (const [key, col] of [['bank_name', 'bank_name'], ['account_name', 'account_name'], ['is_active', 'is_active']]) {
      if (req.body?.[key] !== undefined) {
        params.push(req.body[key]);
        fields.push(`${col} = $${params.length}`);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'Tidak ada field untuk diupdate.' });
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    params.push(id);

    await client.query('BEGIN');
    const beforeRes = await client.query(`SELECT * FROM bct_bank_accounts WHERE id = $1 FOR UPDATE`, [id]);
    if (!beforeRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    }

    const r = await client.query(
      `UPDATE bct_bank_accounts SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    await logAudit(client, {
      entityType: 'BANK_ACCOUNT', entityId: id, action: 'UPDATE_BANK_ACCOUNT',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: beforeRes.rows[0], after: r.rows[0], notes: reason,
    });
    await client.query('COMMIT');
    res.json({ success: true, bank: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-control-tower update bank error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /banks/:id — detail Monitoring Saldo
// ─────────────────────────────────────────────────────────────────────────
router.get('/banks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await pool.query(`SELECT * FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const bank = bankRes.rows[0];

    try { await refreshBankPositionIfNeeded(bank); }
    catch (e) { console.error(`refresh position (${bank.bank_code}) error:`, e.message); }

    const [policyRes, recentSnapshotsRes, historyRes, topupHistoryRes, lastTopupRes, todayUsageRes, alertsRes] = await Promise.all([
      pool.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [id]),
      // 20 baris terakhir (bukan cuma 2) -- headroom utk pickCurrentAndPrevious
      // cari baris RECONCILIATION terbaru walau ada baris MANUAL di antaranya.
      pool.query(`SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 20`, [id]),
      pool.query(`SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 100`, [id]),
      pool.query(`SELECT * FROM bct_topup_requests WHERE bank_account_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      pool.query(
        `SELECT * FROM bct_topup_requests WHERE bank_account_id = $1 AND status IN ('TRANSFERRED','BALANCE_CONFIRMED','COMPLETED')
         ORDER BY transferred_at DESC LIMIT 1`, [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(COALESCE(actual_amount, approved_amount, requested_amount)), 0) AS total
         FROM bct_topup_requests WHERE bank_account_id = $1 AND status IN ('TRANSFERRED','BALANCE_CONFIRMED','COMPLETED')
           AND (transferred_at AT TIME ZONE 'Asia/Jakarta')::date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date`,
        [id]
      ),
      pool.query(`SELECT * FROM bct_alerts WHERE bank_account_id = $1 AND status IN ('OPEN','ACKNOWLEDGED') ORDER BY created_at DESC`, [id]),
    ]);

    const policy = policyRes.rows[0] || null;
    const { snapshot, previousSnapshot } = pickCurrentAndPrevious(recentSnapshotsRes.rows, isSupportedBank(bank.bank_code));
    const now = new Date();
    // Forecast lama -- HANYA "Historical Analytics" (lihat frontend), tidak
    // lagi dipakai menentukan status/rekomendasi kalau operational tersedia.
    let forecast = null;
    try { forecast = await computeForecastForBank(pool, bank, snapshot, previousSnapshot, policy, now); }
    catch (e) { console.error(`bank detail forecast(${bank.bank_code}) error:`, e.message); }
    const { status, reason: statusReason, operational } = await resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now });

    // Penggunaan saldo hari ini = selisih saldo tersedia snapshot terakhir kemarin vs sekarang (proxy sederhana, tanpa buku besar transaksi).
    let usageToday = null;
    if (snapshot) {
      const prevRes = await pool.query(
        `SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1
           AND (captured_at AT TIME ZONE 'Asia/Jakarta')::date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date
         ORDER BY captured_at DESC LIMIT 1`,
        [id]
      );
      if (prevRes.rows.length) {
        usageToday = Number(prevRes.rows[0].available_balance) - Number(snapshot.available_balance);
      }
    }

    // Mutasi kredit rekonsiliasi -- VISIBILITAS/AUDIT SAJA (lihat
    // fundingDetectionService.js: is_already_reflected_in_balance selalu
    // true di rilis ini, TIDAK PERNAH dijumlahkan ke saldo/forecast mana pun).
    let fundingMutations = [];
    if (isSupportedBank(bank.bank_code)) {
      try {
        const to = isoDateJakarta(now);
        const from = isoDateJakarta(new Date(now.getTime() - 3 * 86400000));
        const fundingRes = await getConfirmedFundingMutations({ pool, bankCode: bank.bank_code, bankAccountId: bank.id, from, to });
        if (fundingRes.available) fundingMutations = fundingRes.mutations;
      } catch (e) { console.error(`funding mutations (${bank.bank_code}) error:`, e.message); }
    }

    // Δ Saldo (item 6) -- delta antara snapshot current & previous valid
    // yang SUDAH dipilih pickCurrentAndPrevious di atas (utk bank rekonsiliasi
    // sudah otomatis prefer RECONCILIATION, jadi delta ini konsisten dgn
    // status/operational di atas, tidak tercampur dgn baris manual lama).
    const balanceMovement = computeBalanceMovement({ current: snapshot, previous: previousSnapshot });

    // Riwayat snapshot enrichment (item 7) -- rentang lebih lebar dari
    // funding_mutations 3-hari di atas (khusus utk field itu, tidak diubah)
    // supaya s/d 100 baris riwayat bisa di-enrich, dibatasi maksimal 30 hari
    // ke belakang (query cost). Interval yang lebih tua dari cakupan ini
    // ditandai eksplisit "data tidak tersedia" oleh enrichSnapshotHistory,
    // TIDAK ditampilkan seolah funding-nya 0.
    let enrichedHistory = historyRes.rows;
    if (isSupportedBank(bank.bank_code) && historyRes.rows.length) {
      try {
        const oldestCapturedAt = new Date(historyRes.rows[historyRes.rows.length - 1].captured_at);
        const maxLookbackFrom = new Date(now.getTime() - 30 * 86400000);
        const coverageFrom = oldestCapturedAt > maxLookbackFrom ? oldestCapturedAt : maxLookbackFrom;
        const [outflowForHistory, fundingForHistoryRes] = await Promise.all([
          fetchRecentMatchedOutflows({ pool, bankCode: bank.bank_code, now, since: coverageFrom }),
          getConfirmedFundingMutations({
            pool, bankCode: bank.bank_code, bankAccountId: bank.id,
            from: isoDateJakarta(coverageFrom), to: isoDateJakarta(now),
          }),
        ]);
        const fundingRowsForHistory = fundingForHistoryRes.available ? fundingForHistoryRes.mutations : [];
        enrichedHistory = enrichSnapshotHistory({
          snapshots: historyRes.rows, outflowRows: outflowForHistory,
          fundingMutations: fundingRowsForHistory, fundingCoverageFrom: coverageFrom,
        });
      } catch (e) { console.error(`enrichSnapshotHistory(${bank.bank_code}) error:`, e.message); }
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      bank,
      policy,
      status,
      status_reason: statusReason,
      operational,
      forecast,
      balance_movement: balanceMovement,
      funding_mutations: fundingMutations,
      posisi_saldo_terbaru: snapshot ? {
        available_balance: Number(snapshot.available_balance),
        held_balance: Number(snapshot.held_balance),
        pending_amount: Number(snapshot.pending_amount),
        reserve_balance: Number(snapshot.reserve_balance),
        reserve_source: snapshot.reserve_source || null,
        effective_balance: Number(snapshot.effective_balance),
        captured_at: snapshot.captured_at,
        source: snapshot.source,
        sync_status: snapshot.sync_status,
      } : null,
      penggunaan_saldo_hari_ini: usageToday,
      total_topup_hari_ini: Number(todayUsageRes.rows[0]?.total || 0),
      top_up_terakhir: lastTopupRes.rows[0] || null,
      riwayat_snapshot: enrichedHistory,
      riwayat_topup: topupHistoryRes.rows,
      alert_aktif: alertsRes.rows,
    });
  } catch (e) {
    console.error('balance-control-tower bank detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /banks/:id/snapshots — input snapshot saldo (Ops/Finance/admin)
// ─────────────────────────────────────────────────────────────────────────
router.post('/banks/:id/snapshots', requireOpsOrFinance, async (req, res) => {
  const client = await pool.connect();
  try {
    const bankId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await client.query(`SELECT id, bank_code FROM bct_bank_accounts WHERE id = $1`, [bankId]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const bank = bankRes.rows[0];

    const { available_balance, held_balance = 0, pending_amount = 0 } = req.body || {};
    // reserve_balance SENGAJA tidak di-default 0 di destructuring -- undefined
    // harus tetap kebaca sbg "tidak dikirim" supaya resolveReserveBalance bisa
    // membedakan dari "dikirim eksplisit 0" (lihat catatan double-subtract).
    const providedReserveBalance = req.body?.reserve_balance;
    const source = req.body?.source ? String(req.body.source).toUpperCase() : 'MANUAL';
    const syncStatus = req.body?.sync_status ? String(req.body.sync_status).toUpperCase() : 'OK';
    const manualReason = req.body?.reason ? String(req.body.reason).trim() : null;

    if (available_balance === undefined || available_balance === null || available_balance === '') {
      return res.status(400).json({ error: 'available_balance wajib diisi.' });
    }
    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source wajib salah satu: ${VALID_SOURCES.join(', ')}` });
    }
    if (!VALID_SYNC_STATUS.includes(syncStatus)) {
      return res.status(400).json({ error: `sync_status wajib salah satu: ${VALID_SYNC_STATUS.join(', ')}` });
    }
    // Bank yang sudah punya mesin rekonsiliasi (OCBC) -- Input Saldo Manual
    // hanya boleh dipakai sbg fallback darurat, WAJIB disertai alasan yang
    // masuk audit log (spec item 5). Bank tanpa adapter rekonsiliasi TETAP
    // pakai alur manual biasa TANPA syarat ini (tidak berubah).
    if (source === 'MANUAL' && isSupportedBank(bank.bank_code) && !manualReason) {
      return res.status(400).json({ error: 'reason wajib diisi utk Input Saldo Manual (Darurat) pada bank yang sudah didukung rekonsiliasi otomatis.' });
    }
    for (const [label, v] of [['available_balance', available_balance], ['held_balance', held_balance], ['pending_amount', pending_amount], ['reserve_balance', providedReserveBalance]]) {
      if (v !== null && v !== undefined && v !== '' && Number.isNaN(Number(v))) {
        return res.status(400).json({ error: `${label} harus berupa angka.` });
      }
    }

    const policyRes = await client.query(`SELECT reserve_balance FROM bct_balance_policies WHERE bank_account_id = $1`, [bankId]);
    const policyReserveBalance = policyRes.rows[0] ? policyRes.rows[0].reserve_balance : null;
    const { value: reserveBalance, source: reserveSource } = resolveReserveBalance({
      providedReserveBalance, policyReserveBalance,
    });

    let effectiveBalance;
    try {
      effectiveBalance = computeEffectiveBalance({ available_balance, held_balance, pending_amount, reserve_balance: reserveBalance });
    } catch (calcErr) {
      return res.status(400).json({ error: calcErr.message });
    }

    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO bct_balance_snapshots
        (bank_account_id, available_balance, held_balance, pending_amount, reserve_balance, reserve_source, effective_balance, source, sync_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [bankId, available_balance, held_balance, pending_amount, reserveBalance, reserveSource, effectiveBalance, source, syncStatus, req.user?.username || null]
    );
    await logAudit(client, {
      entityType: 'BALANCE_SNAPSHOT', entityId: r.rows[0].id, action: 'CREATE_BALANCE_SNAPSHOT',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: null, after: r.rows[0],
      notes: `reserve_source=${reserveSource}` + (manualReason ? ` | alasan input manual darurat: ${manualReason}` : ''),
    });
    await client.query('COMMIT');

    res.json({ success: true, snapshot: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-control-tower create snapshot error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /banks/:id/snapshots — riwayat snapshot
// ─────────────────────────────────────────────────────────────────────────
router.get('/banks/:id/snapshots', async (req, res) => {
  try {
    const bankId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'id tidak valid.' });
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const r = await pool.query(
      `SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT $2`,
      [bankId, limit]
    );
    res.json({ success: true, snapshots: r.rows });
  } catch (e) {
    console.error('balance-control-tower list snapshots error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET/PUT /banks/:id/policy — policy CRUD (admin only utk PUT)
// ─────────────────────────────────────────────────────────────────────────
router.get('/banks/:id/policy', async (req, res) => {
  try {
    const bankId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'id tidak valid.' });
    const r = await pool.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [bankId]);
    res.json({ success: true, policy: r.rows[0] || null });
  } catch (e) {
    console.error('balance-control-tower get policy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/banks/:id/policy', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const bankId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await client.query(`SELECT id FROM bct_bank_accounts WHERE id = $1`, [bankId]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });

    const {
      absolute_minimum_balance = null, watch_threshold = null, excess_balance_threshold = null,
      stale_after_minutes = null, safety_buffer_percentage = null, topup_rounding_amount = null,
      critical_threshold = null, emergency_threshold = null, reserve_balance = null,
      sudden_drop_window_minutes = null, sudden_drop_amount_threshold = null, sudden_drop_percentage_threshold = null,
      is_active = true,
      // Field mesin operasional (intraday FA Action Layer) -- SEBELUM revisi
      // ini TIDAK ADA di route/modal sama sekali, itu sebabnya tidak pernah
      // bisa dikonfigurasi walau kolomnya sudah ada di DB sejak migration
      // add_balance_control_tower_operational_engine.sql.
      burn_window_minutes = null, topup_lead_time_minutes = null,
      critical_margin_minutes = null, watch_buffer_minutes = null,
      safety_buffer_type = null, safety_buffer_fixed_amount = null,
    } = req.body || {};
    // Toleransi Funding Scheduler Adjustment Assistant -- kolom NOT NULL DEFAULT
    // 10jt di DB. undefined (field tidak dikirim body, mis. dari PolicyModal lama
    // yang belum tahu field ini) HARUS mempertahankan nilai existing, BUKAN
    // ditimpa null (akan melanggar NOT NULL constraint & menggagalkan endpoint
    // ini utk SEMUA pemanggil lama). Resolusi akhir dilakukan setelah `before`
    // (baris existing) diketahui, lihat di bawah.
    const fundingPlanVarianceToleranceInput = req.body?.funding_plan_variance_tolerance;
    const fundingSchedulerToleranceInput = req.body?.funding_scheduler_tolerance;
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;

    const VALID_BURN_WINDOWS = [5, 15, 30, 60];
    if (burn_window_minutes !== null && burn_window_minutes !== undefined && !VALID_BURN_WINDOWS.includes(Number(burn_window_minutes))) {
      return res.status(400).json({ error: `burn_window_minutes harus salah satu: ${VALID_BURN_WINDOWS.join(', ')}.` });
    }
    if (topup_lead_time_minutes !== null && topup_lead_time_minutes !== undefined && (!Number.isFinite(Number(topup_lead_time_minutes)) || Number(topup_lead_time_minutes) <= 0)) {
      return res.status(400).json({ error: 'topup_lead_time_minutes harus angka lebih besar dari 0.' });
    }
    for (const [label, v] of [['critical_margin_minutes', critical_margin_minutes], ['watch_buffer_minutes', watch_buffer_minutes]]) {
      if (v !== null && v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        return res.status(400).json({ error: `${label} harus angka >= 0.` });
      }
    }
    const VALID_SAFETY_BUFFER_TYPES = ['FIXED', 'PERCENTAGE'];
    if (safety_buffer_type !== null && safety_buffer_type !== undefined && !VALID_SAFETY_BUFFER_TYPES.includes(String(safety_buffer_type).toUpperCase())) {
      return res.status(400).json({ error: `safety_buffer_type harus salah satu: ${VALID_SAFETY_BUFFER_TYPES.join(', ')}.` });
    }
    if (safety_buffer_fixed_amount !== null && safety_buffer_fixed_amount !== undefined && (!Number.isFinite(Number(safety_buffer_fixed_amount)) || Number(safety_buffer_fixed_amount) < 0)) {
      return res.status(400).json({ error: 'safety_buffer_fixed_amount harus angka >= 0.' });
    }
    const safetyBufferTypeNormalized = safety_buffer_type ? String(safety_buffer_type).toUpperCase() : null;

    // Nominal & percentage & minute -- format check dulu (semua boleh null).
    for (const [label, v] of [
      ['absolute_minimum_balance', absolute_minimum_balance], ['watch_threshold', watch_threshold],
      ['excess_balance_threshold', excess_balance_threshold], ['safety_buffer_percentage', safety_buffer_percentage],
      ['topup_rounding_amount', topup_rounding_amount], ['critical_threshold', critical_threshold],
      ['emergency_threshold', emergency_threshold], ['reserve_balance', reserve_balance],
      ['sudden_drop_amount_threshold', sudden_drop_amount_threshold],
      ['sudden_drop_percentage_threshold', sudden_drop_percentage_threshold],
    ]) {
      if (v !== null && v !== undefined && Number.isNaN(Number(v))) {
        return res.status(400).json({ error: `${label} harus berupa angka.` });
      }
    }
    if (stale_after_minutes !== null && stale_after_minutes !== undefined && !Number.isInteger(Number(stale_after_minutes))) {
      return res.status(400).json({ error: 'stale_after_minutes harus bilangan bulat (menit).' });
    }
    if (sudden_drop_window_minutes !== null && sudden_drop_window_minutes !== undefined && !Number.isInteger(Number(sudden_drop_window_minutes))) {
      return res.status(400).json({ error: 'sudden_drop_window_minutes harus bilangan bulat (menit).' });
    }

    // Nominal tidak boleh negatif -- pesan jelas per field (bukan cuma DB constraint generik).
    for (const [label, v] of [
      ['absolute_minimum_balance', absolute_minimum_balance], ['watch_threshold', watch_threshold],
      ['excess_balance_threshold', excess_balance_threshold], ['topup_rounding_amount', topup_rounding_amount],
      ['critical_threshold', critical_threshold], ['emergency_threshold', emergency_threshold],
      ['reserve_balance', reserve_balance], ['sudden_drop_amount_threshold', sudden_drop_amount_threshold],
    ]) {
      if (v !== null && v !== undefined && Number(v) < 0) {
        return res.status(400).json({ error: `${label} tidak boleh negatif.` });
      }
    }
    // Percentage 0..100.
    for (const [label, v] of [['safety_buffer_percentage', safety_buffer_percentage], ['sudden_drop_percentage_threshold', sudden_drop_percentage_threshold]]) {
      if (v !== null && v !== undefined && (Number(v) < 0 || Number(v) > 100)) {
        return res.status(400).json({ error: `${label} harus di antara 0 dan 100.` });
      }
    }
    // Minute values positif.
    for (const [label, v] of [['stale_after_minutes', stale_after_minutes], ['sudden_drop_window_minutes', sudden_drop_window_minutes]]) {
      if (v !== null && v !== undefined && Number(v) <= 0) {
        return res.status(400).json({ error: `${label} harus lebih besar dari 0.` });
      }
    }
    // Urutan tingkat keparahan -- hanya dicek kalau SEMUA nilai terkait terisi.
    if (emergency_threshold !== null && critical_threshold !== null && Number(emergency_threshold) > Number(critical_threshold)) {
      return res.status(400).json({ error: 'emergency_threshold harus <= critical_threshold.' });
    }
    if (critical_threshold !== null && watch_threshold !== null && Number(critical_threshold) > Number(watch_threshold)) {
      return res.status(400).json({ error: 'critical_threshold harus <= watch_threshold.' });
    }

    await client.query('BEGIN');
    const existingRes = await client.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1 FOR UPDATE`, [bankId]);
    const before = existingRes.rows[0] || null;

    // Field tidak dikirim (undefined) -> pertahankan nilai existing (atau
    // default 10jt kalau baris belum pernah ada) -- lihat komentar destructure
    // di atas. Field dikirim EKSPLISIT null/angka -> divalidasi & dipakai.
    const DEFAULT_FUNDING_TOLERANCE = 10000000;
    for (const [label, v] of [['funding_plan_variance_tolerance', fundingPlanVarianceToleranceInput], ['funding_scheduler_tolerance', fundingSchedulerToleranceInput]]) {
      if (v !== undefined && v !== null && (Number.isNaN(Number(v)) || Number(v) < 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${label} harus angka >= 0.` });
      }
    }
    const fundingPlanVarianceTolerance = fundingPlanVarianceToleranceInput !== undefined
      ? (fundingPlanVarianceToleranceInput === null ? DEFAULT_FUNDING_TOLERANCE : Number(fundingPlanVarianceToleranceInput))
      : (before ? Number(before.funding_plan_variance_tolerance) : DEFAULT_FUNDING_TOLERANCE);
    const fundingSchedulerTolerance = fundingSchedulerToleranceInput !== undefined
      ? (fundingSchedulerToleranceInput === null ? DEFAULT_FUNDING_TOLERANCE : Number(fundingSchedulerToleranceInput))
      : (before ? Number(before.funding_scheduler_tolerance) : DEFAULT_FUNDING_TOLERANCE);

    const r = await client.query(
      `INSERT INTO bct_balance_policies
        (bank_account_id, absolute_minimum_balance, watch_threshold, excess_balance_threshold, stale_after_minutes,
         safety_buffer_percentage, topup_rounding_amount, critical_threshold, emergency_threshold, reserve_balance,
         sudden_drop_window_minutes, sudden_drop_amount_threshold, sudden_drop_percentage_threshold, is_active, created_by,
         burn_window_minutes, topup_lead_time_minutes, critical_margin_minutes, watch_buffer_minutes,
         safety_buffer_type, safety_buffer_fixed_amount, funding_plan_variance_tolerance, funding_scheduler_tolerance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (bank_account_id) DO UPDATE SET
         absolute_minimum_balance = EXCLUDED.absolute_minimum_balance,
         watch_threshold = EXCLUDED.watch_threshold,
         excess_balance_threshold = EXCLUDED.excess_balance_threshold,
         stale_after_minutes = EXCLUDED.stale_after_minutes,
         safety_buffer_percentage = EXCLUDED.safety_buffer_percentage,
         topup_rounding_amount = EXCLUDED.topup_rounding_amount,
         critical_threshold = EXCLUDED.critical_threshold,
         emergency_threshold = EXCLUDED.emergency_threshold,
         reserve_balance = EXCLUDED.reserve_balance,
         sudden_drop_window_minutes = EXCLUDED.sudden_drop_window_minutes,
         sudden_drop_amount_threshold = EXCLUDED.sudden_drop_amount_threshold,
         sudden_drop_percentage_threshold = EXCLUDED.sudden_drop_percentage_threshold,
         is_active = EXCLUDED.is_active,
         burn_window_minutes = EXCLUDED.burn_window_minutes,
         topup_lead_time_minutes = EXCLUDED.topup_lead_time_minutes,
         critical_margin_minutes = EXCLUDED.critical_margin_minutes,
         watch_buffer_minutes = EXCLUDED.watch_buffer_minutes,
         safety_buffer_type = EXCLUDED.safety_buffer_type,
         safety_buffer_fixed_amount = EXCLUDED.safety_buffer_fixed_amount,
         funding_plan_variance_tolerance = EXCLUDED.funding_plan_variance_tolerance,
         funding_scheduler_tolerance = EXCLUDED.funding_scheduler_tolerance,
         updated_at = NOW()
       RETURNING *`,
      [bankId, absolute_minimum_balance, watch_threshold, excess_balance_threshold, stale_after_minutes,
        safety_buffer_percentage, topup_rounding_amount, critical_threshold, emergency_threshold, reserve_balance,
        sudden_drop_window_minutes, sudden_drop_amount_threshold, sudden_drop_percentage_threshold,
        !!is_active, req.user?.username || null,
        burn_window_minutes !== null && burn_window_minutes !== undefined ? Number(burn_window_minutes) : null,
        topup_lead_time_minutes !== null && topup_lead_time_minutes !== undefined ? Number(topup_lead_time_minutes) : null,
        critical_margin_minutes !== null && critical_margin_minutes !== undefined ? Number(critical_margin_minutes) : null,
        watch_buffer_minutes !== null && watch_buffer_minutes !== undefined ? Number(watch_buffer_minutes) : null,
        safetyBufferTypeNormalized,
        safety_buffer_fixed_amount !== null && safety_buffer_fixed_amount !== undefined ? Number(safety_buffer_fixed_amount) : null,
        fundingPlanVarianceTolerance, fundingSchedulerTolerance]
    );

    await logAudit(client, {
      entityType: 'BANK_POLICY', entityId: bankId, action: before ? 'UPDATE_POLICY' : 'CREATE_POLICY',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: reason,
    });
    await client.query('COMMIT');

    res.json({ success: true, policy: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-control-tower upsert policy error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// FORECAST — OCBC Rekonsiliasi sbg source, Balance Control Tower sbg
// control room. GET = live/read-only (dipanggil bebas, tidak nulis apa pun).
// POST .../refresh = eksplisit generate + PERSIST 1 baris riwayat forecast,
// + audit (generation, status change, recommendation change).
// ─────────────────────────────────────────────────────────────────────────
router.get('/banks/:id/forecast', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await pool.query(`SELECT * FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const bank = bankRes.rows[0];

    const [policyRes, snapshotsRes] = await Promise.all([
      pool.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [id]),
      pool.query(`SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 2`, [id]),
    ]);
    const policy = policyRes.rows[0] || null;
    const snapshot = snapshotsRes.rows[0] || null;
    const previousSnapshot = snapshotsRes.rows[1] || null;
    const now = new Date();

    const forecast = await computeForecastForBank(pool, bank, snapshot, previousSnapshot, policy, now);
    const { status, reason, operational } = await resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now });

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, bank_id: id, status, status_reason: reason, operational, forecast });
  } catch (e) {
    console.error('balance-control-tower get forecast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/banks/:id/forecast/refresh', requireOpsOrFinance, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await client.query(`SELECT * FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const bank = bankRes.rows[0];

    const [policyRes, snapshotsRes, lastForecastRes] = await Promise.all([
      client.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [id]),
      client.query(`SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 2`, [id]),
      client.query(`SELECT * FROM bct_forecast_snapshots WHERE bank_account_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
    ]);
    const policy = policyRes.rows[0] || null;
    const snapshot = snapshotsRes.rows[0] || null;
    const previousSnapshot = snapshotsRes.rows[1] || null;
    const lastForecast = lastForecastRes.rows[0] || null;
    const now = new Date();

    const forecast = await computeForecastForBank(pool, bank, snapshot, previousSnapshot, policy, now);
    const { status, reason, operational } = await resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now });
    // recommended_topup_amount TERSIMPAN mengikuti sumber otoritatif SAAT INI
    // (operational engine kalau tersedia, forecast lama HANYA fallback) --
    // konsisten dgn mapBankRow, TIDAK ada 2 angka top-up berbeda beredar.
    const authoritativeTopup = operational ? operational.recommended_topup : (forecast?.recommended_topup_amount ?? null);
    const authoritativeDeadline = operational ? operational.topup_deadline : (forecast?.recommended_topup_deadline ?? null);

    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO bct_forecast_snapshots
        (bank_account_id, status, status_reason, effective_balance, forecast_required_balance, projected_balance_at_next_funding,
         estimated_runway_minutes, average_burn_rate, peak_burn_rate, dynamic_reserve_balance, dynamic_watch_threshold,
         dynamic_critical_threshold, dynamic_emergency_threshold, recommended_topup_amount, recommended_topup_deadline,
         forecast_confidence, forecast_source, forecast_available, raw_output, created_by,
         calculation_version, usable_balance, burn_window_minutes_used, burn_rate_per_minute, usable_runway_minutes,
         zero_balance_runway_minutes, lead_time_need, safety_buffer_amount, safe_target_balance, operational_status, data_freshness_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       RETURNING *`,
      [id, status, reason, snapshot ? snapshot.effective_balance : null,
        forecast?.forecast_required_balance ?? null, forecast?.projected_balance_at_next_funding ?? null,
        forecast?.estimated_runway_minutes ?? null, forecast?.average_burn_rate ?? null, forecast?.peak_burn_rate ?? null,
        forecast?.dynamic_reserve_balance ?? null, forecast?.dynamic_watch_threshold ?? null,
        forecast?.dynamic_critical_threshold ?? null, forecast?.dynamic_emergency_threshold ?? null,
        authoritativeTopup, authoritativeDeadline,
        forecast?.forecast_confidence ?? null, forecast?.forecast_source ?? null, !!forecast?.forecast_available,
        forecast ? JSON.stringify(forecast) : null, req.user?.username || null,
        operational?.calculation_version ?? null, operational?.usable_balance ?? null, operational?.selected_burn_window_minutes ?? null,
        operational?.burn_rate_per_minute ?? null, operational?.usable_runway_minutes ?? null,
        operational?.zero_balance_runway_minutes ?? null, operational?.lead_time_need ?? null,
        operational?.safety_buffer_amount ?? null, operational?.safe_target_balance ?? null,
        operational?.operational_status ?? null, operational?.data_freshness_status ?? null]
    );

    await logAudit(client, {
      entityType: 'FORECAST', entityId: id, action: 'REFRESH_FORECAST',
      actorUserId: req.user?.id, actorUsername: req.user?.username,
      before: lastForecast, after: insertRes.rows[0],
      notes: `calc_source=${operational ? 'OPERATIONAL_ENGINE' : 'LEGACY_FORECAST'}, forecast_available=${!!forecast?.forecast_available}, source=${forecast?.forecast_source || 'null'}`,
    });

    if (lastForecast && lastForecast.status !== status) {
      await logAudit(client, {
        entityType: 'FORECAST', entityId: id, action: 'STATUS_CHANGE',
        actorUserId: req.user?.id, actorUsername: req.user?.username,
        before: { status: lastForecast.status, status_reason: lastForecast.status_reason },
        after: { status, status_reason: reason },
      });
    }
    const prevTopup = lastForecast ? Number(lastForecast.recommended_topup_amount || 0) : null;
    const newTopup = authoritativeTopup !== null && authoritativeTopup !== undefined ? Number(authoritativeTopup) : null;
    if (prevTopup !== null && newTopup !== null && Math.abs(prevTopup - newTopup) >= 1) {
      await logAudit(client, {
        entityType: 'FORECAST', entityId: id, action: 'RECOMMENDATION_CHANGE',
        actorUserId: req.user?.id, actorUsername: req.user?.username,
        before: { recommended_topup_amount: prevTopup }, after: { recommended_topup_amount: newTopup },
      });
    }

    await client.query('COMMIT');
    res.json({ success: true, forecast_snapshot: insertRes.rows[0], status, status_reason: reason, operational, forecast });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('balance-control-tower refresh forecast error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// COMMAND CENTER — tampilan dark "top-up command center" per-bank (item
// baru, TIDAK menggantikan tab Monitoring Saldo/FA Action Summary lama).
// SEMUA angka murni REUSE dari yang sudah ada (operational engine, funding
// mutations rekonsiliasi) DITAMBAH beberapa query baru yang scoped ke
// business_date HARI INI SAJA (bank_code + business_date, pola sama dgn
// runOcbcEngineAndPersist) utk: breakdown status rekonsiliasi (donut),
// tren outflow per-menit 60 menit terakhir (sparkline), transaksi terbaru,
// dan anomali. HANYA bank dgn adapter rekonsiliasi (isSupportedBank) yang
// didukung -- bank lain dapat response `supported: false` yang jelas,
// TIDAK mencoba mengarang data.
// ─────────────────────────────────────────────────────────────────────────
const RECON_STATUS_LABEL_ID = {
  MATCHED: 'Matched dengan Fee',
  MATCHED_NO_FEE: 'Matched',
  PENDING_BANK: 'Menunggu Bank',
  FP_ONLY: 'FP Belum Keluar di Bank',
  BANK_ONLY: 'Bank Tidak Ditemukan di FP',
  NOMINAL_MISMATCH: 'Mismatch Nominal',
  FEE_MISMATCH: 'Mismatch Fee',
  DUPLICATE_FP: 'Duplikasi FP',
  DUPLICATE_BANK: 'Duplikasi Bank',
  REVERSAL: 'Reversal / Return',
  NEED_REVIEW: 'Perlu Review',
};

router.get('/banks/:id/command-center', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    const bankRes = await pool.query(`SELECT * FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const bank = bankRes.rows[0];

    if (!isSupportedBank(bank.bank_code)) {
      return res.json({
        success: true, supported: false, bank,
        message: `Command Center belum didukung untuk ${bank.bank_code} — memerlukan adapter rekonsiliasi (saat ini hanya OCBC).`,
      });
    }

    try { await refreshBankPositionIfNeeded(bank); }
    catch (e) { console.error(`refresh position (${bank.bank_code}) error:`, e.message); }

    const [policyRes, recentSnapshotsRes] = await Promise.all([
      pool.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [id]),
      pool.query(`SELECT * FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 20`, [id]),
    ]);
    const policy = policyRes.rows[0] || null;
    const { snapshot, previousSnapshot } = pickCurrentAndPrevious(recentSnapshotsRes.rows, true);
    const now = new Date();
    const { status, reason: statusReason, operational } = await resolveFinalStatus({ bank, snapshot, previousSnapshot, policy, now });
    const balanceMovement = computeBalanceMovement({ current: snapshot, previous: previousSnapshot });

    const businessDate = operational?.today_usage?.business_date || isoDateJakarta(now);

    // Seluruh baris recon_results HARI INI (business_date bank ini) -- dasar
    // utk donut status, transaksi terbaru, tren per-menit, dan anomali.
    // Query TUNGGAL, hasilnya di-derive jadi 4 widget sekaligus di JS supaya
    // tidak query recon_results 4x.
    const reconRes = await pool.query(
      `SELECT r.recon_status, r.fp_nominal, r.bank_principal, r.bank_fee, r.fp_time_response,
              r.id_transaksi, r.id_outlet, r.id_produk
       FROM recon_results r
       JOIN recon_sync_batches b ON b.id = r.batch_id
       WHERE b.bank_code = $1 AND b.business_date = $2`,
      [bank.bank_code, businessDate]
    );
    const reconRows = reconRes.rows;

    // Donut "Rekonsiliasi FP vs Bank" — breakdown per recon_status.
    const statusCounts = new Map();
    for (const r of reconRows) statusCounts.set(r.recon_status, (statusCounts.get(r.recon_status) || 0) + 1);
    const totalFp = reconRows.length;
    const reconciliationToday = {
      total_fp: totalFp,
      by_status: [...statusCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reconStatus, count]) => ({
          recon_status: reconStatus,
          label: RECON_STATUS_LABEL_ID[reconStatus] || reconStatus,
          count,
          percentage: totalFp > 0 ? round2((count / totalFp) * 100) : null,
        })),
    };

    // Anomali & Perhatian — subset non-matched dari donut yang sama (TIDAK query ulang).
    const anomalyCountFor = (...statuses) => statuses.reduce((s, st) => s + (statusCounts.get(st) || 0), 0);
    const anomalies = {
      fp_only: anomalyCountFor('FP_ONLY'),
      bank_only: anomalyCountFor('BANK_ONLY'),
      nominal_mismatch: anomalyCountFor('NOMINAL_MISMATCH'),
      duplicate: anomalyCountFor('DUPLICATE_FP', 'DUPLICATE_BANK'),
      reversal: anomalyCountFor('REVERSAL'),
    };

    // Transaksi Terbaru — 20 baris matched (MATCHED/MATCHED_NO_FEE/FEE_MISMATCH)
    // terakhir berdasarkan fp_time_response, sama definisi "matched" dgn
    // fetchRecentMatchedOutflows (operationalDataAccess.js) supaya konsisten
    // dgn angka outflow window di atasnya.
    const MATCHED_STATUSES = new Set(['MATCHED', 'MATCHED_NO_FEE', 'FEE_MISMATCH']);
    const recentTransactions = reconRows
      .filter(r => r.fp_time_response && MATCHED_STATUSES.has(r.recon_status))
      .sort((a, b) => new Date(b.fp_time_response) - new Date(a.fp_time_response))
      .slice(0, 20)
      .map(r => ({
        waktu: r.fp_time_response,
        id_transaksi: r.id_transaksi,
        id_outlet: r.id_outlet,
        id_produk: r.id_produk,
        nominal_fp: r.fp_nominal !== null ? Number(r.fp_nominal) : null,
        debit: r.bank_principal !== null ? Number(r.bank_principal) : null,
        fee: r.bank_fee !== null ? Number(r.bank_fee) : null,
        status: r.recon_status,
        status_label: RECON_STATUS_LABEL_ID[r.recon_status] || r.recon_status,
      }));

    // Tren Transaksi 60 menit — outflow (bank_principal) matched, dibucket
    // per-menit Asia/Jakarta, 60 titik penuh (menit tanpa transaksi = 0,
    // BUKAN diloncat) supaya sparkline tidak menyesatkan.
    const trendBuckets = new Map(); // key: 'HH:mm' Jakarta -> total
    const trendStart = new Date(now.getTime() - 60 * 60000);
    for (const r of reconRows) {
      if (!r.fp_time_response || !MATCHED_STATUSES.has(r.recon_status)) continue;
      const t = new Date(r.fp_time_response);
      if (t < trendStart || t > now) continue;
      const minuteKey = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(t);
      trendBuckets.set(minuteKey, (trendBuckets.get(minuteKey) || 0) + (Number(r.bank_principal) || 0));
    }
    const trend60Min = [];
    for (let i = 59; i >= 0; i--) {
      const t = new Date(now.getTime() - i * 60000);
      const minuteKey = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(t);
      trend60Min.push({ minute: minuteKey, outflow: trendBuckets.get(minuteKey) || 0 });
    }

    // Funding Monitor & Riwayat Top-up (Funding) — REUSE getConfirmedFundingMutations
    // yang sama dipakai tab Monitoring Saldo (fundingDetectionService.js),
    // scoped ke business_date hari ini saja, exclude REVERSAL (funding asli saja).
    let fundingToday = [];
    try {
      const fundingRes = await getConfirmedFundingMutations({ pool, bankCode: bank.bank_code, bankAccountId: bank.id, from: businessDate, to: businessDate });
      if (fundingRes.available) fundingToday = fundingRes.mutations.filter(m => m.classification === 'FUNDING');
    } catch (e) { console.error(`command-center funding (${bank.bank_code}) error:`, e.message); }
    fundingToday.sort((a, b) => new Date(a.transaction_datetime) - new Date(b.transaction_datetime));
    const fundingMonitor = {
      total: fundingToday.reduce((s, m) => s + (Number(m.amount) || 0), 0),
      frequency: fundingToday.length,
      biggest: fundingToday.length ? Math.max(...fundingToday.map(m => Number(m.amount) || 0)) : 0,
      events: fundingToday.map(m => ({ waktu: m.transaction_datetime, nominal: Number(m.amount) || 0 })),
    };
    const topupRiwayatFunding = [...fundingToday].reverse().slice(0, 10).map(m => ({
      waktu: m.transaction_datetime, nominal: Number(m.amount) || 0, sumber: 'Internal Funding', status: 'CONFIRMED',
    }));

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      supported: true,
      bank,
      policy,
      status,
      status_reason: statusReason,
      operational,
      balance_movement: balanceMovement,
      business_date: businessDate,
      reconciliation_today: reconciliationToday,
      anomalies,
      recent_transactions: recentTransactions,
      trend_60min: trend60Min,
      funding_monitor: fundingMonitor,
      topup_riwayat_funding: topupRiwayatFunding,
    });
  } catch (e) {
    console.error('balance-control-tower command-center error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/banks/:id/forecast/history', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT id, status, status_reason, effective_balance, forecast_required_balance, dynamic_reserve_balance,
              dynamic_watch_threshold, dynamic_critical_threshold, dynamic_emergency_threshold,
              recommended_topup_amount, recommended_topup_deadline, forecast_confidence, forecast_source,
              forecast_available, created_by, created_at
       FROM bct_forecast_snapshots WHERE bank_account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [id, limit]
    );
    res.json({ success: true, forecast_history: r.rows });
  } catch (e) {
    console.error('balance-control-tower forecast history error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// FUNDING SCHEDULER ADJUSTMENT ASSISTANT — advisory only (ALERT + RECOMMENDATION
// + REMINDER). TIDAK PERNAH transfer/cancel/edit scheduler bank otomatis;
// keputusan/eksekusi nyata tetap manual oleh FA. Lihat
// docs/BALANCE_CONTROL_TOWER_SCHEDULER.md utk detail formula & business rule.
// ─────────────────────────────────────────────────────────────────────────

// Alert type MILIK fitur ini SAJA -- dedupe/resolve TERPISAH dari
// syncAlertsForBank (status operasional bank) supaya tidak saling menimpa
// (syncAlertsForBank me-resolve SEMUA alert OPEN yang tipenya beda dari
// alert status bank saat itu -- kalau dicampur, alert scheduler ini akan
// langsung ter-auto-resolve tiap kali /summary dipanggil).
const FUNDING_SCHEDULER_ALERT_TYPES = ['ABOVE_PLAN', 'BELOW_PLAN', 'SCHEDULER_CANCEL', 'SCHEDULER_REDUCE', 'SCHEDULER_ADD', 'SCHEDULER_MISSED'];

function fundingAlertMessages(result) {
  const needed = new Map();
  const cp = result.current_plan;
  if (cp && cp.status === 'ABOVE_PLAN') {
    needed.set('ABOVE_PLAN', `Saldo berjalan Rp${Math.round(cp.variance).toLocaleString('id-ID')} di atas rencana (Plan ${String(cp.hour).padStart(2, '0')}:00).`);
  } else if (cp && cp.status === 'BELOW_PLAN') {
    needed.set('BELOW_PLAN', `Saldo berjalan Rp${Math.round(Math.abs(cp.variance)).toLocaleString('id-ID')} di bawah rencana (Plan ${String(cp.hour).padStart(2, '0')}:00).`);
  }
  const ns = result.next_scheduler;
  if (ns && ns.recommendation === 'CANCEL') {
    needed.set('SCHEDULER_CANCEL', `Scheduler ${ns.funding_source_code} ${ns.scheduled_time} (Rp${Math.round(ns.scheduled_amount).toLocaleString('id-ID')}) dapat dibatalkan.`);
  } else if (ns && ns.recommendation === 'REDUCE') {
    needed.set('SCHEDULER_REDUCE', `Scheduler ${ns.funding_source_code} ${ns.scheduled_time} disarankan dikurangi ±Rp${Math.round(Math.abs(ns.adjustment_amount)).toLocaleString('id-ID')}.`);
  } else if (ns && ns.recommendation === 'ADD') {
    needed.set('SCHEDULER_ADD', `Scheduler ${ns.funding_source_code} ${ns.scheduled_time} disarankan ditambah ±Rp${Math.round(Math.abs(ns.adjustment_amount)).toLocaleString('id-ID')}.`);
  }
  return needed;
}

async function syncFundingSchedulerAlerts(client, bankId, result) {
  const needed = fundingAlertMessages(result);
  const neededTypes = [...needed.keys()];
  await client.query(
    `UPDATE bct_alerts SET status = 'RESOLVED', resolved_by = 'system', resolved_at = NOW(), updated_at = NOW(),
            reason = COALESCE(reason || ' ', '') || '[auto-resolved: kondisi kembali normal]'
     WHERE bank_account_id = $1 AND status = 'OPEN' AND alert_type = ANY($2::text[]) AND NOT (alert_type = ANY($3::text[]))`,
    [bankId, FUNDING_SCHEDULER_ALERT_TYPES, neededTypes]
  );
  for (const [type, message] of needed) {
    await client.query(
      `INSERT INTO bct_alerts (bank_account_id, alert_type, status, message) VALUES ($1,$2,'OPEN',$3)
       ON CONFLICT (bank_account_id, alert_type) WHERE status = 'OPEN' DO NOTHING`,
      [bankId, type, message]
    );
  }
}

/**
 * Persist history HANYA kalau rekomendasi berubah material sejak baris
 * terakhir (spec section 35 -- bukan tiap kali GET/polling dipanggil).
 * Best-effort: gagal simpan TIDAK BOLEH menggagalkan response GET.
 */
async function maybePersistRecommendationHistory(client, bankId, result) {
  const latestRes = await client.query(
    `SELECT * FROM bct_funding_recommendation_history WHERE bank_account_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
    [bankId]
  );
  const latest = latestRes.rows[0] || null;
  const ns = result.next_scheduler;
  const nextId = ns ? ns.id : null;
  const adjustment = ns ? ns.adjustment_amount : null;
  const changed = !latest
    || latest.recommendation !== result.recommendation
    || (latest.next_scheduler_id === null ? null : Number(latest.next_scheduler_id)) !== nextId
    || Number(latest.adjustment_amount ?? 0) !== Number(adjustment ?? 0);
  if (!changed) return latest;

  const inserted = await client.query(
    `INSERT INTO bct_funding_recommendation_history
      (bank_account_id, current_hour, actual_balance, planned_balance, variance, variance_status,
       next_scheduler_id, next_scheduler_time, next_scheduler_source, projected_balance_before_next,
       target_balance_after_next, existing_scheduled_amount, required_funding, adjustment_amount,
       recommendation, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      bankId, result.current_hour, result.actual_balance,
      result.current_plan ? result.current_plan.planned_balance : null,
      result.current_plan ? result.current_plan.variance : null,
      result.current_plan ? result.current_plan.status : null,
      nextId, ns ? ns.scheduled_time : null, ns ? ns.funding_source_code : null,
      ns ? ns.projected_balance_before : null, ns ? ns.target_planned_balance : null,
      ns ? ns.scheduled_amount : null, ns ? ns.required_funding : null, adjustment,
      result.recommendation, result.reason,
    ]
  );
  return inserted.rows[0];
}

async function loadBankAndPolicy(id) {
  const bankRes = await pool.query(`SELECT * FROM bct_bank_accounts WHERE id = $1`, [id]);
  if (!bankRes.rows.length) return { bank: null, policy: null };
  const policyRes = await pool.query(`SELECT * FROM bct_balance_policies WHERE bank_account_id = $1`, [id]);
  return { bank: bankRes.rows[0], policy: policyRes.rows[0] || null };
}

// GET /banks/:id/funding-scheduler — payload utama (KPI cards, alert, timeline, chart 24 jam).
router.get('/banks/:id/funding-scheduler', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const { bank, policy } = await loadBankAndPolicy(id);
    if (!bank) return res.status(404).json({ error: 'Bank tidak ditemukan.' });

    if (isSupportedBank(bank.bank_code)) {
      try { await refreshBankPositionIfNeeded(bank); }
      catch (e) { console.error(`funding-scheduler refresh position (${bank.bank_code}) error:`, e.message); }
    }

    const now = new Date();
    const result = await computeFundingSchedulerForBank({ pool, bank, policy, now });

    try { await syncFundingSchedulerAlerts(client, id, result); }
    catch (e) { console.error('syncFundingSchedulerAlerts error:', e.message); }
    try { await maybePersistRecommendationHistory(client, id, result); }
    catch (e) { console.error('maybePersistRecommendationHistory error:', e.message); }

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, bank_account_id: id, ...result });
  } catch (e) {
    console.error('balance-control-tower funding-scheduler error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /banks/:id/funding-scheduler/acknowledge — FA/admin menandai "sudah ditindaklanjuti".
// TIDAK menjalankan transaksi bank apa pun -- murni catat snapshot + user + note.
router.post('/banks/:id/funding-scheduler/acknowledge', requireFinance, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const { bank, policy } = await loadBankAndPolicy(id);
    if (!bank) return res.status(404).json({ error: 'Bank tidak ditemukan.' });
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 2000) : null;

    const now = new Date();
    const result = await computeFundingSchedulerForBank({ pool, bank, policy, now });
    const ns = result.next_scheduler;

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO bct_funding_recommendation_history
        (bank_account_id, current_hour, actual_balance, planned_balance, variance, variance_status,
         next_scheduler_id, next_scheduler_time, next_scheduler_source, projected_balance_before_next,
         target_balance_after_next, existing_scheduled_amount, required_funding, adjustment_amount,
         recommendation, reason, acknowledged_by, acknowledged_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18)
       RETURNING *`,
      [
        id, result.current_hour, result.actual_balance,
        result.current_plan ? result.current_plan.planned_balance : null,
        result.current_plan ? result.current_plan.variance : null,
        result.current_plan ? result.current_plan.status : null,
        ns ? ns.id : null, ns ? ns.scheduled_time : null, ns ? ns.funding_source_code : null,
        ns ? ns.projected_balance_before : null, ns ? ns.target_planned_balance : null,
        ns ? ns.scheduled_amount : null, ns ? ns.required_funding : null, ns ? ns.adjustment_amount : null,
        result.recommendation, result.reason, req.user?.username || null, note,
      ]
    );
    await logAudit(client, {
      entityType: 'FUNDING_SCHEDULER_RECOMMENDATION', entityId: inserted.rows[0].id, action: 'ACKNOWLEDGE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: null, after: inserted.rows[0], notes: note,
    });
    await client.query('COMMIT');
    res.json({ success: true, acknowledgement: inserted.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('funding-scheduler acknowledge error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /banks/:id/funding-scheduler/history — riwayat rekomendasi (audit).
router.get('/banks/:id/funding-scheduler/history', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT * FROM bct_funding_recommendation_history WHERE bank_account_id = $1 ORDER BY calculated_at DESC LIMIT $2`,
      [id, limit]
    );
    res.json({ success: true, history: r.rows });
  } catch (e) {
    console.error('funding-scheduler history error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin config: Hourly Balance Plan ───────────────────────────────────
router.get('/banks/:id/funding-scheduler/hourly-plan', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const r = await pool.query(
      `SELECT * FROM bct_hourly_balance_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY hour_of_day`,
      [id]
    );
    res.json({ success: true, hourly_plan: r.rows });
  } catch (e) {
    console.error('funding-scheduler hourly-plan get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/banks/:id/funding-scheduler/hourly-plan/:hour', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const hour = parseInt(req.params.hour, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: 'hour harus 0-23.' });
    const bankRes = await client.query(`SELECT id FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });

    const { average_burn = null, planned_balance = null, tolerance = null, is_active = true } = req.body || {};
    for (const [label, v] of [['average_burn', average_burn], ['planned_balance', planned_balance], ['tolerance', tolerance]]) {
      if (v !== null && v !== undefined && (Number.isNaN(Number(v)) || Number(v) < 0)) {
        return res.status(400).json({ error: `${label} harus angka >= 0.` });
      }
    }

    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT * FROM bct_hourly_balance_plan WHERE bank_account_id = $1 AND hour_of_day = $2 AND is_active = TRUE FOR UPDATE`,
      [id, hour]
    );
    const before = existingRes.rows[0] || null;
    const r = await client.query(
      `INSERT INTO bct_hourly_balance_plan (bank_account_id, hour_of_day, average_burn, planned_balance, tolerance, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (bank_account_id, hour_of_day) WHERE is_active = TRUE DO UPDATE SET
         average_burn = EXCLUDED.average_burn, planned_balance = EXCLUDED.planned_balance,
         tolerance = EXCLUDED.tolerance, is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`,
      [id, hour, average_burn, planned_balance, tolerance, !!is_active, req.user?.username || null]
    );
    await logAudit(client, {
      entityType: 'FUNDING_HOURLY_PLAN', entityId: r.rows[0].id, action: before ? 'UPDATE' : 'CREATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: req.body?.reason || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, hourly_plan: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('funding-scheduler hourly-plan put error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Admin config: Funding Scheduler Plan ────────────────────────────────
router.get('/banks/:id/funding-scheduler/scheduler-plan', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const r = await pool.query(
      `SELECT * FROM bct_funding_scheduler_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY scheduled_time`,
      [id]
    );
    res.json({ success: true, scheduler_plan: r.rows });
  } catch (e) {
    console.error('funding-scheduler scheduler-plan get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const VALID_SCHEDULER_STATUS = ['SCHEDULED', 'CONFIRMED', 'CANCELLED', 'ADJUSTED', 'COMPLETED', 'MISSED'];

router.post('/banks/:id/funding-scheduler/scheduler-plan', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const bankRes = await client.query(`SELECT id FROM bct_bank_accounts WHERE id = $1`, [id]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });

    const scheduledTime = String(req.body?.scheduled_time || '').trim();
    const fundingSourceCode = String(req.body?.funding_source_code || '').trim().toUpperCase();
    const scheduledAmount = req.body?.scheduled_amount;
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(scheduledTime)) return res.status(400).json({ error: 'scheduled_time harus format HH:mm.' });
    if (!fundingSourceCode) return res.status(400).json({ error: 'funding_source_code wajib diisi (mis. BNI, BRI).' });
    if (scheduledAmount === undefined || scheduledAmount === null || Number.isNaN(Number(scheduledAmount)) || Number(scheduledAmount) < 0) {
      return res.status(400).json({ error: 'scheduled_amount harus angka >= 0.' });
    }

    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO bct_funding_scheduler_plan (bank_account_id, scheduled_time, funding_source_code, scheduled_amount, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,'SCHEDULED',$5,$5) RETURNING *`,
      [id, scheduledTime, fundingSourceCode, Number(scheduledAmount), req.user?.username || null]
    );
    await logAudit(client, {
      entityType: 'FUNDING_SCHEDULER_PLAN', entityId: r.rows[0].id, action: 'CREATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before: null, after: r.rows[0], notes: req.body?.reason || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, scheduler: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).includes('uq_bct_scheduler_plan_active')) {
      return res.status(409).json({ error: 'Sudah ada scheduler aktif pada jam tersebut.' });
    }
    console.error('funding-scheduler scheduler-plan post error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.put('/banks/:id/funding-scheduler/scheduler-plan/:schedulerId', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const schedulerId = parseInt(req.params.schedulerId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(schedulerId)) return res.status(400).json({ error: 'id tidak valid.' });

    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT * FROM bct_funding_scheduler_plan WHERE id = $1 AND bank_account_id = $2 FOR UPDATE`,
      [schedulerId, id]
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

    if (!VALID_SCHEDULER_STATUS.includes(status)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `status harus salah satu: ${VALID_SCHEDULER_STATUS.join(', ')}.` }); }
    if (!fundingSourceCode) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'funding_source_code wajib diisi.' }); }
    if (Number.isNaN(scheduledAmount) || scheduledAmount < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'scheduled_amount harus angka >= 0.' }); }

    const r = await client.query(
      `UPDATE bct_funding_scheduler_plan SET
         scheduled_time = $1, funding_source_code = $2, scheduled_amount = $3, status = $4,
         is_active = $5, actual_amount = $6, note = $7, updated_by = $8, updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [scheduledTime, fundingSourceCode, scheduledAmount, status, isActive, actualAmount, note, req.user?.username || null, schedulerId]
    );

    if (status === 'MISSED' && before.status !== 'MISSED') {
      await client.query(
        `INSERT INTO bct_alerts (bank_account_id, alert_type, status, message) VALUES ($1,'SCHEDULER_MISSED','OPEN',$2)
         ON CONFLICT (bank_account_id, alert_type) WHERE status = 'OPEN' DO NOTHING`,
        [id, `Scheduler ${fundingSourceCode} ${scheduledTime} ditandai MISSED oleh ${req.user?.username || 'admin'}.`]
      );
    }
    await logAudit(client, {
      entityType: 'FUNDING_SCHEDULER_PLAN', entityId: schedulerId, action: 'UPDATE',
      actorUserId: req.user?.id, actorUsername: req.user?.username, before, after: r.rows[0], notes: req.body?.reason || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, scheduler: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (String(e.message).includes('uq_bct_scheduler_plan_active')) {
      return res.status(409).json({ error: 'Sudah ada scheduler aktif pada jam tersebut.' });
    }
    console.error('funding-scheduler scheduler-plan put error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /banks/:id/funding-scheduler/baseline-check — data quality check (spec section 29), read-only.
router.get('/banks/:id/funding-scheduler/baseline-check', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const [planRes, schedulerRes] = await Promise.all([
      pool.query(`SELECT hour_of_day, average_burn, planned_balance FROM bct_hourly_balance_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY hour_of_day`, [id]),
      pool.query(`SELECT scheduled_time, scheduled_amount FROM bct_funding_scheduler_plan WHERE bank_account_id = $1 AND is_active = TRUE ORDER BY scheduled_time`, [id]),
    ]);
    const rows = planRes.rows;
    const schedulerByHour = new Map();
    for (const s of schedulerRes.rows) {
      const h = parseInt(String(s.scheduled_time).slice(0, 2), 10);
      schedulerByHour.set(h, (schedulerByHour.get(h) || 0) + Number(s.scheduled_amount));
    }
    const results = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (prev.planned_balance === null || cur.average_burn === null || cur.planned_balance === null) continue;
      const check = validateBaselineFormula({
        previousPlanned: Number(prev.planned_balance), expectedBurn: Number(cur.average_burn),
        schedulerAmount: schedulerByHour.get(cur.hour_of_day) || 0, currentPlanned: Number(cur.planned_balance),
      });
      results.push({ hour: cur.hour_of_day, ...check });
    }
    res.json({ success: true, checks: results, mismatches: results.filter(r => r.valid === false) });
  } catch (e) {
    console.error('funding-scheduler baseline-check error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// TOP UP WORKFLOW — DRAFT -> REQUESTED -> APPROVED -> TRANSFERRED
//                -> BALANCE_CONFIRMED -> COMPLETED  (+ REJECTED, CANCELLED)
// ─────────────────────────────────────────────────────────────────────────
router.post('/topup', requireOpsOrFinance, async (req, res) => {
  try {
    const bankId = parseInt(req.body?.bank_account_id, 10);
    const amount = req.body?.requested_amount;
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    const recommendationSource = req.body?.recommendation_source ? String(req.body.recommendation_source).toUpperCase() : 'MANUAL';

    if (!Number.isFinite(bankId)) return res.status(400).json({ error: 'bank_account_id wajib diisi.' });
    if (amount === undefined || amount === null || amount === '' || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'requested_amount wajib diisi, angka > 0.' });
    }
    if (!VALID_RECOMMENDATION_SOURCE.includes(recommendationSource)) {
      return res.status(400).json({ error: `recommendation_source wajib salah satu: ${VALID_RECOMMENDATION_SOURCE.join(', ')}` });
    }

    const bankRes = await pool.query(`SELECT id FROM bct_bank_accounts WHERE id = $1`, [bankId]);
    if (!bankRes.rows.length) return res.status(404).json({ error: 'Bank tidak ditemukan.' });

    const snapRes = await pool.query(
      `SELECT effective_balance FROM bct_balance_snapshots WHERE bank_account_id = $1 ORDER BY captured_at DESC LIMIT 1`, [bankId]
    );
    const balanceBefore = snapRes.rows[0] ? snapRes.rows[0].effective_balance : null;

    const r = await pool.query(
      `INSERT INTO bct_topup_requests
        (bank_account_id, requested_amount, requester_user_id, requester_username, reason, recommendation_source, balance_before, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT') RETURNING *`,
      [bankId, amount, req.user?.id || null, req.user?.username || null, reason, recommendationSource, balanceBefore]
    );
    res.json({ success: true, topup: r.rows[0] });
  } catch (e) {
    console.error('balance-control-tower create topup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/topup', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.bank_account_id) {
      params.push(parseInt(req.query.bank_account_id, 10));
      where.push(`bank_account_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(String(req.query.status).toUpperCase());
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    params.push(limit);

    const r = await pool.query(
      `SELECT * FROM bct_topup_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, topups: r.rows });
  } catch (e) {
    console.error('balance-control-tower list topup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/topup/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });
    const r = await pool.query(`SELECT * FROM bct_topup_requests WHERE id = $1`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Permintaan top up tidak ditemukan.' });
    const auditRes = await pool.query(
      `SELECT * FROM bct_audit_log WHERE entity_type = 'TOPUP_REQUEST' AND entity_id = $1 ORDER BY created_at DESC`, [id]
    );
    res.json({ success: true, topup: r.rows[0], audit_log: auditRes.rows });
  } catch (e) {
    console.error('balance-control-tower topup detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Generic atomic transition: lock baris (FOR UPDATE), validasi status asal,
 * jalankan `applyFn` (mengumpulkan kolom SET tambahan), commit + audit log.
 * Dipakai oleh semua endpoint aksi top up supaya transisi status selalu
 * konsisten & pakai transaksi DB (wajib utk aksi finansial).
 */
async function transitionTopup(req, res, { toStatus, action, extraGuard, buildSetClause }) {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    await client.query('BEGIN');
    const curRes = await client.query(`SELECT * FROM bct_topup_requests WHERE id = $1 FOR UPDATE`, [id]);
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Permintaan top up tidak ditemukan.' });
    }
    const current = curRes.rows[0];

    if (!canTransitionTopup(current.status, toStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Transisi status tidak valid: ${current.status} -> ${toStatus}.` });
    }

    if (extraGuard) {
      const guardErr = extraGuard(current);
      if (guardErr) {
        await client.query('ROLLBACK');
        return res.status(guardErr.code || 400).json({ error: guardErr.message });
      }
    }

    const { setSql, setParams } = buildSetClause ? buildSetClause(current) : { setSql: '', setParams: [] };
    const params = [...setParams, id];
    const r = await client.query(
      `UPDATE bct_topup_requests SET status = '${toStatus}', updated_at = NOW() ${setSql}
       WHERE id = $${params.length} RETURNING *`,
      params
    );

    await logAudit(client, {
      entityType: 'TOPUP_REQUEST', entityId: id, action,
      actorUserId: req.user?.id, actorUsername: req.user?.username,
      before: current, after: r.rows[0],
    });
    await client.query('COMMIT');
    res.json({ success: true, topup: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`balance-control-tower transition (${action}) error:`, e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

// DRAFT -> REQUESTED (requester submit permintaan)
router.post('/topup/:id/request', requireOpsOrFinance, (req, res) => {
  transitionTopup(req, res, {
    toStatus: 'REQUESTED', action: 'REQUEST',
    extraGuard: (current) => {
      if (req.user?.role !== 'admin' && String(current.requester_user_id) !== String(req.user?.id)) {
        return { code: 403, message: 'Hanya pembuat draft yang bisa mengajukan permintaan ini.' };
      }
      return null;
    },
    buildSetClause: () => ({ setSql: `, requested_at = NOW()`, setParams: [] }),
  });
});

// REQUESTED -> APPROVED (checker, WAJIB bukan requester)
router.post('/topup/:id/approve', requireFinance, (req, res) => {
  const approvedAmount = req.body?.approved_amount;
  transitionTopup(req, res, {
    toStatus: 'APPROVED', action: 'APPROVE',
    extraGuard: (current) => {
      if (isSelfApproval(current.requester_user_id, req.user?.id)) {
        return { code: 403, message: 'Requester tidak boleh menyetujui permintaannya sendiri (maker-checker).' };
      }
      if (approvedAmount !== undefined && (Number.isNaN(Number(approvedAmount)) || Number(approvedAmount) <= 0)) {
        return { code: 400, message: 'approved_amount harus angka > 0.' };
      }
      return null;
    },
    buildSetClause: (current) => ({
      setSql: `, approved_amount = $1, approver_user_id = $2, approver_username = $3, approved_at = NOW()`,
      setParams: [approvedAmount !== undefined ? approvedAmount : current.requested_amount, req.user?.id || null, req.user?.username || null],
    }),
  });
});

// REQUESTED -> REJECTED (checker, WAJIB bukan requester)
router.post('/topup/:id/reject', requireFinance, (req, res) => {
  const reason = req.body?.reason ? String(req.body.reason).trim() : null;
  transitionTopup(req, res, {
    toStatus: 'REJECTED', action: 'REJECT',
    extraGuard: (current) => {
      if (isSelfApproval(current.requester_user_id, req.user?.id)) {
        return { code: 403, message: 'Requester tidak boleh menolak permintaannya sendiri (maker-checker).' };
      }
      if (!reason) return { code: 400, message: 'reason wajib diisi saat menolak.' };
      return null;
    },
    buildSetClause: () => ({
      setSql: `, approver_user_id = $1, approver_username = $2, rejected_at = NOW(), notes = $3`,
      setParams: [req.user?.id || null, req.user?.username || null, reason],
    }),
  });
});

// APPROVED -> TRANSFERRED (Finance eksekusi transfer manual, catat bukti)
router.post('/topup/:id/transfer', requireFinance, (req, res) => {
  const actualAmount = req.body?.actual_amount;
  const transferProofPath = req.body?.transfer_proof_path ? String(req.body.transfer_proof_path).trim() : null;
  transitionTopup(req, res, {
    toStatus: 'TRANSFERRED', action: 'TRANSFER',
    extraGuard: () => {
      if (actualAmount === undefined || actualAmount === null || actualAmount === '' || Number.isNaN(Number(actualAmount)) || Number(actualAmount) <= 0) {
        return { code: 400, message: 'actual_amount wajib diisi, angka > 0.' };
      }
      return null;
    },
    buildSetClause: () => ({
      setSql: `, actual_amount = $1, transfer_proof_path = $2, transferred_at = NOW()`,
      setParams: [actualAmount, transferProofPath],
    }),
  });
});

// TRANSFERRED -> BALANCE_CONFIRMED (Finance konfirmasi saldo baru sudah masuk)
router.post('/topup/:id/confirm-balance', requireFinance, (req, res) => {
  const balanceAfter = req.body?.balance_after;
  transitionTopup(req, res, {
    toStatus: 'BALANCE_CONFIRMED', action: 'CONFIRM_BALANCE',
    extraGuard: () => {
      if (balanceAfter === undefined || balanceAfter === null || balanceAfter === '' || Number.isNaN(Number(balanceAfter))) {
        return { code: 400, message: 'balance_after wajib diisi, angka.' };
      }
      return null;
    },
    buildSetClause: () => ({
      setSql: `, balance_after = $1, balance_confirmed_at = NOW()`,
      setParams: [balanceAfter],
    }),
  });
});

// BALANCE_CONFIRMED -> COMPLETED
router.post('/topup/:id/complete', requireFinance, (req, res) => {
  const notes = req.body?.notes ? String(req.body.notes).trim() : null;
  transitionTopup(req, res, {
    toStatus: 'COMPLETED', action: 'COMPLETE',
    buildSetClause: (current) => ({
      setSql: `, completed_at = NOW()${notes ? ', notes = $1' : ''}`,
      setParams: notes ? [notes] : [],
    }),
  });
});

// DRAFT/REQUESTED/APPROVED -> CANCELLED (requester asli atau admin)
router.post('/topup/:id/cancel', requireOpsOrFinance, (req, res) => {
  transitionTopup(req, res, {
    toStatus: 'CANCELLED', action: 'CANCEL',
    extraGuard: (current) => {
      if (!['DRAFT', 'REQUESTED', 'APPROVED'].includes(current.status)) {
        return { code: 409, message: `Tidak bisa membatalkan permintaan berstatus ${current.status}.` };
      }
      if (req.user?.role !== 'admin' && String(current.requester_user_id) !== String(req.user?.id)) {
        return { code: 403, message: 'Hanya pembuat permintaan atau admin yang bisa membatalkan.' };
      }
      return null;
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(String(req.query.status).toUpperCase());
      where.push(`a.status = $${params.length}`);
    }
    if (req.query.bank_account_id) {
      params.push(parseInt(req.query.bank_account_id, 10));
      where.push(`a.bank_account_id = $${params.length}`);
    }
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
    params.push(limit);

    const r = await pool.query(
      `SELECT a.*, b.bank_name, b.bank_code, b.account_number
       FROM bct_alerts a JOIN bct_bank_accounts b ON b.id = a.bank_account_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, alerts: r.rows });
  } catch (e) {
    console.error('balance-control-tower list alerts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function transitionAlert(req, res, { toStatus, action, buildSetClause, allowedFrom }) {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid.' });

    await client.query('BEGIN');
    const curRes = await client.query(`SELECT * FROM bct_alerts WHERE id = $1 FOR UPDATE`, [id]);
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Alert tidak ditemukan.' });
    }
    const current = curRes.rows[0];
    if (allowedFrom && !allowedFrom.includes(current.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Alert berstatus ${current.status} tidak bisa di-${action.toLowerCase()}.` });
    }

    const { setSql, setParams } = buildSetClause(current);
    const params = [...setParams, id];
    const r = await client.query(
      `UPDATE bct_alerts SET status = '${toStatus}', updated_at = NOW() ${setSql} WHERE id = $${params.length} RETURNING *`,
      params
    );

    await logAudit(client, {
      entityType: 'ALERT', entityId: id, action,
      actorUserId: req.user?.id, actorUsername: req.user?.username,
      before: current, after: r.rows[0],
    });
    await client.query('COMMIT');
    res.json({ success: true, alert: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`balance-control-tower alert ${action} error:`, e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

router.post('/alerts/:id/acknowledge', requireOpsOrFinance, (req, res) => {
  transitionAlert(req, res, {
    toStatus: 'ACKNOWLEDGED', action: 'ACKNOWLEDGE', allowedFrom: ['OPEN'],
    buildSetClause: () => ({
      setSql: `, acknowledged_by = $1, acknowledged_at = NOW(), owner = COALESCE(owner, $1)`,
      setParams: [req.user?.username || null],
    }),
  });
});

router.post('/alerts/:id/snooze', requireOpsOrFinance, (req, res) => {
  const until = req.body?.snoozed_until;
  if (!until || Number.isNaN(new Date(until).getTime())) {
    return res.status(400).json({ error: 'snoozed_until wajib diisi, format tanggal valid.' });
  }
  transitionAlert(req, res, {
    toStatus: 'ACKNOWLEDGED', action: 'SNOOZE', allowedFrom: ['OPEN', 'ACKNOWLEDGED'],
    buildSetClause: () => ({
      setSql: `, snoozed_until = $1, acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, NOW())`,
      setParams: [until, req.user?.username || null],
    }),
  });
});

router.post('/alerts/:id/resolve', requireOpsOrFinance, (req, res) => {
  const reason = req.body?.reason ? String(req.body.reason).trim() : null;
  transitionAlert(req, res, {
    toStatus: 'RESOLVED', action: 'RESOLVE', allowedFrom: ['OPEN', 'ACKNOWLEDGED'],
    buildSetClause: () => ({
      setSql: `, resolved_by = $1, resolved_at = NOW(), reason = $2`,
      setParams: [req.user?.username || null, reason],
    }),
  });
});

module.exports = router;
