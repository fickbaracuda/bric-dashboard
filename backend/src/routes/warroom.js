const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const SECRET_TOKEN = 'bric2026bimasaktisecret';

/* ── Sync handler (no JWT, uses own token) — export untuk app.js ── */
async function syncHandler(req, res) {
  const { token, tanggal, synced_at, rows } = req.body;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

  let count = 0;
  for (const r of rows) {
    // skip baris total/summary: mcc kosong, bukan 4-digit angka, atau label "total/subtotal"
    const mccStr = String(r.mcc || '').trim();
    if (!mccStr || /total/i.test(mccStr) || /total/i.test(String(r.kategori || '')) || !/^\d+$/.test(mccStr)) continue;
    await pool.query(`
      INSERT INTO segmen_snapshot
        (tanggal,mcc,kategori,
         apr_merchant,apr_trx,apr_rev,
         mei_merchant,mei_trx,mei_rev,
         jun_merchant,jun_trx,jun_rev,
         dev_apr_jun_merchant,dev_apr_jun_trx,dev_apr_jun_rev,
         dev_mei_jun_merchant,dev_mei_jun_trx,dev_mei_jun_rev,synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (tanggal,mcc) DO UPDATE SET
        kategori=EXCLUDED.kategori,
        apr_merchant=EXCLUDED.apr_merchant, apr_trx=EXCLUDED.apr_trx, apr_rev=EXCLUDED.apr_rev,
        mei_merchant=EXCLUDED.mei_merchant, mei_trx=EXCLUDED.mei_trx, mei_rev=EXCLUDED.mei_rev,
        jun_merchant=EXCLUDED.jun_merchant, jun_trx=EXCLUDED.jun_trx, jun_rev=EXCLUDED.jun_rev,
        dev_apr_jun_merchant=EXCLUDED.dev_apr_jun_merchant,
        dev_apr_jun_trx=EXCLUDED.dev_apr_jun_trx,
        dev_apr_jun_rev=EXCLUDED.dev_apr_jun_rev,
        dev_mei_jun_merchant=EXCLUDED.dev_mei_jun_merchant,
        dev_mei_jun_trx=EXCLUDED.dev_mei_jun_trx,
        dev_mei_jun_rev=EXCLUDED.dev_mei_jun_rev,
        synced_at=EXCLUDED.synced_at
    `, [tanggal, r.mcc, r.kategori,
        r.apr_merchant, r.apr_trx, r.apr_rev,
        r.mei_merchant, r.mei_trx, r.mei_rev,
        r.jun_merchant, r.jun_trx, r.jun_rev,
        r.dev_apr_jun_merchant, r.dev_apr_jun_trx, r.dev_apr_jun_rev,
        r.dev_mei_jun_merchant, r.dev_mei_jun_trx, r.dev_mei_jun_rev,
        synced_at]);
    count++;
  }
  res.json({ success: true, rows: count, tanggal });
}

router.post('/segmen/sync', syncHandler);

/* ── GET /api/warroom/segmen ── */
router.get('/segmen', async (req, res) => {
  try {
    let { tanggal } = req.query;
    if (!tanggal) {
      const r = await pool.query('SELECT MAX(tanggal) as t FROM segmen_snapshot');
      tanggal = r.rows[0]?.t;
    }
    if (!tanggal) return res.json({ tanggal: null, rows: [], summary: {}, top_rev: [], top_growth: [], segmen_masalah: [], anomali: [], tabel: [] });

    const { rows } = await pool.query(
      'SELECT * FROM segmen_snapshot WHERE tanggal=$1 ORDER BY jun_rev DESC NULLS LAST',
      [tanggal]
    );

    const anomaliSet = new Set(
      rows.filter(r => Number(r.dev_mei_jun_merchant) > 0 && Number(r.dev_mei_jun_rev) < 0).map(r => r.mcc)
    );

    const totalRev    = rows.reduce((s, r) => s + Number(r.jun_rev    || 0), 0);
    const totalRevMei = rows.reduce((s, r) => s + Number(r.mei_rev    || 0), 0);
    const summary = {
      total_merchant : rows.reduce((s, r) => s + Number(r.jun_merchant || 0), 0),
      total_trx      : rows.reduce((s, r) => s + Number(r.jun_trx      || 0), 0),
      total_rev      : totalRev,
      total_rev_mei  : totalRevMei,
      dev_rev_mei_jun: totalRev - totalRevMei,
      segmen_aktif   : rows.length,
      segmen_tumbuh  : rows.filter(r => Number(r.dev_mei_jun_rev) > 0).length,
      segmen_turun   : rows.filter(r => Number(r.dev_mei_jun_rev) < 0).length,
    };

    const withAnomali = rows.map(r => ({ ...r, is_anomali: anomaliSet.has(r.mcc) }));
    const top_rev       = [...rows].sort((a,b) => Number(b.jun_rev) - Number(a.jun_rev)).slice(0, 10);
    const top_growth    = [...rows].filter(r => Number(r.dev_mei_jun_rev) > 0)
                                   .sort((a,b) => Number(b.dev_mei_jun_rev) - Number(a.dev_mei_jun_rev)).slice(0, 10);
    const segmen_masalah = withAnomali.filter(r => Number(r.dev_mei_jun_rev) < 0)
                                      .sort((a,b) => Number(a.dev_mei_jun_rev) - Number(b.dev_mei_jun_rev));
    const anomali       = withAnomali.filter(r => r.is_anomali);

    res.json({ tanggal, summary, top_rev, top_growth, segmen_masalah, anomali, tabel: withAnomali });
  } catch (e) {
    console.error('warroom segmen error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/warroom/segmen/history?mcc=xxx&days=30 ── */
router.get('/segmen/history', async (req, res) => {
  try {
    const { mcc, days = 30 } = req.query;
    if (!mcc) return res.status(400).json({ error: 'mcc required' });
    const { rows } = await pool.query(
      `SELECT tanggal, jun_rev, jun_merchant, jun_trx, dev_mei_jun_rev
       FROM segmen_snapshot WHERE mcc=$1
       ORDER BY tanggal DESC LIMIT $2`,
      [mcc, parseInt(days)]
    );
    res.json({ mcc, rows: rows.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/warroom/segmen/tanggal-list ── */
router.get('/segmen/tanggal-list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT tanggal FROM segmen_snapshot ORDER BY tanggal DESC LIMIT 90'
    );
    res.json({ list: rows.map(r => r.tanggal) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─── SPEEDCASH ─────────────────────────────────────────────────────── */

async function speedcashSyncHandler(req, res) {
  const { token, tanggal, synced_at, rows } = req.body;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

  let count = 0;
  for (const r of rows) {
    await pool.query(`
      INSERT INTO speedcash_snapshot
        (tanggal, id_outlet, tgl_reg, trx_mei, margin_mei,
         trx_jun, margin_jun, dev_trx, dev_margin, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
        tgl_reg    = EXCLUDED.tgl_reg,
        trx_mei    = EXCLUDED.trx_mei,
        margin_mei = EXCLUDED.margin_mei,
        trx_jun    = EXCLUDED.trx_jun,
        margin_jun = EXCLUDED.margin_jun,
        dev_trx    = EXCLUDED.dev_trx,
        dev_margin = EXCLUDED.dev_margin,
        synced_at  = EXCLUDED.synced_at
    `, [tanggal, r.id_outlet, r.tgl_reg || null,
        r.trx_mei, r.margin_mei,
        r.trx_jun, r.margin_jun,
        r.dev_trx, r.dev_margin,
        synced_at]);
    count++;
  }
  res.json({ success: true, rows: count, tanggal });
}

router.post('/speedcash/sync', speedcashSyncHandler);

/* ── GET /api/warroom/speedcash ── */
router.get('/speedcash', async (req, res) => {
  try {
    let { tanggal, filter = 'semua', sort = 'margin' } = req.query;
    if (!tanggal) {
      const r = await pool.query('SELECT MAX(tanggal) as t FROM speedcash_snapshot');
      tanggal = r.rows[0]?.t;
    }
    if (!tanggal) return res.json({ tanggal: null, summary: {}, top_margin: [], top_growth: [], outlet_masalah: [], anomali: [], tabel: [], tabel_total: 0 });

    const FLAGS = `
      (tgl_reg IS NOT NULL AND tgl_reg >= $1::date - INTERVAL '1 month') AS is_outlet_baru,
      (dev_trx > 0 AND dev_margin < 0) AS is_anomali
    `;

    // Semua query paralel — jauh lebih cepat dari fetch 40k baris sekaligus
    const [sumRes, topMRes, topGRes, masalahRes, anomaliRes] = await Promise.all([
      // 1. Summary via SQL aggregation
      pool.query(`
        SELECT
          COUNT(*)                                                        AS total_outlet,
          COALESCE(SUM(trx_jun),    0)                                   AS total_trx_jun,
          COALESCE(SUM(trx_mei),    0)                                   AS total_trx_mei,
          COALESCE(SUM(margin_jun), 0)                                   AS total_margin_jun,
          COALESCE(SUM(margin_mei), 0)                                   AS total_margin_mei,
          COUNT(*) FILTER (WHERE dev_margin > 0)                         AS outlet_tumbuh,
          COUNT(*) FILTER (WHERE dev_margin < 0)                         AS outlet_turun,
          COUNT(*) FILTER (WHERE dev_trx > 0 AND dev_margin < 0)        AS outlet_anomali,
          COUNT(*) FILTER (WHERE tgl_reg >= $1::date - INTERVAL '1 month') AS outlet_baru
        FROM speedcash_snapshot WHERE tanggal = $1`, [tanggal]),
      // 2. Top 10 margin
      pool.query(`SELECT *, ${FLAGS} FROM speedcash_snapshot WHERE tanggal=$1 ORDER BY margin_jun DESC NULLS LAST LIMIT 10`, [tanggal]),
      // 3. Top 10 growth
      pool.query(`SELECT *, ${FLAGS} FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin > 0 ORDER BY dev_margin DESC NULLS LAST LIMIT 10`, [tanggal]),
      // 4. Outlet masalah (semua turun, diurutkan terburuk dulu)
      pool.query(`SELECT *, ${FLAGS} FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin < 0 ORDER BY dev_margin ASC NULLS LAST`, [tanggal]),
      // 5. Anomali
      pool.query(`SELECT *, ${FLAGS} FROM speedcash_snapshot WHERE tanggal=$1 AND dev_trx > 0 AND dev_margin < 0`, [tanggal]),
    ]);

    const s = sumRes.rows[0];
    const summary = {
      total_outlet    : Number(s.total_outlet),
      total_trx_jun   : Number(s.total_trx_jun),
      total_trx_mei   : Number(s.total_trx_mei),
      total_margin_jun: Number(s.total_margin_jun),
      total_margin_mei: Number(s.total_margin_mei),
      dev_margin      : Number(s.total_margin_jun) - Number(s.total_margin_mei),
      outlet_tumbuh   : Number(s.outlet_tumbuh),
      outlet_turun    : Number(s.outlet_turun),
      outlet_baru     : Number(s.outlet_baru),
      outlet_anomali  : Number(s.outlet_anomali),
    };

    // Tabel: server-side filter + sort, max 500 baris
    const sortCol = { margin: 'margin_jun', dev_margin: 'dev_margin', trx: 'trx_jun', dev_trx: 'dev_trx' }[sort] || 'margin_jun';
    const filterMap = {
      tumbuh : 'AND dev_margin > 0',
      turun  : 'AND dev_margin < 0',
      anomali: 'AND dev_trx > 0 AND dev_margin < 0',
      baru   : "AND tgl_reg IS NOT NULL AND tgl_reg >= $1::date - INTERVAL '1 month'",
    };
    const filterWhere = filterMap[filter] || '';
    const tabelLimit  = filter === 'top10' ? 10 : 500;

    const tabelRes = await pool.query(
      `SELECT *, ${FLAGS} FROM speedcash_snapshot
       WHERE tanggal = $1 ${filterWhere}
       ORDER BY ${sortCol} DESC NULLS LAST LIMIT ${tabelLimit}`,
      [tanggal]
    );

    res.json({
      tanggal,
      summary,
      top_margin    : topMRes.rows,
      top_growth    : topGRes.rows,
      outlet_masalah: masalahRes.rows,
      anomali       : anomaliRes.rows,
      tabel         : tabelRes.rows,
      tabel_total   : Number(s.total_outlet),
    });
  } catch (e) {
    console.error('warroom speedcash error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/warroom/speedcash/history?id_outlet=xxx&days=30 ── */
router.get('/speedcash/history', async (req, res) => {
  try {
    const { id_outlet, days = 30 } = req.query;
    if (!id_outlet) return res.status(400).json({ error: 'id_outlet required' });
    const { rows } = await pool.query(
      `SELECT tanggal, margin_jun, trx_jun, dev_margin, dev_trx
       FROM speedcash_snapshot WHERE id_outlet=$1
       ORDER BY tanggal DESC LIMIT $2`,
      [id_outlet, parseInt(days)]
    );
    res.json({ id_outlet, rows: rows.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/warroom/speedcash/tanggal-list ── */
router.get('/speedcash/tanggal-list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT tanggal FROM speedcash_snapshot ORDER BY tanggal DESC LIMIT 90'
    );
    res.json({ list: rows.map(r => r.tanggal) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.syncHandler          = syncHandler;
module.exports.speedcashSyncHandler = speedcashSyncHandler;
