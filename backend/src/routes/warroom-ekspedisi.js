const pool = require('../db');

const SECRET_TOKEN = 'bric2026bimasaktisecret';

/* ── POST /api/warroom/ekspedisi/sync — token auth, no JWT ── */
async function syncHandler(req, res) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { tanggal, data } = req.body;
    if (!tanggal || !Array.isArray(data)) {
      return res.status(400).json({ error: 'tanggal and data[] required' });
    }

    let count = 0;
    for (const r of data) {
      const id = String(r.id_outlet || '').trim();
      if (!id) continue;

      const trxApr = parseInt(r.trx_apr) || 0;
      const revApr = parseInt(r.rev_apr) || 0;
      const trxMei = parseInt(r.trx_mei) || 0;
      const revMei = parseInt(r.rev_mei) || 0;
      const trxJun = parseInt(r.trx_jun) || 0;
      const revJun = parseInt(r.rev_jun) || 0;

      const devTrxAprMei = trxMei - trxApr;
      const devRevAprMei = revMei - revApr;
      const devTrxMeiJun = trxJun - trxMei;
      const devRevMeiJun = revJun - revMei;
      const pctTrxGrowth = trxMei > 0 ? ((trxJun - trxMei) / trxMei * 100) : null;
      const pctRevGrowth = revMei > 0 ? ((revJun - revMei) / revMei * 100) : null;

      let status;
      if (trxApr === 0 && trxMei === 0 && trxJun > 0)     status = 'new';
      else if (trxJun === 0 && (trxApr > 0 || trxMei > 0)) status = 'churned';
      else if (devTrxMeiJun > 0)                            status = 'growing';
      else if (devTrxMeiJun < 0)                            status = 'declining';
      else                                                   status = 'stable';

      await pool.query(`
        INSERT INTO ekspedisi_snapshot
          (tanggal, id_outlet, trx_apr, rev_apr, trx_mei, rev_mei, trx_jun, rev_jun,
           dev_trx_apr_mei, dev_rev_apr_mei, dev_trx_mei_jun, dev_rev_mei_jun,
           pct_trx_growth, pct_rev_growth, status, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
        ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
          trx_apr=EXCLUDED.trx_apr, rev_apr=EXCLUDED.rev_apr,
          trx_mei=EXCLUDED.trx_mei, rev_mei=EXCLUDED.rev_mei,
          trx_jun=EXCLUDED.trx_jun, rev_jun=EXCLUDED.rev_jun,
          dev_trx_apr_mei=EXCLUDED.dev_trx_apr_mei, dev_rev_apr_mei=EXCLUDED.dev_rev_apr_mei,
          dev_trx_mei_jun=EXCLUDED.dev_trx_mei_jun, dev_rev_mei_jun=EXCLUDED.dev_rev_mei_jun,
          pct_trx_growth=EXCLUDED.pct_trx_growth, pct_rev_growth=EXCLUDED.pct_rev_growth,
          status=EXCLUDED.status, synced_at=NOW()
      `, [tanggal, id, trxApr, revApr, trxMei, revMei, trxJun, revJun,
          devTrxAprMei, devRevAprMei, devTrxMeiJun, devRevMeiJun,
          pctTrxGrowth, pctRevGrowth, status]);
      count++;
    }

    res.json({ success: true, rows: count, tanggal });
  } catch (e) {
    console.error('ekspedisi sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── GET /api/warroom/ekspedisi/analytics — requires JWT ── */
async function analyticsHandler(req, res) {
  try {
    let { tanggal } = req.query;
    if (!tanggal) {
      const r = await pool.query('SELECT MAX(tanggal) AS t FROM ekspedisi_snapshot');
      tanggal = r.rows[0]?.t;
    }
    if (!tanggal) return res.json({ tanggal: null, summary: {}, status_counts: {} });

    const [
      sumRes, statusRes,
      top10TrxRes, top10RevRes,
      top20GrowthRes, top20DeclineRes,
      newRes, churnedRes,
      monthlyRes, distRes, scatterRes,
      actDropRes, actGrowthRes, actNewRes, actChurnedRes,
      outletAllRes, anomaliRes,
    ] = await Promise.all([
      // 1. Summary
      pool.query(`
        SELECT
          COUNT(*)                                               AS total_outlet,
          SUM(CASE WHEN trx_jun > 0 THEN 1 ELSE 0 END)         AS total_aktif_jun,
          COALESCE(SUM(trx_jun), 0)                             AS total_trx_jun,
          COALESCE(SUM(rev_jun), 0)                             AS total_rev_jun,
          COALESCE(SUM(trx_mei), 0)                             AS total_trx_mei,
          COALESCE(SUM(rev_mei), 0)                             AS total_rev_mei,
          COALESCE(SUM(trx_apr), 0)                             AS total_trx_apr,
          COALESCE(SUM(rev_apr), 0)                             AS total_rev_apr,
          COUNT(*) FILTER (WHERE status = 'new')                AS total_new,
          COUNT(*) FILTER (WHERE status = 'churned')            AS total_churned,
          EXTRACT(DAY FROM $1::date)                            AS hari_berjalan
        FROM ekspedisi_snapshot WHERE tanggal = $1
      `, [tanggal]),

      // 2. Status counts
      pool.query(`
        SELECT status, COUNT(*) AS cnt
        FROM ekspedisi_snapshot WHERE tanggal=$1 GROUP BY status
      `, [tanggal]),

      // 3. Top 10 TRX Jun
      pool.query(`
        SELECT id_outlet, trx_jun, rev_jun, dev_trx_mei_jun, pct_trx_growth
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND trx_jun > 0
        ORDER BY trx_jun DESC LIMIT 10
      `, [tanggal]),

      // 4. Top 10 Rev Jun
      pool.query(`
        SELECT id_outlet, trx_jun, rev_jun, dev_rev_mei_jun, pct_rev_growth
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND rev_jun > 0
        ORDER BY rev_jun DESC LIMIT 10
      `, [tanggal]),

      // 5. Top 20 Growth TRX
      pool.query(`
        SELECT id_outlet, trx_mei, trx_jun, dev_trx_mei_jun, pct_trx_growth, rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND dev_trx_mei_jun > 0
        ORDER BY dev_trx_mei_jun DESC LIMIT 20
      `, [tanggal]),

      // 6. Top 20 Decline TRX
      pool.query(`
        SELECT id_outlet, trx_mei, trx_jun, dev_trx_mei_jun, pct_trx_growth, rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND dev_trx_mei_jun < 0
        ORDER BY dev_trx_mei_jun ASC LIMIT 20
      `, [tanggal]),

      // 7. New outlets
      pool.query(`
        SELECT id_outlet, trx_jun, rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='new'
        ORDER BY trx_jun DESC
      `, [tanggal]),

      // 8. Churned outlets
      pool.query(`
        SELECT id_outlet, trx_apr, trx_mei, rev_apr, rev_mei
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='churned'
        ORDER BY trx_mei DESC
      `, [tanggal]),

      // 9. Monthly trend
      pool.query(`
        SELECT
          COALESCE(SUM(trx_apr), 0) AS trx_apr, COALESCE(SUM(rev_apr), 0) AS rev_apr,
          COALESCE(SUM(trx_mei), 0) AS trx_mei, COALESCE(SUM(rev_mei), 0) AS rev_mei,
          COALESCE(SUM(trx_jun), 0) AS trx_jun, COALESCE(SUM(rev_jun), 0) AS rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1
      `, [tanggal]),

      // 10. TRX distribution
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE trx_jun BETWEEN 1 AND 5)    AS range_1_5,
          COUNT(*) FILTER (WHERE trx_jun BETWEEN 6 AND 20)   AS range_6_20,
          COUNT(*) FILTER (WHERE trx_jun BETWEEN 21 AND 100) AS range_21_100,
          COUNT(*) FILTER (WHERE trx_jun > 100)              AS range_gt100
        FROM ekspedisi_snapshot WHERE tanggal=$1
      `, [tanggal]),

      // 11. Scatter data (max 2000 aktif)
      pool.query(`
        SELECT id_outlet, trx_jun, rev_jun, status
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND trx_jun > 0
        ORDER BY trx_jun DESC LIMIT 2000
      `, [tanggal]),

      // 12. Action: drop (declining worst)
      pool.query(`
        SELECT id_outlet, trx_mei, trx_jun, dev_trx_mei_jun, pct_trx_growth, rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='declining'
        ORDER BY dev_trx_mei_jun ASC LIMIT 50
      `, [tanggal]),

      // 13. Action: growth (growing best)
      pool.query(`
        SELECT id_outlet, trx_mei, trx_jun, dev_trx_mei_jun, pct_trx_growth, rev_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='growing'
        ORDER BY dev_trx_mei_jun DESC LIMIT 50
      `, [tanggal]),

      // 14. Action: new outlets
      pool.query(`
        SELECT id_outlet, trx_jun, rev_jun, dev_trx_mei_jun, pct_trx_growth
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='new'
        ORDER BY trx_jun DESC LIMIT 50
      `, [tanggal]),

      // 15. Action: churned outlets
      pool.query(`
        SELECT id_outlet, trx_apr, trx_mei, rev_mei, dev_trx_mei_jun
        FROM ekspedisi_snapshot WHERE tanggal=$1 AND status='churned'
        ORDER BY trx_mei DESC LIMIT 50
      `, [tanggal]),

      // 16. All outlets for detail tab
      pool.query(`
        SELECT id_outlet, trx_apr, trx_mei, trx_jun, rev_jun,
               dev_trx_mei_jun, dev_rev_mei_jun, pct_trx_growth, status
        FROM ekspedisi_snapshot WHERE tanggal=$1
        ORDER BY trx_jun DESC LIMIT 5000
      `, [tanggal]),

      // 17. Anomali: TRX naik tapi revenue turun
      pool.query(`
        SELECT id_outlet, trx_mei, trx_jun, rev_mei, rev_jun,
               dev_trx_mei_jun, dev_rev_mei_jun
        FROM ekspedisi_snapshot
        WHERE tanggal=$1 AND dev_trx_mei_jun > 0 AND dev_rev_mei_jun < 0
        ORDER BY dev_trx_mei_jun DESC
      `, [tanggal]),
    ]);

    const s     = sumRes.rows[0];
    const trxJun = Number(s.total_trx_jun);
    const trxMei = Number(s.total_trx_mei);
    const revJun = Number(s.total_rev_jun);
    const revMei = Number(s.total_rev_mei);

    const statusCounts = {};
    statusRes.rows.forEach(r => { statusCounts[r.status] = Number(r.cnt); });

    const mt   = monthlyRes.rows[0];
    const dist = distRes.rows[0];

    res.json({
      tanggal,
      summary: {
        total_outlet   : Number(s.total_outlet),
        total_aktif_jun: Number(s.total_aktif_jun),
        total_trx_jun  : trxJun,
        total_rev_jun  : revJun,
        total_trx_mei  : trxMei,
        total_rev_mei  : revMei,
        pct_growth_trx : trxMei > 0 ? ((trxJun - trxMei) / trxMei * 100) : 0,
        pct_growth_rev : revMei > 0 ? ((revJun - revMei) / revMei * 100) : 0,
        avg_rev_per_trx: trxJun > 0 ? (revJun / trxJun) : 0,
        total_new      : Number(s.total_new),
        total_churned  : Number(s.total_churned),
        hari_berjalan  : Number(s.hari_berjalan),
      },
      status_counts: statusCounts,
      top10_trx_jun    : top10TrxRes.rows,
      top10_rev_jun    : top10RevRes.rows,
      top20_growth_trx : top20GrowthRes.rows,
      top20_decline_trx: top20DeclineRes.rows,
      new_outlets      : newRes.rows,
      churned_outlets  : churnedRes.rows,
      monthly_trend: [
        { month: 'Apr',       total_trx: Number(mt.trx_apr), total_rev: Number(mt.rev_apr) },
        { month: 'Mei',       total_trx: Number(mt.trx_mei), total_rev: Number(mt.rev_mei) },
        { month: 'Jun (d-1)', total_trx: Number(mt.trx_jun), total_rev: Number(mt.rev_jun) },
      ],
      trx_distribution: [
        { range: '1-5',    count: Number(dist.range_1_5)     },
        { range: '6-20',   count: Number(dist.range_6_20)    },
        { range: '21-100', count: Number(dist.range_21_100)  },
        { range: '>100',   count: Number(dist.range_gt100)   },
      ],
      scatter_data  : scatterRes.rows,
      action_drop   : actDropRes.rows,
      action_growth : actGrowthRes.rows,
      action_new    : actNewRes.rows,
      action_churned: actChurnedRes.rows,
      outlet_all    : outletAllRes.rows,
      anomali       : anomaliRes.rows,
    });
  } catch (e) {
    console.error('ekspedisi analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { syncHandler, analyticsHandler };
