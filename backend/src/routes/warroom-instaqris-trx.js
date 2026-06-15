const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

/* ── Segmentation SQL (reused in analytics + export) ── */
const SEG_SQL = `
  CASE
    WHEN total_transaction = 0 OR last_transaction_date IS NULL THEN 'new_merchant'
    WHEN (CURRENT_DATE - last_transaction_date::date) > 45 THEN 'churn'
    WHEN (CURRENT_DATE - last_transaction_date::date) BETWEEN 31 AND 45 THEN 'dormant'
    WHEN (CURRENT_DATE - last_transaction_date::date) BETWEEN 14 AND 30 THEN 'declining'
    WHEN (CURRENT_DATE - last_transaction_date::date) <= 7
         AND COALESCE(avg_daily_transactions,
               CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
                 THEN total_transaction::float / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
                 ELSE 0 END) >= 1.0
         THEN 'high_density'
    WHEN (CURRENT_DATE - last_transaction_date::date) <= 7
         AND COALESCE(avg_daily_transactions,
               CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
                 THEN total_transaction::float / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
                 ELSE 0 END) >= 0.3
         THEN 'daily_active'
    WHEN total_transaction >= 3 AND (CURRENT_DATE - last_transaction_date::date) <= 14
         THEN 'repeat_scan'
    ELSE 'activated'
  END
`;

const TERRITORY_SQL = `
  CASE
    WHEN province LIKE '%Jawa%' OR province LIKE '%DKI%' OR province LIKE '%Banten%' OR province LIKE '%Yogyakarta%' THEN 'Jawa'
    WHEN province LIKE '%Sumatera%' OR province LIKE '%Riau%' OR province LIKE '%Jambi%'
      OR province LIKE '%Bengkulu%' OR province LIKE '%Lampung%' OR province LIKE '%Bangka%'
      OR province LIKE '%Aceh%' THEN 'Sumatera'
    WHEN province LIKE '%Kalimantan%' THEN 'Kalimantan'
    WHEN province LIKE '%Sulawesi%' THEN 'Sulawesi'
    WHEN province LIKE '%Bali%' OR province LIKE '%Nusa%' THEN 'Bali & Nusa Tenggara'
    WHEN province LIKE '%Maluku%' THEN 'Maluku'
    WHEN province LIKE '%Papua%' THEN 'Papua'
    ELSE 'Lainnya'
  END
`;

/* ── SYNC ── */
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { merchants } = req.body;
  if (!Array.isArray(merchants) || merchants.length === 0) {
    return res.status(400).json({ error: 'merchants array required' });
  }

  let count = 0;
  for (const m of merchants) {
    if (!m.merchant_id || !m.bulan) continue;
    await pool.query(`
      INSERT INTO instaqris_trx_merchant
        (merchant_id, merchant_name, category, city, province, bulan,
         qris_terbit, total_transaction, first_transaction_date, last_transaction_date,
         avg_daily_transactions, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (merchant_id, bulan) DO UPDATE SET
        merchant_name          = EXCLUDED.merchant_name,
        category               = EXCLUDED.category,
        city                   = EXCLUDED.city,
        province               = EXCLUDED.province,
        qris_terbit            = EXCLUDED.qris_terbit,
        total_transaction      = EXCLUDED.total_transaction,
        first_transaction_date = EXCLUDED.first_transaction_date,
        last_transaction_date  = EXCLUDED.last_transaction_date,
        avg_daily_transactions = EXCLUDED.avg_daily_transactions,
        synced_at              = NOW()
    `, [
      String(m.merchant_id),
      m.merchant_name  || null,
      m.category       || null,
      m.city           || null,
      m.province       || null,
      m.bulan,
      m.qris_terbit              || null,
      parseInt(m.total_transaction) || 0,
      m.first_transaction_date   || null,
      m.last_transaction_date    || null,
      m.avg_daily_transactions != null ? parseFloat(m.avg_daily_transactions) : null,
    ]);
    count++;
  }

  res.json({ ok: true, count });
}

/* ── ANALYTICS ── */
async function analyticsHandler(req, res) {
  const { bulan } = req.query;
  const w = bulan ? 'WHERE bulan = $1' : '';
  const p = bulan ? [bulan] : [];

  try {
    const [sumR, segR, provR, cohortR, topR, catR, syncR] = await Promise.all([

      // Summary KPIs
      pool.query(`
        SELECT
          COUNT(*)                                                                        AS total,
          SUM(total_transaction)                                                          AS total_trx,
          ROUND(AVG(total_transaction)::numeric, 1)                                       AS avg_trx,
          SUM(CASE WHEN total_transaction > 0 THEN 1 ELSE 0 END)                         AS activated,
          SUM(CASE WHEN last_transaction_date IS NOT NULL
                    AND (CURRENT_DATE - last_transaction_date::date) <= 7 THEN 1 ELSE 0 END) AS active_7d,
          SUM(CASE WHEN total_transaction = 0 OR last_transaction_date IS NULL THEN 1 ELSE 0 END) AS new_merchant,
          SUM(CASE WHEN (CURRENT_DATE - last_transaction_date::date) > 45 THEN 1 ELSE 0 END)     AS churned
        FROM instaqris_trx_merchant ${w}
      `, p),

      // Segmentation
      pool.query(`
        SELECT (${SEG_SQL}) AS segment, COUNT(*) AS count
        FROM instaqris_trx_merchant ${w}
        GROUP BY segment ORDER BY count DESC
      `, p),

      // Province top 15
      pool.query(`
        SELECT province, COUNT(*) AS merchant_count, SUM(total_transaction) AS total_trx
        FROM instaqris_trx_merchant ${w}
        GROUP BY province ORDER BY merchant_count DESC LIMIT 15
      `, p),

      // Monthly cohort
      pool.query(`
        SELECT
          bulan,
          COUNT(*) AS total,
          SUM(total_transaction) AS total_trx,
          SUM(CASE WHEN total_transaction > 0 THEN 1 ELSE 0 END) AS activated,
          SUM(CASE WHEN total_transaction >= 3 THEN 1 ELSE 0 END) AS repeat_or_more,
          ROUND(AVG(total_transaction)::numeric, 1) AS avg_trx
        FROM instaqris_trx_merchant
        GROUP BY bulan ORDER BY bulan
      `),

      // Top 20 merchants by TRX
      pool.query(`
        SELECT merchant_id, merchant_name, category, city, province, bulan,
               total_transaction,
               TO_CHAR(last_transaction_date, 'YYYY-MM-DD') AS last_trx,
               (${SEG_SQL}) AS segment
        FROM instaqris_trx_merchant
        WHERE total_transaction > 0 ${bulan ? 'AND bulan = $1' : ''}
        ORDER BY total_transaction DESC LIMIT 20
      `, p),

      // Top category (MCC)
      pool.query(`
        SELECT category, COUNT(*) AS merchant_count, SUM(total_transaction) AS total_trx
        FROM instaqris_trx_merchant ${w}
        GROUP BY category ORDER BY merchant_count DESC LIMIT 10
      `, p),

      // Last sync
      pool.query('SELECT MAX(synced_at) AS last_sync, COUNT(DISTINCT bulan) AS bulan_count FROM instaqris_trx_merchant'),
    ]);

    res.json({
      summary:       sumR.rows[0],
      segments:      segR.rows,
      provinces:     provR.rows,
      cohorts:       cohortR.rows,
      top_merchants: topR.rows,
      categories:    catR.rows,
      last_sync:     syncR.rows[0]?.last_sync,
    });
  } catch (err) {
    console.error('instaqris-trx analytics:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ── EXPORT ── */
async function exportHandler(req, res) {
  const { type, bulan } = req.query;
  const w = bulan ? 'WHERE bulan = $1' : '';
  const p = bulan ? [bulan] : [];

  try {
    let rows, headers, filename;

    if (type === 'transaksi') {
      const r = await pool.query(`
        SELECT
          merchant_id,
          merchant_name,
          category,
          city,
          province,
          TO_CHAR(qris_terbit, 'YYYY-MM-DD')            AS onboarding_date,
          TO_CHAR(first_transaction_date, 'YYYY-MM-DD') AS first_transaction_date,
          TO_CHAR(last_transaction_date, 'YYYY-MM-DD')  AS last_transaction_date,
          ROUND(COALESCE(avg_daily_transactions,
            CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
              THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
              ELSE 0 END)::numeric, 2)                   AS avg_daily_transactions,
          total_transaction                              AS avg_monthly_volume,
          ROUND(LEAST(COALESCE(avg_daily_transactions,
            CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
              THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
              ELSE 0 END) * 20, 100)::numeric, 1)        AS transaction_density_score,
          0                                              AS buyer_repeat_rate,
          (${SEG_SQL})                                   AS merchant_status,
          (${TERRITORY_SQL})                             AS territory_cluster,
          ''                                             AS owner,
          ''                                             AS notes
        FROM instaqris_trx_merchant ${w}
        ORDER BY total_transaction DESC
      `, p);
      rows = r.rows;
      headers = ['merchant_id','merchant_name','category','city','province','onboarding_date','first_transaction_date','last_transaction_date','avg_daily_transactions','avg_monthly_volume','transaction_density_score','buyer_repeat_rate','merchant_status','territory_cluster','owner','notes'];
      filename = 'data_transaksi';

    } else if (type === 'segmentasi') {
      const r = await pool.query(`
        SELECT
          (${SEG_SQL})                                   AS segment,
          merchant_id,
          merchant_name,
          category,
          city,
          province,
          bulan,
          total_transaction,
          TO_CHAR(last_transaction_date, 'YYYY-MM-DD')  AS last_transaction_date,
          COALESCE(CURRENT_DATE - last_transaction_date::date, 999) AS days_since_last_trx
        FROM instaqris_trx_merchant ${w}
        ORDER BY segment, total_transaction DESC
      `, p);
      rows = r.rows;
      headers = ['segment','merchant_id','merchant_name','category','city','province','bulan','total_transaction','last_transaction_date','days_since_last_trx'];
      filename = 'data_segmentasi';

    } else if (type === 'behavior_score') {
      const r = await pool.query(`
        SELECT
          merchant_id,
          ROUND(LEAST(total_transaction::numeric * 5, 100), 1)            AS repeat_scan_score,
          CASE WHEN total_transaction > 0 THEN 80 ELSE 0 END               AS buyer_conversion_score,
          CASE WHEN total_transaction > 0 THEN 100 ELSE 0 END              AS merchant_activation_score,
          ROUND(LEAST(COALESCE(avg_daily_transactions,
            CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
              THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
              ELSE 0 END) * 20, 100)::numeric, 1)                          AS transaction_density_score,
          ROUND(GREATEST(0, 100 - COALESCE(
            CURRENT_DATE - last_transaction_date::date, 60)::numeric * 2), 1) AS retention_score,
          ROUND(LEAST(total_transaction::numeric * 3, 100), 1)             AS ecosystem_dependency_score,
          ROUND((
            LEAST(total_transaction::numeric * 5, 100) * 0.25 +
            CASE WHEN total_transaction > 0 THEN 100 ELSE 0 END * 0.15 +
            LEAST(COALESCE(avg_daily_transactions,
              CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
                THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
                ELSE 0 END) * 20, 100) * 0.25 +
            GREATEST(0, 100 - COALESCE(CURRENT_DATE - last_transaction_date::date, 60)::numeric * 2) * 0.20 +
            LEAST(total_transaction::numeric * 3, 100) * 0.15
          )::numeric, 1)                                                    AS final_priority_score
        FROM instaqris_trx_merchant ${w}
        ORDER BY final_priority_score DESC
      `, p);
      rows = r.rows;
      headers = ['merchant_id','repeat_scan_score','buyer_conversion_score','merchant_activation_score','transaction_density_score','retention_score','ecosystem_dependency_score','final_priority_score'];
      filename = 'merchant_behavior_score';

    } else {
      return res.status(400).json({ error: 'type must be: transaksi | segmentasi | behavior_score' });
    }

    res.json({ filename, headers, rows });
  } catch (err) {
    console.error('instaqris-trx export:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ── MERCHANTS (full list with computed fields for client-side filter/sort) ── */
async function merchantsHandler(req, res) {
  const { bulan } = req.query;
  const w = bulan ? 'WHERE bulan = $1' : '';
  const p = bulan ? [bulan] : [];
  try {
    const result = await pool.query(`
      SELECT
        merchant_id,
        merchant_name,
        category,
        city,
        province,
        bulan,
        TO_CHAR(qris_terbit, 'YYYY-MM-DD') AS qris_terbit,
        total_transaction,
        TO_CHAR(first_transaction_date, 'YYYY-MM-DD') AS first_transaction_date,
        TO_CHAR(last_transaction_date,  'YYYY-MM-DD') AS last_transaction_date,
        COALESCE(CURRENT_DATE - last_transaction_date::date, 9999)::int AS days_since_last_trx,
        COALESCE(CURRENT_DATE - COALESCE(qris_terbit, first_transaction_date)::date, 0)::int AS days_since_register,
        ROUND(COALESCE(avg_daily_transactions,
          CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
            THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
            ELSE 0 END)::numeric, 4) AS computed_daily_rate,
        (${SEG_SQL}) AS segment,
        (${TERRITORY_SQL}) AS territory_cluster,
        ROUND(LEAST(total_transaction::numeric * 5, 100), 1) AS repeat_scan_score,
        CASE WHEN total_transaction > 0 THEN 80 ELSE 0 END AS buyer_conversion_score,
        CASE WHEN total_transaction > 0 THEN 100 ELSE 0 END AS merchant_activation_score,
        ROUND(LEAST(COALESCE(avg_daily_transactions,
          CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
            THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
            ELSE 0 END) * 20, 100)::numeric, 1) AS transaction_density_score,
        ROUND(GREATEST(0, 100 - COALESCE(
          CURRENT_DATE - last_transaction_date::date, 60)::numeric * 2), 1) AS retention_score,
        ROUND(LEAST(total_transaction::numeric * 3, 100), 1) AS ecosystem_dependency_score,
        ROUND((
          LEAST(total_transaction::numeric * 5, 100) * 0.25 +
          CASE WHEN total_transaction > 0 THEN 100 ELSE 0 END * 0.15 +
          LEAST(COALESCE(avg_daily_transactions,
            CASE WHEN qris_terbit IS NOT NULL AND total_transaction > 0
              THEN total_transaction::numeric / GREATEST(CURRENT_DATE - qris_terbit::date, 1)
              ELSE 0 END) * 20, 100) * 0.25 +
          GREATEST(0, 100 - COALESCE(CURRENT_DATE - last_transaction_date::date, 60)::numeric * 2) * 0.20 +
          LEAST(total_transaction::numeric * 3, 100) * 0.15
        )::numeric, 1) AS final_priority_score
      FROM instaqris_trx_merchant ${w}
      ORDER BY total_transaction DESC, merchant_id
    `, p);
    res.json({ merchants: result.rows, total: result.rows.length, bulan: bulan || null });
  } catch (err) {
    console.error('instaqris-trx merchants:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, exportHandler, merchantsHandler };
