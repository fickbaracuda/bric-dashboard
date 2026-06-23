const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

// Whitelist tabel — mencegah SQL injection pada nama tabel
const TABLES = {
  outlet:    'iq_raw_outlet',
  affiliate: 'iq_raw_affiliate',
  qris:      'iq_raw_qris',
  trx:       'iq_raw_trx',
};

// ── Factory: sync handler (token auth, no JWT) ───────────────────────────
function makeSyncHandler(table) {
  return async function (req, res) {
    const token = req.headers['x-sync-token'] || req.body?.token;
    if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { bulan, sheet_name, rows } = req.body;
    if (!bulan || !Array.isArray(rows))
      return res.status(400).json({ error: 'bulan (YYYY-MM) dan rows[] wajib ada' });
    if (rows.length === 0)
      return res.json({ ok: true, bulan, rows_inserted: 0 });

    const t0 = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${table} WHERE bulan=$1`, [bulan]);
      await client.query(
        `INSERT INTO ${table} (bulan, sheet_name, row_data)
         SELECT $1, $2, value FROM jsonb_array_elements($3::jsonb)`,
        [bulan, sheet_name || bulan, JSON.stringify(rows)]
      );
      await client.query('COMMIT');
      res.json({
        ok: true, bulan,
        sheet_name: sheet_name || bulan,
        rows_inserted: rows.length,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[data-raw ${table} sync]`, e.message);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  };
}

// ── Factory: list handler (requireAuth via router) ───────────────────────
function makeListHandler(table) {
  return async function (req, res) {
    const { bulan, q, page = 1, per_page = 200 } = req.query;
    const limit  = Math.min(parseInt(per_page) || 200, 500);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const params = [];
    const conditions = [];
    if (bulan) { params.push(bulan); conditions.push(`bulan=$${params.length}`); }
    if (q)     { params.push(`%${q.toUpperCase()}%`); conditions.push(`UPPER(row_data::text) LIKE $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    try {
      const [dataRes, countRes, bulanRes] = await Promise.all([
        pool.query(
          `SELECT row_data FROM ${table} ${where} ORDER BY bulan DESC, id
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`, params),
        pool.query(
          `SELECT bulan, sheet_name, COUNT(*) AS row_count, MAX(synced_at) AS last_synced
           FROM ${table} GROUP BY bulan, sheet_name ORDER BY bulan DESC`
        ),
      ]);

      let columns = [];
      if (dataRes.rows.length > 0) columns = Object.keys(dataRes.rows[0].row_data || {});

      res.json({
        rows:       dataRes.rows.map(r => r.row_data),
        total:      parseInt(countRes.rows[0].total),
        page:       parseInt(page),
        per_page:   limit,
        columns,
        bulan_list: bulanRes.rows,
      });
    } catch (e) {
      console.error(`[data-raw ${table} list]`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// ── GET routes ────────────────────────────────────────────────────────────
router.get('/outlet',    makeListHandler(TABLES.outlet));
router.get('/affiliate', makeListHandler(TABLES.affiliate));
router.get('/qris',      makeListHandler(TABLES.qris));
router.get('/trx',       makeListHandler(TABLES.trx));

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = router;
module.exports.outletSyncHandler    = makeSyncHandler(TABLES.outlet);
module.exports.affiliateSyncHandler = makeSyncHandler(TABLES.affiliate);
module.exports.qrisSyncHandler      = makeSyncHandler(TABLES.qris);
module.exports.trxSyncHandler       = makeSyncHandler(TABLES.trx);
