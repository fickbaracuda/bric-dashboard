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
    let { tanggal } = req.query;
    if (!tanggal) {
      const r = await pool.query('SELECT MAX(tanggal) as t FROM speedcash_snapshot');
      tanggal = r.rows[0]?.t;
    }
    if (!tanggal) return res.json({ tanggal: null, rows: [], summary: {}, top_margin: [], top_growth: [], outlet_masalah: [], anomali: [], tabel: [] });

    const { rows } = await pool.query(
      'SELECT * FROM speedcash_snapshot WHERE tanggal=$1 ORDER BY margin_jun DESC NULLS LAST',
      [tanggal]
    );

    const anomaliSet = new Set(
      rows.filter(r => Number(r.dev_trx) > 0 && Number(r.dev_margin) < 0).map(r => r.id_outlet)
    );

    const oneMonthAgo = new Date(tanggal);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const outletBaruSet = new Set(
      rows.filter(r => r.tgl_reg && new Date(r.tgl_reg) >= oneMonthAgo).map(r => r.id_outlet)
    );

    const totalMarginJun = rows.reduce((s, r) => s + Number(r.margin_jun || 0), 0);
    const totalMarginMei = rows.reduce((s, r) => s + Number(r.margin_mei || 0), 0);

    const summary = {
      total_outlet   : rows.length,
      total_trx_jun  : rows.reduce((s, r) => s + Number(r.trx_jun  || 0), 0),
      total_trx_mei  : rows.reduce((s, r) => s + Number(r.trx_mei  || 0), 0),
      total_margin_jun: totalMarginJun,
      total_margin_mei: totalMarginMei,
      dev_margin     : totalMarginJun - totalMarginMei,
      outlet_tumbuh  : rows.filter(r => Number(r.dev_margin) > 0).length,
      outlet_turun   : rows.filter(r => Number(r.dev_margin) < 0).length,
      outlet_baru    : outletBaruSet.size,
      outlet_anomali : anomaliSet.size,
    };

    const withFlags = rows.map(r => ({
      ...r,
      is_anomali    : anomaliSet.has(r.id_outlet),
      is_outlet_baru: outletBaruSet.has(r.id_outlet),
    }));

    const top_margin    = [...rows].sort((a,b) => Number(b.margin_jun) - Number(a.margin_jun)).slice(0, 10);
    const top_growth    = [...withFlags].filter(r => Number(r.dev_margin) > 0)
                                        .sort((a,b) => Number(b.dev_margin) - Number(a.dev_margin)).slice(0, 10);
    const outlet_masalah = [...withFlags].filter(r => Number(r.dev_margin) < 0)
                                         .sort((a,b) => Number(a.dev_margin) - Number(b.dev_margin));
    const anomali       = withFlags.filter(r => r.is_anomali);

    res.json({ tanggal, summary, top_margin, top_growth, outlet_masalah, anomali, tabel: withFlags });
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
