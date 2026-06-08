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
    // skip baris total/summary (mcc kosong atau kategori mengandung kata "total")
    if (!r.mcc || String(r.mcc).trim() === '' || /total/i.test(String(r.kategori || ''))) continue;
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

module.exports = router;
module.exports.syncHandler = syncHandler;
