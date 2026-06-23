const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

// ── Sync handler (token auth, no JWT) ─────────────────────────────────────
async function outletSyncHandler(req, res) {
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
    await client.query('DELETE FROM iq_raw_outlet WHERE bulan=$1', [bulan]);
    await client.query(
      `INSERT INTO iq_raw_outlet (bulan, sheet_name, row_data)
       SELECT $1, $2, value
       FROM jsonb_array_elements($3::jsonb)`,
      [bulan, sheet_name || bulan, JSON.stringify(rows)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, bulan, sheet_name: sheet_name || bulan, rows_inserted: rows.length, duration_ms: Date.now() - t0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[data-raw outlet sync]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

// GET /outlet — list data dengan filter bulan + search + pagination
router.get('/outlet', async (req, res) => {
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
        `SELECT id, bulan, sheet_name, row_data
         FROM iq_raw_outlet ${where}
         ORDER BY bulan DESC, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) AS total FROM iq_raw_outlet ${where}`, params),
      pool.query(`SELECT bulan, sheet_name, COUNT(*) AS row_count
                  FROM iq_raw_outlet GROUP BY bulan, sheet_name ORDER BY bulan DESC`),
    ]);

    // Ambil semua kunci kolom dari baris pertama bulan terpilih (atau global)
    let columns = [];
    if (dataRes.rows.length > 0) {
      columns = Object.keys(dataRes.rows[0].row_data || {});
    }

    res.json({
      rows:       dataRes.rows.map(r => r.row_data),
      total:      parseInt(countRes.rows[0].total),
      page:       parseInt(page),
      per_page:   limit,
      columns,
      bulan_list: bulanRes.rows,
    });
  } catch (e) {
    console.error('[data-raw outlet]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /outlet/stats — ringkasan per bulan
router.get('/outlet/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bulan, sheet_name, COUNT(*) AS total_rows,
              MAX(synced_at) AS last_synced
       FROM iq_raw_outlet
       GROUP BY bulan, sheet_name
       ORDER BY bulan DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.outletSyncHandler = outletSyncHandler;
