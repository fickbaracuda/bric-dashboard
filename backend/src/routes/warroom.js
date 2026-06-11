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

/* ── GET /api/warroom/segmen/trendline?days=30 ── */
router.get('/segmen/trendline', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 3), 90);
    const latestRes = await pool.query('SELECT MAX(tanggal) AS t FROM segmen_snapshot');
    const latest = latestRes.rows[0]?.t;
    if (!latest) return res.json({ dates: [], byMcc: {}, segments: [], days });

    const { rows } = await pool.query(`
      SELECT tanggal, mcc, kategori, jun_rev, jun_merchant, jun_trx
      FROM segmen_snapshot
      WHERE tanggal >= $1::date - ($2 * interval '1 day')
      ORDER BY tanggal ASC, jun_rev DESC NULLS LAST
    `, [latest, days]);

    const byMcc   = {};
    const segInfo = {};
    for (const r of rows) {
      if (!byMcc[r.mcc]) { byMcc[r.mcc] = []; segInfo[r.mcc] = r.kategori; }
      byMcc[r.mcc].push({
        tanggal:      String(r.tanggal).substring(0, 10),
        jun_rev:      Number(r.jun_rev)      || 0,
        jun_merchant: Number(r.jun_merchant) || 0,
        jun_trx:      Number(r.jun_trx)      || 0,
      });
    }

    const dates = [...new Set(rows.map(r => String(r.tanggal).substring(0, 10)))].sort();
    const segments = Object.entries(byMcc)
      .map(([mcc]) => ({ mcc, kategori: segInfo[mcc], latestRev: byMcc[mcc][byMcc[mcc].length - 1]?.jun_rev || 0 }))
      .sort((a, b) => b.latestRev - a.latestRev);

    res.json({ dates, byMcc, segments, days });
  } catch (e) {
    console.error('segmen trendline error:', e.message);
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

/* ── GET /api/warroom/speedcash/analytics ── */
router.get('/speedcash/analytics', async (req, res) => {
  try {
    let { tanggal } = req.query;
    if (!tanggal) {
      const r = await pool.query('SELECT MAX(tanggal) as t FROM speedcash_snapshot');
      tanggal = r.rows[0]?.t;
    }
    if (!tanggal) return res.json({ tanggal: null, summary: {}, growth_counts: {}, segment_counts: {} });

    // Step 1: Compute percentile thresholds from active outlets
    const { rows: [th] } = await pool.query(`
      SELECT
        COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY trx_jun),    0) AS trx_p75,
        COALESCE(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY trx_jun),    0) AS trx_p25,
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY trx_jun),    0) AS trx_p50,
        COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY margin_jun), 0) AS margin_p75,
        COALESCE(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY margin_jun), 0) AS margin_p25
      FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun > 0
    `, [tanggal]);

    const p = {
      trxP75: Number(th.trx_p75), trxP25: Number(th.trx_p25), trxP50: Number(th.trx_p50),
      marginP75: Number(th.margin_p75), marginP25: Number(th.margin_p25),
    };

    // Guard: if no active data, return empty
    if (!p.trxP75) return res.json({ tanggal, summary: {}, growth_counts: {}, segment_counts: {}, thresholds: p });

    const segSQL = `CASE
      WHEN trx_jun = 0                                                                    THEN 'inactive'
      WHEN trx_jun >= ${p.trxP75} AND margin_jun >= ${p.marginP75}                       THEN 'superstar'
      WHEN (trx_mei = 0 OR trx_mei < ${p.trxP25}) AND trx_jun > ${p.trxP50} AND dev_margin > 0 THEN 'rising_star'
      WHEN trx_mei >= ${p.trxP75} AND trx_jun < trx_mei * 0.75                           THEN 'at_risk'
      WHEN trx_jun >= ${p.trxP75} AND margin_jun < ${p.marginP25}                        THEN 'high_trx_low_margin'
      WHEN trx_jun < ${p.trxP25}  AND margin_jun >= ${p.marginP75}                       THEN 'low_trx_high_margin'
      ELSE 'low_value' END AS segment`;

    const growSQL = `CASE
      WHEN trx_mei = 0 AND trx_jun = 0 THEN 'inactive'
      WHEN trx_mei = 0 AND trx_jun > 0 THEN 'new_active'
      WHEN trx_mei > 0 AND trx_jun = 0 THEN 'churned'
      WHEN trx_jun > trx_mei           THEN 'growing'
      WHEN trx_jun < trx_mei           THEN 'declining'
      ELSE 'stable' END AS growth_status`;

    const marginStatusSQL = `CASE
      WHEN margin_mei = 0 AND margin_jun > 0        THEN 'new_margin_source'
      WHEN dev_margin > 0 AND margin_jun >= ${p.marginP75} THEN 'margin_hero'
      WHEN dev_margin < 0                           THEN 'margin_drop'
      WHEN trx_jun >= ${p.trxP75} AND margin_jun < ${p.marginP25} THEN 'volume_no_margin'
      ELSE 'normal' END AS margin_status`;

    const [
      summaryRes,
      growthCountRes,
      top10TrxRes, top10MarginRes,
      top20DTPos, top20DTNeg,
      top20DMPos, top20DMNeg,
      growthTableRes,
      segCountRes, scatterRes,
      top20MarginRes, top20DMRes, bot20DMRes,
      cohortYearRes, cohortMonthRes,
      actDropRes, actGrowthRes, actHighTrxRes, actRisingRes,
    ] = await Promise.all([
      // 1. Summary
      pool.query(`
        SELECT
          COUNT(*)                                                             AS total_outlet,
          SUM(CASE WHEN trx_jun > 0 THEN 1 ELSE 0 END)                       AS total_aktif_jun,
          COALESCE(SUM(trx_jun),    0)                                        AS total_trx_jun,
          COALESCE(SUM(trx_mei),    0)                                        AS total_trx_mei,
          COALESCE(SUM(margin_jun), 0)                                        AS total_margin_jun,
          COALESCE(SUM(margin_mei), 0)                                        AS total_margin_mei,
          COUNT(*) FILTER (WHERE trx_jun > trx_mei)                          AS outlet_growing,
          COUNT(*) FILTER (WHERE trx_jun < trx_mei AND trx_jun > 0)          AS outlet_declining,
          COUNT(*) FILTER (WHERE trx_mei > 0 AND trx_jun = 0)                AS outlet_churn,
          COUNT(*) FILTER (WHERE trx_mei = 0 AND trx_jun > 0)                AS outlet_new_active,
          COUNT(*) FILTER (WHERE trx_jun = trx_mei AND trx_jun > 0)          AS outlet_stable,
          COUNT(*) FILTER (WHERE tgl_reg >= $1::date - INTERVAL '1 month')   AS outlet_baru
        FROM speedcash_snapshot WHERE tanggal=$1`, [tanggal]),
      // 2. Growth counts
      pool.query(`SELECT ${growSQL}, COUNT(*) AS cnt FROM speedcash_snapshot WHERE tanggal=$1 GROUP BY 1`, [tanggal]),
      // 3. Top 10 TRX Jun
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin FROM speedcash_snapshot WHERE tanggal=$1 ORDER BY trx_jun DESC NULLS LAST LIMIT 10`, [tanggal]),
      // 4. Top 10 Margin Jun
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin FROM speedcash_snapshot WHERE tanggal=$1 ORDER BY margin_jun DESC NULLS LAST LIMIT 10`, [tanggal]),
      // 5. Top 20 DEV TRX positive
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,dev_trx,dev_margin FROM speedcash_snapshot WHERE tanggal=$1 AND dev_trx > 0 ORDER BY dev_trx DESC LIMIT 20`, [tanggal]),
      // 6. Top 20 DEV TRX negative
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,dev_trx,dev_margin FROM speedcash_snapshot WHERE tanggal=$1 AND dev_trx < 0 ORDER BY dev_trx ASC LIMIT 20`, [tanggal]),
      // 7. Top 20 DEV Margin positive
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,dev_trx,dev_margin,margin_mei,margin_jun FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin > 0 ORDER BY dev_margin DESC LIMIT 20`, [tanggal]),
      // 8. Top 20 DEV Margin negative
      pool.query(`SELECT id_outlet,trx_mei,trx_jun,dev_trx,dev_margin,margin_mei,margin_jun FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin < 0 ORDER BY dev_margin ASC LIMIT 20`, [tanggal]),
      // 9. Growth table (union of categories)
      pool.query(`
        (SELECT id_outlet,tgl_reg,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin,'growing'    AS growth_status FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun > trx_mei ORDER BY dev_trx DESC LIMIT 150)
        UNION ALL
        (SELECT id_outlet,tgl_reg,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin,'declining'  AS growth_status FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun < trx_mei AND trx_jun > 0 ORDER BY dev_trx ASC LIMIT 150)
        UNION ALL
        (SELECT id_outlet,tgl_reg,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin,'churned'    AS growth_status FROM speedcash_snapshot WHERE tanggal=$1 AND trx_mei > 0 AND trx_jun = 0 ORDER BY trx_mei DESC LIMIT 300)
        UNION ALL
        (SELECT id_outlet,tgl_reg,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin,'new_active' AS growth_status FROM speedcash_snapshot WHERE tanggal=$1 AND trx_mei = 0 AND trx_jun > 0 ORDER BY trx_jun DESC LIMIT 300)
        UNION ALL
        (SELECT id_outlet,tgl_reg,trx_mei,trx_jun,margin_mei,margin_jun,dev_trx,dev_margin,'stable'     AS growth_status FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun = trx_mei AND trx_jun > 0 LIMIT 50)
      `, [tanggal]),
      // 10. Segment counts
      pool.query(`SELECT ${segSQL}, COUNT(*) AS cnt FROM speedcash_snapshot WHERE tanggal=$1 GROUP BY 1`, [tanggal]),
      // 11. Scatter data (active outlets, up to 4000)
      pool.query(`SELECT id_outlet, trx_jun, margin_jun, dev_trx, dev_margin, ${segSQL},
        CASE WHEN trx_jun > 0 THEN margin_jun/trx_jun ELSE 0 END AS avg_margin_per_trx
        FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun > 0 ORDER BY trx_jun DESC LIMIT 4000`, [tanggal]),
      // 12. Top 20 Margin Jun (margin analysis)
      pool.query(`SELECT id_outlet,trx_jun,margin_jun,dev_margin,CASE WHEN trx_jun>0 THEN margin_jun/trx_jun ELSE 0 END AS avg_margin_per_trx,${marginStatusSQL} FROM speedcash_snapshot WHERE tanggal=$1 ORDER BY margin_jun DESC NULLS LAST LIMIT 20`, [tanggal]),
      // 13. Top 20 DEV Margin (positive)
      pool.query(`SELECT id_outlet,trx_jun,margin_jun,dev_margin,CASE WHEN trx_jun>0 THEN margin_jun/trx_jun ELSE 0 END AS avg_margin_per_trx,${marginStatusSQL} FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin > 0 ORDER BY dev_margin DESC LIMIT 20`, [tanggal]),
      // 14. Bottom 20 DEV Margin (negative)
      pool.query(`SELECT id_outlet,trx_jun,margin_jun,dev_margin,CASE WHEN trx_jun>0 THEN margin_jun/trx_jun ELSE 0 END AS avg_margin_per_trx,${marginStatusSQL} FROM speedcash_snapshot WHERE tanggal=$1 AND dev_margin < 0 ORDER BY dev_margin ASC LIMIT 20`, [tanggal]),
      // 15. Cohort by year
      pool.query(`
        SELECT EXTRACT(YEAR FROM tgl_reg)::int AS tahun_reg,
          COUNT(*) AS total_outlet,
          COALESCE(SUM(trx_jun),0) AS total_trx_jun, COALESCE(SUM(trx_mei),0) AS total_trx_mei,
          COALESCE(SUM(margin_jun),0) AS total_margin_jun, COALESCE(SUM(margin_mei),0) AS total_margin_mei,
          ROUND(AVG(trx_jun)::numeric,1) AS avg_trx_jun, ROUND(AVG(margin_jun)::numeric,0) AS avg_margin_jun
        FROM speedcash_snapshot WHERE tanggal=$1 AND tgl_reg IS NOT NULL
        GROUP BY tahun_reg ORDER BY tahun_reg`, [tanggal]),
      // 16. Cohort by year+month
      pool.query(`
        SELECT EXTRACT(YEAR FROM tgl_reg)::int AS tahun_reg,
          EXTRACT(MONTH FROM tgl_reg)::int AS bulan_reg,
          TO_CHAR(tgl_reg,'Mon YYYY') AS label,
          COUNT(*) AS total_outlet,
          COALESCE(SUM(trx_jun),0) AS total_trx_jun, COALESCE(SUM(trx_mei),0) AS total_trx_mei,
          COALESCE(SUM(margin_jun),0) AS total_margin_jun, COALESCE(SUM(margin_mei),0) AS total_margin_mei
        FROM speedcash_snapshot WHERE tanggal=$1 AND tgl_reg IS NOT NULL
        GROUP BY tahun_reg,bulan_reg,label ORDER BY tahun_reg,bulan_reg`, [tanggal]),
      // 17. Action: Critical Drop
      pool.query(`SELECT id_outlet,tgl_reg,trx_mei,trx_jun,dev_trx,margin_mei,margin_jun,dev_margin,${segSQL},
        (tgl_reg IS NOT NULL AND tgl_reg >= $1::date - INTERVAL '1 month') AS is_outlet_baru
        FROM speedcash_snapshot WHERE tanggal=$1 AND dev_trx < 0 ORDER BY dev_trx ASC LIMIT 50`, [tanggal]),
      // 18. Action: High Opportunity
      pool.query(`SELECT id_outlet,tgl_reg,trx_mei,trx_jun,dev_trx,margin_mei,margin_jun,dev_margin,${segSQL},
        (tgl_reg IS NOT NULL AND tgl_reg >= $1::date - INTERVAL '1 month') AS is_outlet_baru
        FROM speedcash_snapshot WHERE tanggal=$1 AND dev_trx > 0 AND dev_margin > 0 ORDER BY dev_margin DESC LIMIT 50`, [tanggal]),
      // 19. Action: High TRX Low Margin
      pool.query(`SELECT id_outlet,tgl_reg,trx_mei,trx_jun,dev_trx,margin_mei,margin_jun,dev_margin,${segSQL},
        CASE WHEN trx_jun>0 THEN margin_jun/trx_jun ELSE 0 END AS avg_margin_per_trx
        FROM speedcash_snapshot WHERE tanggal=$1 AND trx_jun >= ${p.trxP75} AND margin_jun < ${p.marginP25}
        ORDER BY trx_jun DESC LIMIT 50`, [tanggal]),
      // 20. Action: Rising Stars
      pool.query(`SELECT id_outlet,tgl_reg,trx_mei,trx_jun,dev_trx,margin_mei,margin_jun,dev_margin,${segSQL},
        (tgl_reg IS NOT NULL AND tgl_reg >= $1::date - INTERVAL '1 month') AS is_outlet_baru
        FROM speedcash_snapshot WHERE tanggal=$1 AND (trx_mei = 0 OR trx_mei < ${p.trxP25}) AND trx_jun > ${p.trxP50} AND dev_margin > 0
        ORDER BY dev_margin DESC LIMIT 50`, [tanggal]),
    ]);

    const s = summaryRes.rows[0];
    const summary = {
      total_outlet    : Number(s.total_outlet),
      total_aktif_jun : Number(s.total_aktif_jun),
      total_trx_jun   : Number(s.total_trx_jun),
      total_trx_mei   : Number(s.total_trx_mei),
      total_margin_jun: Number(s.total_margin_jun),
      total_margin_mei: Number(s.total_margin_mei),
      outlet_growing  : Number(s.outlet_growing),
      outlet_declining: Number(s.outlet_declining),
      outlet_churn    : Number(s.outlet_churn),
      outlet_new_active: Number(s.outlet_new_active),
      outlet_stable   : Number(s.outlet_stable),
      outlet_baru     : Number(s.outlet_baru),
      dev_trx         : Number(s.total_trx_jun) - Number(s.total_trx_mei),
      dev_margin      : Number(s.total_margin_jun) - Number(s.total_margin_mei),
    };

    const growthCounts = {};
    for (const r of growthCountRes.rows) growthCounts[r.growth_status] = Number(r.cnt);

    const segmentCounts = {};
    for (const r of segCountRes.rows) segmentCounts[r.segment] = Number(r.cnt);

    res.json({
      tanggal, summary, thresholds: p,
      growth_counts   : growthCounts,
      segment_counts  : segmentCounts,
      top10_trx       : top10TrxRes.rows,
      top10_margin    : top10MarginRes.rows,
      top20_dt_pos    : top20DTPos.rows,
      top20_dt_neg    : top20DTNeg.rows,
      top20_dm_pos    : top20DMPos.rows,
      top20_dm_neg    : top20DMNeg.rows,
      growth_table    : growthTableRes.rows,
      scatter_data    : scatterRes.rows,
      top20_margin_jun: top20MarginRes.rows,
      top20_dev_margin: top20DMRes.rows,
      bot20_dev_margin: bot20DMRes.rows,
      cohort_year     : cohortYearRes.rows,
      cohort_month    : cohortMonthRes.rows,
      action_drop     : actDropRes.rows,
      action_growth   : actGrowthRes.rows,
      action_high_trx : actHighTrxRes.rows,
      action_rising   : actRisingRes.rows,
    });
  } catch (e) {
    console.error('speedcash analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════
   PA PRODUK — Sync + Analytics
══════════════════════════════════════════════ */

async function paProdukSyncHandler(req, res) {
  const { token, tanggal, periode_start, periode_end, rows, mat_totals } = req.body;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!tanggal || !rows || !Array.isArray(rows)) return res.status(400).json({ error: 'tanggal + rows required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const r of rows) {
      const produk = String(r.produk || '').trim();
      if (!produk || /^total$/i.test(produk)) continue;
      await client.query(`
        INSERT INTO pa_produk_snapshot
          (tanggal, periode_start, periode_end, produk,
           mat_apr, trx_apr, rev_apr,
           mat_mei, trx_mei, rev_mei,
           mat_jun, trx_jun, rev_jun, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (tanggal, produk) DO UPDATE SET
          periode_start=EXCLUDED.periode_start, periode_end=EXCLUDED.periode_end,
          mat_apr=EXCLUDED.mat_apr, trx_apr=EXCLUDED.trx_apr, rev_apr=EXCLUDED.rev_apr,
          mat_mei=EXCLUDED.mat_mei, trx_mei=EXCLUDED.trx_mei, rev_mei=EXCLUDED.rev_mei,
          mat_jun=EXCLUDED.mat_jun, trx_jun=EXCLUDED.trx_jun, rev_jun=EXCLUDED.rev_jun,
          synced_at=NOW()
      `, [
        tanggal, periode_start || tanggal, periode_end || tanggal, produk,
        r.mat_apr || 0, r.trx_apr || 0, r.rev_apr || 0,
        r.mat_mei || 0, r.trx_mei || 0, r.rev_mei || 0,
        r.mat_jun || 0, r.trx_jun || 0, r.rev_jun || 0,
      ]);
      count++;
    }

    // Simpan MAT resmi dari baris TOTAL sheet (row 24)
    if (mat_totals && (mat_totals.mat_jun || mat_totals.mat_mei || mat_totals.mat_apr)) {
      await client.query(`
        INSERT INTO pa_produk_totals (tanggal, mat_apr, mat_mei, mat_jun, synced_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (tanggal) DO UPDATE SET
          mat_apr=EXCLUDED.mat_apr, mat_mei=EXCLUDED.mat_mei,
          mat_jun=EXCLUDED.mat_jun, synced_at=NOW()
      `, [tanggal, mat_totals.mat_apr || 0, mat_totals.mat_mei || 0, mat_totals.mat_jun || 0]);
    }

    await client.query('COMMIT');
    res.json({ success: true, rows: count, tanggal, mat_totals: mat_totals || null });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('pa-produk sync error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

router.post('/pa-produk/sync', paProdukSyncHandler);

router.get('/pa-produk/analytics', async (req, res) => {
  try {
    const latestRes = await pool.query(
      'SELECT MAX(tanggal) AS t FROM pa_produk_snapshot'
    );
    const tanggal = latestRes.rows[0]?.t;
    if (!tanggal) return res.json({ meta: null, total: {}, data: [] });

    const [metaRes, totalRes, dataRes, totalsRes] = await Promise.all([
      pool.query(
        'SELECT tanggal, periode_start, periode_end FROM pa_produk_snapshot WHERE tanggal=$1 LIMIT 1',
        [tanggal]
      ),
      pool.query(`
        SELECT
          SUM(mat_apr) AS mat_apr, SUM(trx_apr) AS trx_apr, SUM(rev_apr) AS rev_apr,
          SUM(mat_mei) AS mat_mei, SUM(trx_mei) AS trx_mei, SUM(rev_mei) AS rev_mei,
          SUM(mat_jun) AS mat_jun, SUM(trx_jun) AS trx_jun, SUM(rev_jun) AS rev_jun
        FROM pa_produk_snapshot WHERE tanggal=$1
      `, [tanggal]),
      pool.query(`
        SELECT
          produk,
          mat_apr, trx_apr, rev_apr,
          mat_mei, trx_mei, rev_mei,
          mat_jun, trx_jun, rev_jun,
          (trx_jun - trx_mei) AS dev_trx_mei_jun,
          (rev_jun - rev_mei) AS dev_rev_mei_jun,
          CASE WHEN trx_mei > 0
            THEN ROUND(((trx_jun - trx_mei)::numeric / trx_mei * 100), 1)
            ELSE NULL END AS pct_trx_growth,
          CASE WHEN rev_mei > 0
            THEN ROUND(((rev_jun - rev_mei)::numeric / rev_mei * 100), 1)
            ELSE NULL END AS pct_rev_growth,
          CASE WHEN trx_jun > 0 THEN ROUND(rev_jun::numeric / trx_jun) ELSE 0 END AS arpt_jun,
          CASE WHEN trx_mei > 0 THEN ROUND(rev_mei::numeric / trx_mei) ELSE 0 END AS arpt_mei,
          CASE WHEN trx_apr > 0 THEN ROUND(rev_apr::numeric / trx_apr) ELSE 0 END AS arpt_apr
        FROM pa_produk_snapshot
        WHERE tanggal=$1
        ORDER BY rev_jun DESC
      `, [tanggal]),
      pool.query(
        'SELECT mat_apr, mat_mei, mat_jun FROM pa_produk_totals WHERE tanggal=$1',
        [tanggal]
      ).catch(() => ({ rows: [] })), // graceful if table doesn't exist yet
    ]);

    const meta  = metaRes.rows[0] || { tanggal, periode_start: tanggal, periode_end: tanggal };
    const total = totalRes.rows[0] || {};
    for (const k of Object.keys(total)) total[k] = Number(total[k]) || 0;

    // Override MAT dengan nilai resmi dari baris TOTAL sheet (row 24)
    const officialTotals = totalsRes.rows[0];
    if (officialTotals) {
      if (officialTotals.mat_apr > 0) total.mat_apr = Number(officialTotals.mat_apr);
      if (officialTotals.mat_mei > 0) total.mat_mei = Number(officialTotals.mat_mei);
      if (officialTotals.mat_jun > 0) total.mat_jun = Number(officialTotals.mat_jun);
    }

    res.json({ meta, total, data: dataRes.rows });
  } catch (e) {
    console.error('pa-produk analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/pa-produk/trendline', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 3), 90);
    const result = await pool.query(
      `SELECT tanggal, produk, mat_jun, trx_jun, rev_jun
       FROM pa_produk_snapshot
       WHERE tanggal >= CURRENT_DATE - ($1 * interval '1 day')
       ORDER BY tanggal ASC, rev_jun DESC`,
      [days]
    );

    const byProduk = {};
    for (const row of result.rows) {
      const p = row.produk;
      if (!byProduk[p]) byProduk[p] = [];
      byProduk[p].push({
        tanggal: String(row.tanggal).substring(0, 10),
        mat_jun: Number(row.mat_jun) || 0,
        trx_jun: Number(row.trx_jun) || 0,
        rev_jun: Number(row.rev_jun) || 0,
      });
    }

    const dates    = [...new Set(result.rows.map(r => String(r.tanggal).substring(0, 10)))].sort();
    const products = Object.keys(byProduk).sort((a, b) => {
      const lastA = byProduk[a][byProduk[a].length - 1]?.rev_jun || 0;
      const lastB = byProduk[b][byProduk[b].length - 1]?.rev_jun || 0;
      return lastB - lastA;
    });

    res.json({ dates, byProduk, products, days });
  } catch (e) {
    console.error('pa-produk trendline error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─── PA ARPU Outlet Sync ─── */
async function paArpuSyncHandler(req, res) {
  const { token, tanggal, rows } = req.body;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!tanggal || !rows || !Array.isArray(rows)) return res.status(400).json({ error: 'tanggal + rows required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const r of rows) {
      const id_outlet = String(r.id_outlet || '').trim();
      if (!id_outlet) continue;
      await client.query(`
        INSERT INTO pa_arpu_snapshot
          (tanggal, id_outlet, layer_arpu, jml_group_layanan, jml_bill, jml_trx, jml_rev, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
          layer_arpu=EXCLUDED.layer_arpu,
          jml_group_layanan=EXCLUDED.jml_group_layanan,
          jml_bill=EXCLUDED.jml_bill,
          jml_trx=EXCLUDED.jml_trx,
          jml_rev=EXCLUDED.jml_rev,
          synced_at=NOW()
      `, [
        tanggal, id_outlet,
        String(r.layer_arpu || '').trim(),
        r.jml_group_layanan || 0,
        r.jml_bill || 0,
        r.jml_trx  || 0,
        r.jml_rev  || 0,
      ]);
      count++;
    }
    await client.query('COMMIT');
    res.json({ success: true, rows: count, tanggal });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('pa-arpu sync error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

router.post('/pa-arpu/sync', paArpuSyncHandler);

router.get('/pa-arpu/analytics', async (req, res) => {
  try {
    const latestRes = await pool.query('SELECT MAX(tanggal) AS t FROM pa_arpu_snapshot');
    const tanggal = latestRes.rows[0]?.t;
    if (!tanggal) return res.json({ tanggal: null, layers: [], total: {} });

    const [layerRes, totalRes] = await Promise.all([
      pool.query(`
        SELECT
          layer_arpu,
          COUNT(*)        AS jumlah_agen,
          SUM(jml_trx)    AS total_trx,
          SUM(jml_rev)    AS total_rev
        FROM pa_arpu_snapshot
        WHERE tanggal = $1 AND layer_arpu IS NOT NULL AND layer_arpu <> ''
        GROUP BY layer_arpu
        ORDER BY CASE layer_arpu
          WHEN 'Low ARPU'  THEN 1
          WHEN 'Mid ARPU'  THEN 2
          WHEN 'High ARPU' THEN 3
          WHEN 'Top ARPU'  THEN 4
          ELSE 5 END
      `, [tanggal]),
      pool.query(`
        SELECT COUNT(*) AS total_agen, SUM(jml_rev) AS total_rev
        FROM pa_arpu_snapshot WHERE tanggal=$1
      `, [tanggal]),
    ]);

    const totalAgen = Number(totalRes.rows[0]?.total_agen) || 0;
    const totalRev  = Number(totalRes.rows[0]?.total_rev)  || 0;

    const layers = layerRes.rows.map(r => {
      const agen = Number(r.jumlah_agen) || 0;
      const rev  = Number(r.total_rev)   || 0;
      return {
        layer:       r.layer_arpu,
        jumlah_agen: agen,
        total_trx:   Number(r.total_trx) || 0,
        total_rev:   rev,
        pct_distribusi:   totalAgen > 0 ? +((agen / totalAgen) * 100).toFixed(1) : 0,
        pct_kontribusi_rev: totalRev > 0 ? Math.round((rev / totalRev) * 100) : 0,
      };
    });

    res.json({ tanggal: String(tanggal).substring(0,10), layers, total: { jumlah_agen: totalAgen, total_rev: totalRev } });
  } catch (e) {
    console.error('pa-arpu analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.syncHandler          = syncHandler;
module.exports.speedcashSyncHandler = speedcashSyncHandler;
module.exports.paProdukSyncHandler  = paProdukSyncHandler;
module.exports.paArpuSyncHandler    = paArpuSyncHandler;
