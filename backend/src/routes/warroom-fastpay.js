const pool = require('../db');

// Part 2A: baca dari env dulu, fallback ke nilai lama agar Apps Script existing tidak putus.
const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret';

const CHUNK = 500; // 500 baris x N kolom, aman < 65535 params

/* ─────────────────────────────────────────────
   Helper: compute status dari nilai prev/curr GENERIK (bukan lagi
   mei/jun hardcode) -- rumus SAMA PERSIS dgn versi lama, cuma nama
   variabel yg berubah supaya berlaku utk pasangan bulan apa pun.
───────────────────────────────────────────── */
function computeStatus(trxPrev, trxCurr, pctTrxGrowth, devTrx) {
  if (trxPrev > 0 && trxCurr === 0)                                return 'churned';
  if (trxPrev === 0 && trxCurr > 0)                                return 'new';
  if (trxPrev > 0 && pctTrxGrowth >= 50 && devTrx >= 20)           return 'rocket';
  if (trxPrev > 0 && devTrx > 0)                                    return 'growing';
  if (trxPrev > 0 && devTrx < 0)                                    return 'declining';
  return 'stable';
}

async function upsertChunk(bulan, rows) {
  if (!rows.length) return;

  const idOutlets = [], trxPrevs = [], revPrevs   = [];
  const trxCurrs  = [], revCurrs = [], devTrxs     = [];
  const devRevs   = [], pctTrxs  = [], pctRevs     = [];
  const avgRevPrevs = [], avgRevCurrs = [], statuses = [];

  for (const row of rows) {
    const trxPrev = parseInt(row.trx_prev) || 0;
    const trxCurr = parseInt(row.trx_curr) || 0;
    const revPrev = parseInt(row.rev_prev) || 0;
    const revCurr = parseInt(row.rev_curr) || 0;

    const devTrx = trxCurr - trxPrev;
    const devRev = revCurr - revPrev;
    const pctTrxGrowth = trxPrev > 0 ? ((devTrx / trxPrev) * 100) : (trxCurr > 0 ? 100 : 0);
    const pctRevGrowth = revPrev > 0 ? ((devRev / revPrev) * 100) : (revCurr > 0 ? 100 : 0);
    const avgRevPrev = trxPrev > 0 ? Math.round(revPrev / trxPrev) : 0;
    const avgRevCurr = trxCurr > 0 ? Math.round(revCurr / trxCurr) : 0;
    const status = computeStatus(trxPrev, trxCurr, pctTrxGrowth, devTrx);

    idOutlets.push(String(row.id_outlet || '').trim());
    trxPrevs.push(trxPrev); revPrevs.push(revPrev);
    trxCurrs.push(trxCurr); revCurrs.push(revCurr);
    devTrxs.push(devTrx);   devRevs.push(devRev);
    pctTrxs.push(parseFloat(pctTrxGrowth.toFixed(2)));
    pctRevs.push(parseFloat(pctRevGrowth.toFixed(2)));
    avgRevPrevs.push(avgRevPrev);
    avgRevCurrs.push(avgRevCurr);
    statuses.push(status);
  }

  await pool.query(
    `INSERT INTO warroom_fastpay_outlet
       (bulan, id_outlet, trx_prev, rev_prev, trx_curr, rev_curr,
        dev_trx, dev_rev, pct_trx_growth, pct_rev_growth,
        avg_rev_per_trx_prev, avg_rev_per_trx_curr, status, synced_at)
     SELECT $1,
       unnest($2::varchar[]), unnest($3::int[]),  unnest($4::bigint[]),
       unnest($5::int[]),     unnest($6::bigint[]),
       unnest($7::int[]),     unnest($8::bigint[]),
       unnest($9::numeric[]), unnest($10::numeric[]),
       unnest($11::bigint[]), unnest($12::bigint[]),
       unnest($13::varchar[]), NOW()
     ON CONFLICT (bulan, id_outlet) DO UPDATE SET
       trx_prev             = EXCLUDED.trx_prev,
       rev_prev             = EXCLUDED.rev_prev,
       trx_curr             = EXCLUDED.trx_curr,
       rev_curr             = EXCLUDED.rev_curr,
       dev_trx              = EXCLUDED.dev_trx,
       dev_rev              = EXCLUDED.dev_rev,
       pct_trx_growth       = EXCLUDED.pct_trx_growth,
       pct_rev_growth       = EXCLUDED.pct_rev_growth,
       avg_rev_per_trx_prev = EXCLUDED.avg_rev_per_trx_prev,
       avg_rev_per_trx_curr = EXCLUDED.avg_rev_per_trx_curr,
       status               = EXCLUDED.status,
       synced_at            = NOW()`,
    [bulan, idOutlets, trxPrevs, revPrevs, trxCurrs, revCurrs,
     devTrxs, devRevs, pctTrxs, pctRevs, avgRevPrevs, avgRevCurrs, statuses]
  );
}

/* ─────────────────────────────────────────────
   POST /api/warroom/fastpay/sync
   Token auth (Bearer, sama seperti sebelumnya) -- dipanggil Apps Script.
   Body BARU (breaking change dari versi lama): { bulan: 'YYYY-MM',
   data: [{ id_outlet, trx_prev, rev_prev, trx_curr, rev_curr }] }.
   `tanggal` (versi lama) TIDAK dipakai lagi -- `bulan` menggantikannya
   sbg identitas periode data (bukan tanggal eksekusi sync).
───────────────────────────────────────────── */
async function syncHandler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${SYNC_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { bulan, data } = req.body;
  if (!bulan || !/^\d{4}-\d{2}$/.test(bulan)) {
    return res.status(400).json({ error: 'bulan wajib diisi, format YYYY-MM' });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Body tidak valid. Perlu data[]' });
  }

  const raw = data.filter(o => o.id_outlet);
  if (!raw.length) return res.json({ success: true, upserted: 0, bulan });

  // Dedup by id_outlet -- ON CONFLICT gagal kalau 2 baris sama masuk 1 chunk unnest.
  const seen = new Map();
  for (const o of raw) seen.set(String(o.id_outlet).trim(), o);
  const valid = [...seen.values()];

  res.json({ success: true, upserted: valid.length, bulan, chunks: Math.ceil(valid.length / CHUNK) });

  setImmediate(async () => {
    try {
      for (let i = 0; i < valid.length; i += CHUNK) await upsertChunk(bulan, valid.slice(i, i + CHUNK));
      console.log(`[fastpay sync] done: ${valid.length} outlets, bulan ${bulan}`);
    } catch (err) {
      console.error(`[fastpay sync] error bulan ${bulan}:`, err.message);
    }
  });
}

/* ─────────────────────────────────────────────
   GET /api/warroom/fastpay/analytics?bulan=YYYY-MM
   requireAuth -- dipanggil frontend. bulan opsional, default bulan
   terbaru yang ada datanya (bulan_list dikirim utk dropdown).
───────────────────────────────────────────── */
async function analyticsHandler(req, res) {
  try {
    const blRes = await pool.query(`SELECT DISTINCT bulan FROM warroom_fastpay_outlet ORDER BY bulan DESC`);
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });

    let { bulan } = req.query;
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const [
      metaRes, summaryRes, statusRes,
      top15TrxRes, top15RevRes,
      top15GrowthTrxRes, top15DeclineTrxRes, top15GrowthRevRes,
      newRes, churnedRes, rocketRes,
      prefixRes, trxDistRes, scatterRes, anomaliRes
    ] = await Promise.all([
      pool.query(
        `SELECT bulan, COUNT(*) AS total_outlets, MAX(synced_at) AS last_sync
         FROM warroom_fastpay_outlet WHERE bulan = $1 GROUP BY bulan`, [bulan]
      ),
      pool.query(
        `SELECT
           SUM(trx_prev) AS total_trx_prev, SUM(trx_curr) AS total_trx_curr,
           SUM(rev_prev) AS total_rev_prev, SUM(rev_curr) AS total_rev_curr,
           SUM(dev_trx) AS dev_trx,         SUM(dev_rev) AS dev_rev,
           COUNT(CASE WHEN trx_curr > 0 THEN 1 END) AS active_curr,
           COUNT(CASE WHEN trx_prev > 0 THEN 1 END) AS active_prev,
           ROUND(AVG(CASE WHEN trx_prev > 0 THEN avg_rev_per_trx_curr END)) AS avg_rev_per_trx
         FROM warroom_fastpay_outlet WHERE bulan = $1`, [bulan]
      ),
      pool.query(`SELECT status, COUNT(*) AS cnt FROM warroom_fastpay_outlet WHERE bulan = $1 GROUP BY status`, [bulan]),
      pool.query(
        `SELECT id_outlet, trx_prev, trx_curr, dev_trx, pct_trx_growth, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 ORDER BY trx_curr DESC LIMIT 15`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, rev_prev, rev_curr, dev_rev, pct_rev_growth, trx_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 ORDER BY rev_curr DESC LIMIT 15`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_prev, trx_curr, dev_trx, pct_trx_growth, rev_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND status IN ('rocket','growing')
         ORDER BY pct_trx_growth DESC LIMIT 15`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_prev, trx_curr, dev_trx, pct_trx_growth, rev_prev, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND status = 'declining'
         ORDER BY dev_trx ASC LIMIT 15`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, rev_prev, rev_curr, dev_rev, pct_rev_growth, trx_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND dev_rev > 0
         ORDER BY dev_rev DESC LIMIT 15`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_curr, rev_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND status = 'new'
         ORDER BY trx_curr DESC LIMIT 50`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_prev, rev_prev, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND status = 'churned'
         ORDER BY rev_prev DESC LIMIT 50`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_prev, trx_curr, dev_trx, pct_trx_growth, rev_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND status = 'rocket'
         ORDER BY pct_trx_growth DESC LIMIT 50`, [bulan]
      ),
      pool.query(
        `SELECT SUBSTRING(id_outlet, 1, 3) AS prefix,
           COUNT(*) AS total_outlets, SUM(trx_curr) AS total_trx_curr, SUM(rev_curr) AS total_rev_curr,
           COUNT(CASE WHEN trx_curr > 0 THEN 1 END) AS active_curr
         FROM warroom_fastpay_outlet WHERE bulan = $1
         GROUP BY SUBSTRING(id_outlet, 1, 3) ORDER BY total_trx_curr DESC LIMIT 20`, [bulan]
      ),
      pool.query(
        `SELECT
           CASE
             WHEN trx_curr = 0     THEN '0 (Inactive)'
             WHEN trx_curr BETWEEN 1  AND 5   THEN '1-5'
             WHEN trx_curr BETWEEN 6  AND 20  THEN '6-20'
             WHEN trx_curr BETWEEN 21 AND 50  THEN '21-50'
             WHEN trx_curr BETWEEN 51 AND 100 THEN '51-100'
             WHEN trx_curr BETWEEN 101 AND 500 THEN '101-500'
             ELSE '501+'
           END AS bucket, COUNT(*) AS cnt
         FROM warroom_fastpay_outlet WHERE bulan = $1 GROUP BY bucket ORDER BY MIN(trx_curr)`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_curr, avg_rev_per_trx_curr, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND trx_curr > 0
         ORDER BY trx_curr DESC LIMIT 3000`, [bulan]
      ),
      pool.query(
        `SELECT id_outlet, trx_curr, rev_curr, trx_prev, rev_prev, status
         FROM warroom_fastpay_outlet WHERE bulan = $1 AND trx_curr > 0 AND rev_curr = 0
         ORDER BY trx_curr DESC LIMIT 100`, [bulan]
      ),
    ]);

    const status_counts = {};
    for (const r of statusRes.rows) status_counts[r.status] = parseInt(r.cnt);

    const s = summaryRes.rows[0] || {};
    const pct_dev_trx = s.total_trx_prev > 0 ? ((s.dev_trx / s.total_trx_prev) * 100).toFixed(2) : 0;
    const pct_dev_rev = s.total_rev_prev > 0 ? ((s.dev_rev / s.total_rev_prev) * 100).toFixed(2) : 0;

    res.json({
      bulan,
      bulan_list: bulanList,
      meta: {
        sync_date: metaRes.rows[0]?.last_sync || null,
        total_outlets: parseInt(metaRes.rows[0]?.total_outlets || 0),
      },
      summary: {
        total_trx_prev:  parseInt(s.total_trx_prev || 0),
        total_trx_curr:  parseInt(s.total_trx_curr || 0),
        total_rev_prev:  parseInt(s.total_rev_prev || 0),
        total_rev_curr:  parseInt(s.total_rev_curr || 0),
        dev_trx:         parseInt(s.dev_trx || 0),
        dev_rev:         parseInt(s.dev_rev || 0),
        pct_dev_trx:     parseFloat(pct_dev_trx),
        pct_dev_rev:     parseFloat(pct_dev_rev),
        active_curr:     parseInt(s.active_curr || 0),
        active_prev:     parseInt(s.active_prev || 0),
        avg_rev_per_trx: parseInt(s.avg_rev_per_trx || 0),
      },
      status_counts,
      top15_trx_curr:     top15TrxRes.rows,
      top15_rev_curr:     top15RevRes.rows,
      top15_growth_trx:   top15GrowthTrxRes.rows,
      top15_decline_trx:  top15DeclineTrxRes.rows,
      top15_growth_rev:   top15GrowthRevRes.rows,
      new_outlets:        newRes.rows,
      churned_outlets:    churnedRes.rows,
      rocket_outlets:     rocketRes.rows,
      prefix_breakdown:   prefixRes.rows,
      trx_distribution:   trxDistRes.rows,
      scatter_data:       scatterRes.rows,
      anomali_free_trx:   anomaliRes.rows,
    });
  } catch (err) {
    console.error('[fastpay analytics]', err.message);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────────────────────────────────
   GET /api/warroom/fastpay/outlets?bulan=YYYY-MM
   Server-side paginated outlet detail
───────────────────────────────────────────── */
async function outletsHandler(req, res) {
  try {
    const blRes = await pool.query(`SELECT DISTINCT bulan FROM warroom_fastpay_outlet ORDER BY bulan DESC`);
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ rows: [], total: 0, bulan_list: [] });

    let { bulan } = req.query;
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = req.query.status || 'all';
    const validCols = { trx_prev:1, trx_curr:1, rev_prev:1, rev_curr:1, dev_trx:1, dev_rev:1, pct_trx_growth:1, pct_rev_growth:1, avg_rev_per_trx_curr:1 };
    const col    = validCols[req.query.sortBy] ? req.query.sortBy : 'trx_curr';
    const dir    = req.query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const conditions = [`bulan = $1`];
    const params = [bulan];
    if (status !== 'all') { params.push(status); conditions.push(`status = $${params.length}`); }
    if (search)           { params.push(`%${search.toLowerCase()}%`); conditions.push(`LOWER(id_outlet) LIKE $${params.length}`); }

    const where = conditions.join(' AND ');
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM warroom_fastpay_outlet WHERE ${where}`, params),
      pool.query(
        `SELECT id_outlet, trx_prev, trx_curr, rev_prev, rev_curr,
                dev_trx, dev_rev, pct_trx_growth, pct_rev_growth,
                avg_rev_per_trx_prev, avg_rev_per_trx_curr, status
         FROM warroom_fastpay_outlet WHERE ${where}
         ORDER BY ${col} ${dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({ rows: dataRes.rows, total: parseInt(countRes.rows[0].count), page, limit, bulan, bulan_list: bulanList });
  } catch (err) {
    console.error('[fastpay outlets]', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, outletsHandler };
