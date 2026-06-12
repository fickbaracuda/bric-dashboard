const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

function n(v) {
  if (v === null || v === undefined || v === '') return 0;
  const num = Number(v);
  return isNaN(num) ? 0 : num;
}

async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { tanggal, data } = req.body;
  if (!tanggal || !data) return res.status(400).json({ error: 'tanggal and data required' });

  try {
    await pool.query(`
      INSERT INTO dm_fastpay_snapshot (
        tanggal,
        reg_apr, reg_mei, reg_jun,
        akt_apr, akt_mei, akt_jun,
        nmat_apr, nmat_mei, nmat_jun,
        rev_akt_apr, rev_akt_mei, rev_akt_jun,
        trx_apr, trx_mei, trx_jun,
        rev_trx_apr, rev_trx_mei, rev_trx_jun,
        budget_ads_apr, budget_ads_mei, budget_ads_jun,
        nmat_jawa_apr, nmat_jawa_mei, nmat_jawa_jun,
        retargeting_apr, retargeting_mei, retargeting_jun,
        brand_exp_apr, brand_exp_mei, brand_exp_jun,
        synced_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,
        NOW()
      )
      ON CONFLICT (tanggal) DO UPDATE SET
        reg_apr=EXCLUDED.reg_apr, reg_mei=EXCLUDED.reg_mei, reg_jun=EXCLUDED.reg_jun,
        akt_apr=EXCLUDED.akt_apr, akt_mei=EXCLUDED.akt_mei, akt_jun=EXCLUDED.akt_jun,
        nmat_apr=EXCLUDED.nmat_apr, nmat_mei=EXCLUDED.nmat_mei, nmat_jun=EXCLUDED.nmat_jun,
        rev_akt_apr=EXCLUDED.rev_akt_apr, rev_akt_mei=EXCLUDED.rev_akt_mei, rev_akt_jun=EXCLUDED.rev_akt_jun,
        trx_apr=EXCLUDED.trx_apr, trx_mei=EXCLUDED.trx_mei, trx_jun=EXCLUDED.trx_jun,
        rev_trx_apr=EXCLUDED.rev_trx_apr, rev_trx_mei=EXCLUDED.rev_trx_mei, rev_trx_jun=EXCLUDED.rev_trx_jun,
        budget_ads_apr=EXCLUDED.budget_ads_apr, budget_ads_mei=EXCLUDED.budget_ads_mei, budget_ads_jun=EXCLUDED.budget_ads_jun,
        nmat_jawa_apr=EXCLUDED.nmat_jawa_apr, nmat_jawa_mei=EXCLUDED.nmat_jawa_mei, nmat_jawa_jun=EXCLUDED.nmat_jawa_jun,
        retargeting_apr=EXCLUDED.retargeting_apr, retargeting_mei=EXCLUDED.retargeting_mei, retargeting_jun=EXCLUDED.retargeting_jun,
        brand_exp_apr=EXCLUDED.brand_exp_apr, brand_exp_mei=EXCLUDED.brand_exp_mei, brand_exp_jun=EXCLUDED.brand_exp_jun,
        synced_at=NOW()
    `, [
      tanggal,
      n(data.reg_apr),  n(data.reg_mei),  n(data.reg_jun),
      n(data.akt_apr),  n(data.akt_mei),  n(data.akt_jun),
      n(data.nmat_apr), n(data.nmat_mei), n(data.nmat_jun),
      n(data.rev_akt_apr), n(data.rev_akt_mei), n(data.rev_akt_jun),
      n(data.trx_apr),  n(data.trx_mei),  n(data.trx_jun),
      n(data.rev_trx_apr), n(data.rev_trx_mei), n(data.rev_trx_jun),
      n(data.budget_ads_apr), n(data.budget_ads_mei), n(data.budget_ads_jun),
      n(data.nmat_jawa_apr), n(data.nmat_jawa_mei), n(data.nmat_jawa_jun),
      n(data.retargeting_apr), n(data.retargeting_mei), n(data.retargeting_jun),
      n(data.brand_exp_apr), n(data.brand_exp_mei), n(data.brand_exp_jun),
    ]);

    res.json({ ok: true, tanggal });
  } catch (err) {
    console.error('DM Fastpay sync error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function analyticsHandler(req, res) {
  try {
    const { tanggal } = req.query;
    let tgl = tanggal;

    if (!tgl) {
      const r = await pool.query('SELECT MAX(tanggal) AS t FROM dm_fastpay_snapshot');
      tgl = r.rows[0]?.t;
    }
    if (!tgl) return res.json({ tanggal: null, data: null, tanggal_list: [] });

    const [dataRes, listRes] = await Promise.all([
      pool.query('SELECT * FROM dm_fastpay_snapshot WHERE tanggal = $1', [tgl]),
      pool.query('SELECT DISTINCT tanggal FROM dm_fastpay_snapshot ORDER BY tanggal DESC LIMIT 60'),
    ]);

    res.json({
      tanggal: tgl,
      data: dataRes.rows[0] || null,
      tanggal_list: listRes.rows.map(r => r.tanggal),
    });
  } catch (err) {
    console.error('DM Fastpay analytics error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler };
