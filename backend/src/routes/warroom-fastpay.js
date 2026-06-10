const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

/* ─────────────────────────────────────────────
   Helper: compute status from raw values
───────────────────────────────────────────── */
function computeStatus(trxMei, trxJun, pctTrxGrowth, devTrx) {
  if (trxMei > 0 && trxJun === 0)                                 return 'churned';
  if (trxMei === 0 && trxJun > 0)                                  return 'new';
  if (trxMei > 0 && pctTrxGrowth >= 50 && devTrx >= 20)           return 'rocket';
  if (trxMei > 0 && devTrx > 0)                                    return 'growing';
  if (trxMei > 0 && devTrx < 0)                                    return 'declining';
  return 'stable';
}

/* ─────────────────────────────────────────────
   POST /api/warroom/fastpay/sync
   Token auth (bukan JWT) — dipanggil Apps Script
───────────────────────────────────────────── */
async function syncHandler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${SYNC_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { tanggal, data } = req.body;
  if (!tanggal || !Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Body tidak valid. Perlu tanggal & data[]' });
  }

  try {
    // Compute derived fields for each row
    const idOutlets   = [], trxMeis  = [], revMeis     = [];
    const trxJuns     = [], revJuns  = [], devTrxs     = [];
    const devRevs     = [], pctTrxs  = [], pctRevs     = [];
    const avgRevMeis  = [], avgRevJuns = [], statuses   = [];

    for (const row of data) {
      const trxMei = parseInt(row.trx_mei) || 0;
      const trxJun = parseInt(row.trx_jun) || 0;
      const revMei = parseInt(row.rev_mei) || 0;
      const revJun = parseInt(row.rev_jun) || 0;

      const devTrx = trxJun - trxMei;
      const devRev = revJun - revMei;
      const pctTrxGrowth = trxMei > 0 ? ((devTrx / trxMei) * 100) : (trxJun > 0 ? 100 : 0);
      const pctRevGrowth = revMei > 0 ? ((devRev / revMei) * 100) : (revJun > 0 ? 100 : 0);
      const avgRevMei    = trxMei > 0 ? Math.round(revMei / trxMei) : 0;
      const avgRevJun    = trxJun > 0 ? Math.round(revJun / trxJun) : 0;
      const status       = computeStatus(trxMei, trxJun, pctTrxGrowth, devTrx);

      idOutlets.push(String(row.id_outlet || '').trim());
      trxMeis.push(trxMei);  revMeis.push(revMei);
      trxJuns.push(trxJun);  revJuns.push(revJun);
      devTrxs.push(devTrx);  devRevs.push(devRev);
      pctTrxs.push(parseFloat(pctTrxGrowth.toFixed(2)));
      pctRevs.push(parseFloat(pctRevGrowth.toFixed(2)));
      avgRevMeis.push(avgRevMei);
      avgRevJuns.push(avgRevJun);
      statuses.push(status);
    }

    const result = await pool.query(
      `INSERT INTO fastpay_snapshot
         (tanggal, id_outlet, trx_mei, rev_mei, trx_jun, rev_jun,
          dev_trx, dev_rev, pct_trx_growth, pct_rev_growth,
          avg_rev_per_trx_mei, avg_rev_per_trx_jun, status, synced_at)
       SELECT $1,
         unnest($2::varchar[]), unnest($3::int[]),  unnest($4::bigint[]),
         unnest($5::int[]),     unnest($6::bigint[]),
         unnest($7::int[]),     unnest($8::bigint[]),
         unnest($9::numeric[]), unnest($10::numeric[]),
         unnest($11::bigint[]), unnest($12::bigint[]),
         unnest($13::varchar[]), NOW()
       ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
         trx_mei             = EXCLUDED.trx_mei,
         rev_mei             = EXCLUDED.rev_mei,
         trx_jun             = EXCLUDED.trx_jun,
         rev_jun             = EXCLUDED.rev_jun,
         dev_trx             = EXCLUDED.dev_trx,
         dev_rev             = EXCLUDED.dev_rev,
         pct_trx_growth      = EXCLUDED.pct_trx_growth,
         pct_rev_growth      = EXCLUDED.pct_rev_growth,
         avg_rev_per_trx_mei = EXCLUDED.avg_rev_per_trx_mei,
         avg_rev_per_trx_jun = EXCLUDED.avg_rev_per_trx_jun,
         status              = EXCLUDED.status,
         synced_at           = NOW()`,
      [tanggal, idOutlets, trxMeis, revMeis, trxJuns, revJuns,
       devTrxs, devRevs, pctTrxs, pctRevs, avgRevMeis, avgRevJuns, statuses]
    );

    res.json({ success: true, upserted: result.rowCount, tanggal });
  } catch (err) {
    console.error('[fastpay sync]', err.message);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────────────────────────────────
   GET /api/warroom/fastpay/analytics
   requireAuth — dipanggil frontend
───────────────────────────────────────────── */
async function analyticsHandler(req, res) {
  try {
    // Step 1: get latest tanggal
    const { rows: dateRows } = await pool.query(
      `SELECT MAX(tanggal) AS tanggal FROM fastpay_snapshot`
    );
    const tanggal = dateRows[0]?.tanggal;
    if (!tanggal) return res.json({ error: 'Belum ada data' });

    // Step 2: run all analytics queries in parallel
    const [
      metaRes, summaryRes, statusRes,
      top15TrxRes, top15RevRes,
      top15GrowthTrxRes, top15DeclineTrxRes, top15GrowthRevRes,
      newRes, churnedRes, rocketRes,
      prefixRes, trxDistRes, allOutletsRes, anomaliRes
    ] = await Promise.all([

      // meta
      pool.query(
        `SELECT tanggal, COUNT(*) AS total_outlets
         FROM fastpay_snapshot WHERE tanggal = $1
         GROUP BY tanggal`, [tanggal]
      ),

      // summary
      pool.query(
        `SELECT
           SUM(trx_mei) AS total_trx_mei, SUM(trx_jun) AS total_trx_jun,
           SUM(rev_mei) AS total_rev_mei, SUM(rev_jun) AS total_rev_jun,
           SUM(dev_trx) AS dev_trx,      SUM(dev_rev) AS dev_rev,
           COUNT(CASE WHEN trx_jun > 0 THEN 1 END) AS active_jun,
           COUNT(CASE WHEN trx_mei > 0 THEN 1 END) AS active_mei,
           ROUND(AVG(CASE WHEN trx_mei > 0 THEN avg_rev_per_trx_jun END)) AS avg_rev_per_trx
         FROM fastpay_snapshot WHERE tanggal = $1`, [tanggal]
      ),

      // status counts
      pool.query(
        `SELECT status, COUNT(*) AS cnt
         FROM fastpay_snapshot WHERE tanggal = $1
         GROUP BY status`, [tanggal]
      ),

      // top 15 by trx_jun
      pool.query(
        `SELECT id_outlet, trx_mei, trx_jun, dev_trx, pct_trx_growth, status
         FROM fastpay_snapshot WHERE tanggal = $1
         ORDER BY trx_jun DESC LIMIT 15`, [tanggal]
      ),

      // top 15 by rev_jun
      pool.query(
        `SELECT id_outlet, rev_mei, rev_jun, dev_rev, pct_rev_growth, trx_jun, status
         FROM fastpay_snapshot WHERE tanggal = $1
         ORDER BY rev_jun DESC LIMIT 15`, [tanggal]
      ),

      // top 15 growth by pct_trx_growth (rocket + growing)
      pool.query(
        `SELECT id_outlet, trx_mei, trx_jun, dev_trx, pct_trx_growth, rev_jun, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND status IN ('rocket','growing')
         ORDER BY pct_trx_growth DESC LIMIT 15`, [tanggal]
      ),

      // top 15 decline by dev_trx (declining)
      pool.query(
        `SELECT id_outlet, trx_mei, trx_jun, dev_trx, pct_trx_growth, rev_mei, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND status = 'declining'
         ORDER BY dev_trx ASC LIMIT 15`, [tanggal]
      ),

      // top 15 growth by dev_rev positive
      pool.query(
        `SELECT id_outlet, rev_mei, rev_jun, dev_rev, pct_rev_growth, trx_jun, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND dev_rev > 0
         ORDER BY dev_rev DESC LIMIT 15`, [tanggal]
      ),

      // new outlets (trx_mei=0, trx_jun>0)
      pool.query(
        `SELECT id_outlet, trx_jun, rev_jun, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND status = 'new'
         ORDER BY trx_jun DESC LIMIT 50`, [tanggal]
      ),

      // churned outlets (trx_mei>0, trx_jun=0)
      pool.query(
        `SELECT id_outlet, trx_mei, rev_mei, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND status = 'churned'
         ORDER BY rev_mei DESC LIMIT 50`, [tanggal]
      ),

      // rocket outlets
      pool.query(
        `SELECT id_outlet, trx_mei, trx_jun, dev_trx, pct_trx_growth, rev_jun, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND status = 'rocket'
         ORDER BY pct_trx_growth DESC LIMIT 50`, [tanggal]
      ),

      // prefix breakdown (first 3 chars of id_outlet)
      pool.query(
        `SELECT
           SUBSTRING(id_outlet, 1, 3) AS prefix,
           COUNT(*) AS total_outlets,
           SUM(trx_jun) AS total_trx_jun,
           SUM(rev_jun) AS total_rev_jun,
           COUNT(CASE WHEN trx_jun > 0 THEN 1 END) AS active_jun
         FROM fastpay_snapshot WHERE tanggal = $1
         GROUP BY SUBSTRING(id_outlet, 1, 3)
         ORDER BY total_trx_jun DESC LIMIT 20`, [tanggal]
      ),

      // TRX distribution buckets
      pool.query(
        `SELECT
           CASE
             WHEN trx_jun = 0     THEN '0 (Inactive)'
             WHEN trx_jun BETWEEN 1  AND 5   THEN '1-5'
             WHEN trx_jun BETWEEN 6  AND 20  THEN '6-20'
             WHEN trx_jun BETWEEN 21 AND 50  THEN '21-50'
             WHEN trx_jun BETWEEN 51 AND 100 THEN '51-100'
             WHEN trx_jun BETWEEN 101 AND 500 THEN '101-500'
             ELSE '501+'
           END AS bucket,
           COUNT(*) AS cnt
         FROM fastpay_snapshot WHERE tanggal = $1
         GROUP BY bucket
         ORDER BY MIN(trx_jun)`, [tanggal]
      ),

      // all outlets (for detail tab)
      pool.query(
        `SELECT id_outlet, trx_mei, trx_jun, rev_mei, rev_jun,
                dev_trx, dev_rev, pct_trx_growth, pct_rev_growth,
                avg_rev_per_trx_mei, avg_rev_per_trx_jun, status
         FROM fastpay_snapshot WHERE tanggal = $1
         ORDER BY trx_jun DESC`, [tanggal]
      ),

      // anomali: free TRX (trx > 0 but rev = 0)
      pool.query(
        `SELECT id_outlet, trx_jun, rev_jun, trx_mei, rev_mei, status
         FROM fastpay_snapshot
         WHERE tanggal = $1 AND trx_jun > 0 AND rev_jun = 0
         ORDER BY trx_jun DESC LIMIT 100`, [tanggal]
      ),
    ]);

    // Build status_counts map
    const status_counts = {};
    for (const r of statusRes.rows) status_counts[r.status] = parseInt(r.cnt);

    // Compute pct_dev from summary
    const s = summaryRes.rows[0] || {};
    const pct_dev_trx = s.total_trx_mei > 0
      ? ((s.dev_trx / s.total_trx_mei) * 100).toFixed(2)
      : 0;
    const pct_dev_rev = s.total_rev_mei > 0
      ? ((s.dev_rev / s.total_rev_mei) * 100).toFixed(2)
      : 0;

    res.json({
      meta: {
        sync_date: tanggal,
        total_outlets: parseInt(metaRes.rows[0]?.total_outlets || 0),
      },
      summary: {
        total_trx_mei:   parseInt(s.total_trx_mei || 0),
        total_trx_jun:   parseInt(s.total_trx_jun || 0),
        total_rev_mei:   parseInt(s.total_rev_mei || 0),
        total_rev_jun:   parseInt(s.total_rev_jun || 0),
        dev_trx:         parseInt(s.dev_trx || 0),
        dev_rev:         parseInt(s.dev_rev || 0),
        pct_dev_trx:     parseFloat(pct_dev_trx),
        pct_dev_rev:     parseFloat(pct_dev_rev),
        active_jun:      parseInt(s.active_jun || 0),
        active_mei:      parseInt(s.active_mei || 0),
        avg_rev_per_trx: parseInt(s.avg_rev_per_trx || 0),
      },
      status_counts,
      top15_trx_jun:      top15TrxRes.rows,
      top15_rev_jun:      top15RevRes.rows,
      top15_growth_trx:   top15GrowthTrxRes.rows,
      top15_decline_trx:  top15DeclineTrxRes.rows,
      top15_growth_rev:   top15GrowthRevRes.rows,
      new_outlets:        newRes.rows,
      churned_outlets:    churnedRes.rows,
      rocket_outlets:     rocketRes.rows,
      prefix_breakdown:   prefixRes.rows,
      trx_distribution:   trxDistRes.rows,
      all_outlets:        allOutletsRes.rows,
      anomali_free_trx:   anomaliRes.rows,
    });
  } catch (err) {
    console.error('[fastpay analytics]', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler };
