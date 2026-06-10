const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

/* ─────────────────────────────────────────────
   Helper: compute status
   Berbasis trx_mei_period vs trx_jun_period
───────────────────────────────────────────── */
function computeStatus(trxMeiP, trxJunP, pctGrowth, devTrx) {
  if (trxMeiP > 0 && trxJunP === 0)                              return 'churned';
  if (trxMeiP === 0 && trxJunP > 0)                              return 'new';
  if (trxMeiP > 0 && pctGrowth >= 50 && devTrx >= 20)           return 'rocket';
  if (trxMeiP > 0 && devTrx > 0)                                 return 'growing';
  if (trxMeiP > 0 && devTrx < 0)                                 return 'declining';
  return 'stable';
}

/* ─────────────────────────────────────────────
   POST /api/warroom/farming/sync
   Kolom sheet (skip 2 baris header):
   A=id_outlet, B=trx_mei_full, C=rev_mei_full,
   D=trx_mei_period, E=rev_mei_period,
   F=trx_jun_period, G=rev_jun_period
   (kolom H=dev_trx, I=dev_rev diabaikan, dihitung ulang)
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
    const ids          = [], trxMeiFull  = [], revMeiFull  = [];
    const trxMeiPeriod = [], revMeiPeriod = [];
    const trxJunPeriod = [], revJunPeriod = [];
    const devTrxs      = [], devRevs      = [];
    const pctTrxs      = [], pctRevs      = [];
    const avgRevMeis   = [], avgRevJuns   = [];
    const statuses     = [];

    for (const row of data) {
      const trxMF = parseInt(row.trx_mei_full)   || 0;
      const revMF = parseInt(row.rev_mei_full)   || 0;
      const trxMP = parseInt(row.trx_mei_period) || 0;
      const revMP = parseInt(row.rev_mei_period) || 0;
      const trxJP = parseInt(row.trx_jun_period) || 0;
      const revJP = parseInt(row.rev_jun_period) || 0;

      const devTrx       = trxJP - trxMP;
      const devRev       = revJP - revMP;
      const pctTrxGrowth = trxMP > 0 ? ((devTrx / trxMP) * 100) : (trxJP > 0 ? 100 : 0);
      const pctRevGrowth = revMP > 0 ? ((devRev / revMP) * 100) : (revJP > 0 ? 100 : 0);
      const avgRevMei    = trxMP > 0 ? Math.round(revMP / trxMP) : 0;
      const avgRevJun    = trxJP > 0 ? Math.round(revJP / trxJP) : 0;
      const status       = computeStatus(trxMP, trxJP, pctTrxGrowth, devTrx);

      ids.push(String(row.id_outlet || '').trim());
      trxMeiFull.push(trxMF);   revMeiFull.push(revMF);
      trxMeiPeriod.push(trxMP); revMeiPeriod.push(revMP);
      trxJunPeriod.push(trxJP); revJunPeriod.push(revJP);
      devTrxs.push(devTrx);     devRevs.push(devRev);
      pctTrxs.push(parseFloat(pctTrxGrowth.toFixed(2)));
      pctRevs.push(parseFloat(pctRevGrowth.toFixed(2)));
      avgRevMeis.push(avgRevMei);
      avgRevJuns.push(avgRevJun);
      statuses.push(status);
    }

    const result = await pool.query(
      `INSERT INTO farming_snapshot
         (tanggal, id_outlet,
          trx_mei_full, rev_mei_full,
          trx_mei_period, rev_mei_period,
          trx_jun_period, rev_jun_period,
          dev_trx, dev_rev,
          pct_trx_growth, pct_rev_growth,
          avg_rev_per_trx_mei, avg_rev_per_trx_jun,
          status, synced_at)
       SELECT $1,
         unnest($2::varchar[]),
         unnest($3::int[]),  unnest($4::bigint[]),
         unnest($5::int[]),  unnest($6::bigint[]),
         unnest($7::int[]),  unnest($8::bigint[]),
         unnest($9::int[]),  unnest($10::bigint[]),
         unnest($11::numeric[]), unnest($12::numeric[]),
         unnest($13::bigint[]),  unnest($14::bigint[]),
         unnest($15::varchar[]), NOW()
       ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
         trx_mei_full         = EXCLUDED.trx_mei_full,
         rev_mei_full         = EXCLUDED.rev_mei_full,
         trx_mei_period       = EXCLUDED.trx_mei_period,
         rev_mei_period       = EXCLUDED.rev_mei_period,
         trx_jun_period       = EXCLUDED.trx_jun_period,
         rev_jun_period       = EXCLUDED.rev_jun_period,
         dev_trx              = EXCLUDED.dev_trx,
         dev_rev              = EXCLUDED.dev_rev,
         pct_trx_growth       = EXCLUDED.pct_trx_growth,
         pct_rev_growth       = EXCLUDED.pct_rev_growth,
         avg_rev_per_trx_mei  = EXCLUDED.avg_rev_per_trx_mei,
         avg_rev_per_trx_jun  = EXCLUDED.avg_rev_per_trx_jun,
         status               = EXCLUDED.status,
         synced_at            = NOW()`,
      [tanggal, ids,
       trxMeiFull, revMeiFull,
       trxMeiPeriod, revMeiPeriod,
       trxJunPeriod, revJunPeriod,
       devTrxs, devRevs,
       pctTrxs, pctRevs,
       avgRevMeis, avgRevJuns,
       statuses]
    );

    res.json({ success: true, upserted: result.rowCount, tanggal });
  } catch (err) {
    console.error('[farming sync]', err.message);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────────────────────────────────
   GET /api/warroom/farming/analytics
───────────────────────────────────────────── */
async function analyticsHandler(req, res) {
  try {
    const { rows: dateRows } = await pool.query(
      `SELECT MAX(tanggal) AS tanggal FROM farming_snapshot`
    );
    const tanggal = dateRows[0]?.tanggal;
    if (!tanggal) return res.json({ error: 'Belum ada data' });

    const [
      metaRes, summaryRes, statusRes,
      top15TrxRes, top15RevRes,
      top15GrowthTrxRes, top15DeclineTrxRes, top15GrowthRevRes,
      newRes, churnedRes, rocketRes,
      prefixRes, trxDistRes, scatterRes, anomaliRes
    ] = await Promise.all([

      // meta
      pool.query(
        `SELECT tanggal, COUNT(*) AS total_outlets
         FROM farming_snapshot WHERE tanggal = $1 GROUP BY tanggal`, [tanggal]
      ),

      // summary
      pool.query(
        `SELECT
           SUM(trx_mei_period)  AS total_trx_mei_period,
           SUM(trx_jun_period)  AS total_trx_jun_period,
           SUM(rev_mei_period)  AS total_rev_mei_period,
           SUM(rev_jun_period)  AS total_rev_jun_period,
           SUM(trx_mei_full)    AS total_trx_mei_full,
           SUM(rev_mei_full)    AS total_rev_mei_full,
           SUM(dev_trx)         AS dev_trx,
           SUM(dev_rev)         AS dev_rev,
           COUNT(CASE WHEN trx_jun_period > 0 THEN 1 END) AS active_jun,
           COUNT(CASE WHEN trx_mei_period > 0 THEN 1 END) AS active_mei
         FROM farming_snapshot WHERE tanggal = $1`, [tanggal]
      ),

      // status counts
      pool.query(
        `SELECT status, COUNT(*) AS cnt
         FROM farming_snapshot WHERE tanggal = $1 GROUP BY status`, [tanggal]
      ),

      // top 15 trx_jun_period
      pool.query(
        `SELECT id_outlet, trx_mei_period, trx_jun_period, dev_trx, pct_trx_growth, trx_mei_full, status
         FROM farming_snapshot WHERE tanggal = $1
         ORDER BY trx_jun_period DESC LIMIT 15`, [tanggal]
      ),

      // top 15 rev_jun_period
      pool.query(
        `SELECT id_outlet, rev_mei_period, rev_jun_period, dev_rev, pct_rev_growth, rev_mei_full, trx_jun_period, status
         FROM farming_snapshot WHERE tanggal = $1
         ORDER BY rev_jun_period DESC LIMIT 15`, [tanggal]
      ),

      // top 15 growth (rocket + growing)
      pool.query(
        `SELECT id_outlet, trx_mei_period, trx_jun_period, dev_trx, pct_trx_growth, rev_jun_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND status IN ('rocket','growing')
         ORDER BY pct_trx_growth DESC LIMIT 15`, [tanggal]
      ),

      // top 15 decline
      pool.query(
        `SELECT id_outlet, trx_mei_period, trx_jun_period, dev_trx, pct_trx_growth, rev_mei_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND status = 'declining'
         ORDER BY dev_trx ASC LIMIT 15`, [tanggal]
      ),

      // top 15 growth rev
      pool.query(
        `SELECT id_outlet, rev_mei_period, rev_jun_period, dev_rev, pct_rev_growth, trx_jun_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND dev_rev > 0
         ORDER BY dev_rev DESC LIMIT 15`, [tanggal]
      ),

      // new outlets
      pool.query(
        `SELECT id_outlet, trx_jun_period, rev_jun_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND status = 'new'
         ORDER BY trx_jun_period DESC LIMIT 50`, [tanggal]
      ),

      // churned outlets
      pool.query(
        `SELECT id_outlet, trx_mei_period, rev_mei_period, trx_mei_full, rev_mei_full, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND status = 'churned'
         ORDER BY rev_mei_full DESC LIMIT 50`, [tanggal]
      ),

      // rocket outlets
      pool.query(
        `SELECT id_outlet, trx_mei_period, trx_jun_period, dev_trx, pct_trx_growth, rev_jun_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND status = 'rocket'
         ORDER BY pct_trx_growth DESC LIMIT 50`, [tanggal]
      ),

      // prefix breakdown
      pool.query(
        `SELECT
           SUBSTRING(id_outlet, 1, 2) AS prefix,
           COUNT(*) AS total_outlets,
           SUM(trx_jun_period) AS total_trx_jun,
           SUM(rev_jun_period) AS total_rev_jun,
           COUNT(CASE WHEN trx_jun_period > 0 THEN 1 END) AS active_jun
         FROM farming_snapshot WHERE tanggal = $1
         GROUP BY SUBSTRING(id_outlet, 1, 2)
         ORDER BY total_trx_jun DESC LIMIT 20`, [tanggal]
      ),

      // TRX distribution
      pool.query(
        `SELECT
           CASE
             WHEN trx_jun_period = 0     THEN '0 (Inactive)'
             WHEN trx_jun_period BETWEEN 1  AND 5   THEN '1-5'
             WHEN trx_jun_period BETWEEN 6  AND 20  THEN '6-20'
             WHEN trx_jun_period BETWEEN 21 AND 50  THEN '21-50'
             WHEN trx_jun_period BETWEEN 51 AND 100 THEN '51-100'
             WHEN trx_jun_period BETWEEN 101 AND 500 THEN '101-500'
             ELSE '501+'
           END AS bucket,
           COUNT(*) AS cnt
         FROM farming_snapshot WHERE tanggal = $1
         GROUP BY bucket ORDER BY MIN(trx_jun_period)`, [tanggal]
      ),

      // scatter data for Revenue Analysis (max 3000 active outlets, 3 cols only)
      pool.query(
        `SELECT id_outlet, trx_jun_period, avg_rev_per_trx_jun, status
         FROM farming_snapshot WHERE tanggal = $1 AND trx_jun_period > 0
         ORDER BY trx_jun_period DESC LIMIT 3000`, [tanggal]
      ),

      // anomali free TRX
      pool.query(
        `SELECT id_outlet, trx_jun_period, rev_jun_period, trx_mei_period, rev_mei_period, status
         FROM farming_snapshot
         WHERE tanggal = $1 AND trx_jun_period > 0 AND rev_jun_period = 0
         ORDER BY trx_jun_period DESC LIMIT 100`, [tanggal]
      ),
    ]);

    const status_counts = {};
    for (const r of statusRes.rows) status_counts[r.status] = parseInt(r.cnt);

    const s = summaryRes.rows[0] || {};
    const pct_dev_trx = s.total_trx_mei_period > 0
      ? ((s.dev_trx / s.total_trx_mei_period) * 100).toFixed(2) : 0;
    const pct_dev_rev = s.total_rev_mei_period > 0
      ? ((s.dev_rev / s.total_rev_mei_period) * 100).toFixed(2) : 0;

    res.json({
      meta: {
        sync_date: tanggal,
        total_outlets: parseInt(metaRes.rows[0]?.total_outlets || 0),
      },
      summary: {
        total_trx_mei_period: parseInt(s.total_trx_mei_period || 0),
        total_trx_jun_period: parseInt(s.total_trx_jun_period || 0),
        total_rev_mei_period: parseInt(s.total_rev_mei_period || 0),
        total_rev_jun_period: parseInt(s.total_rev_jun_period || 0),
        total_trx_mei_full:   parseInt(s.total_trx_mei_full   || 0),
        total_rev_mei_full:   parseInt(s.total_rev_mei_full   || 0),
        dev_trx:              parseInt(s.dev_trx  || 0),
        dev_rev:              parseInt(s.dev_rev  || 0),
        pct_dev_trx:          parseFloat(pct_dev_trx),
        pct_dev_rev:          parseFloat(pct_dev_rev),
        active_jun:           parseInt(s.active_jun  || 0),
        active_mei:           parseInt(s.active_mei  || 0),
      },
      status_counts,
      top15_trx_jun:     top15TrxRes.rows,
      top15_rev_jun:     top15RevRes.rows,
      top15_growth_trx:  top15GrowthTrxRes.rows,
      top15_decline_trx: top15DeclineTrxRes.rows,
      top15_growth_rev:  top15GrowthRevRes.rows,
      new_outlets:       newRes.rows,
      churned_outlets:   churnedRes.rows,
      rocket_outlets:    rocketRes.rows,
      prefix_breakdown:  prefixRes.rows,
      trx_distribution:  trxDistRes.rows,
      scatter_data:      scatterRes.rows,
      anomali_free_trx:  anomaliRes.rows,
    });
  } catch (err) {
    console.error('[farming analytics]', err.message);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────────────────────────────────
   GET /api/warroom/farming/outlets
   Server-side paginated outlet detail
───────────────────────────────────────────── */
async function outletsHandler(req, res) {
  try {
    const { rows: dateRows } = await pool.query(`SELECT MAX(tanggal) AS tanggal FROM farming_snapshot`);
    const tanggal = dateRows[0]?.tanggal;
    if (!tanggal) return res.json({ rows: [], total: 0 });

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = req.query.status || 'all';
    const validCols = { trx_mei_full:1, rev_mei_full:1, trx_mei_period:1, rev_mei_period:1, trx_jun_period:1, rev_jun_period:1, dev_trx:1, dev_rev:1, pct_trx_growth:1, pct_rev_growth:1 };
    const col    = validCols[req.query.sortBy] ? req.query.sortBy : 'trx_jun_period';
    const dir    = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const conditions = [`tanggal = $1`];
    const params = [tanggal];
    if (status !== 'all') { params.push(status); conditions.push(`status = $${params.length}`); }
    if (search)           { params.push(`%${search.toLowerCase()}%`); conditions.push(`LOWER(id_outlet) LIKE $${params.length}`); }

    const where = conditions.join(' AND ');
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM farming_snapshot WHERE ${where}`, params),
      pool.query(
        `SELECT id_outlet,
                trx_mei_full, rev_mei_full,
                trx_mei_period, rev_mei_period,
                trx_jun_period, rev_jun_period,
                dev_trx, dev_rev, pct_trx_growth, pct_rev_growth,
                avg_rev_per_trx_mei, avg_rev_per_trx_jun, status
         FROM farming_snapshot WHERE ${where}
         ORDER BY ${col} ${dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({ rows: dataRes.rows, total: parseInt(countRes.rows[0].count), page, limit });
  } catch (err) {
    console.error('[farming outlets]', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, outletsHandler };
