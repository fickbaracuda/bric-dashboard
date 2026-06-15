const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

/* ── SYNC ── */
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { outlets } = req.body;
  if (!Array.isArray(outlets) || outlets.length === 0) {
    return res.status(400).json({ error: 'outlets array required' });
  }

  let count = 0;
  for (const o of outlets) {
    if (!o.id_outlet) continue;
    await pool.query(`
      INSERT INTO warroom_bumdes_outlet
        (id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet,
         nama_kota, tanggal_registrasi, tanggal_aktifasi,
         trx_mei, rev_mei, trx_juni, rev_juni, dev_trx, dev_rev, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (id_outlet) DO UPDATE SET
        upline=$2, nama_pemilik=$3, notelp_pemilik=$4, tipe_outlet=$5,
        nama_kota=$6, tanggal_registrasi=$7, tanggal_aktifasi=$8,
        trx_mei=$9, rev_mei=$10, trx_juni=$11, rev_juni=$12,
        dev_trx=$13, dev_rev=$14, synced_at=NOW()
    `, [
      String(o.id_outlet),
      o.upline              || null,
      o.nama_pemilik        || null,
      String(o.notelp_pemilik || ''),
      o.tipe_outlet         || null,
      o.nama_kota           || null,
      o.tanggal_registrasi  || null,
      o.tanggal_aktifasi    || null,
      parseInt(o.trx_mei)   || 0,
      parseFloat(o.rev_mei) || 0,
      parseInt(o.trx_juni)  || 0,
      parseFloat(o.rev_juni)|| 0,
      parseInt(o.dev_trx)   || 0,
      parseFloat(o.dev_rev) || 0,
    ]);
    count++;
  }
  res.json({ ok: true, count });
}

/* ── ANALYTICS ── */
async function analyticsHandler(req, res) {
  try {
    const [sumR, upR, kotaR, tipeR, syncR] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(trx_juni),0)                                                  AS total_trx_juni,
          COALESCE(SUM(rev_juni),0)                                                  AS total_rev_juni,
          COALESCE(SUM(trx_mei),0)                                                   AS total_trx_mei,
          COALESCE(SUM(rev_mei),0)                                                   AS total_rev_mei,
          COALESCE(SUM(CASE WHEN trx_mei=0 THEN trx_juni ELSE 0 END),0)             AS trx_new_mat,
          COALESCE(SUM(CASE WHEN trx_mei=0 THEN rev_juni ELSE 0 END),0)             AS rev_new_mat,
          COUNT(CASE WHEN trx_juni>0 THEN 1 END)                                    AS mat,
          COUNT(CASE WHEN trx_mei=0 AND trx_juni>0 THEN 1 END)                     AS nmat,
          COUNT(CASE WHEN trx_mei=0 AND trx_juni>100 THEN 1 END)                   AS nmat_min100,
          COUNT(CASE WHEN trx_juni>299 THEN 1 END)                                  AS mat_min300,
          COALESCE(SUM(dev_trx),0)                                                   AS dev_trx_total,
          COALESCE(SUM(dev_rev),0)                                                   AS dev_rev_total,
          COUNT(*)                                                                    AS total_outlet,
          COUNT(CASE WHEN dev_trx>0 AND trx_mei>0 THEN 1 END)                       AS growing,
          COUNT(CASE WHEN dev_trx<0 THEN 1 END)                                      AS declining,
          COUNT(CASE WHEN dev_trx=0 AND trx_mei>0 AND trx_juni>0 THEN 1 END)        AS stable,
          COUNT(CASE WHEN trx_mei>0 AND trx_juni=0 THEN 1 END)                       AS churned,
          COUNT(CASE WHEN trx_mei=0 AND trx_juni=0 THEN 1 END)                       AS belum_aktif,
          COUNT(CASE WHEN dev_trx>0 AND dev_rev<0 AND trx_mei>0 THEN 1 END)          AS anomali
        FROM warroom_bumdes_outlet
      `),
      pool.query(`
        SELECT upline,
          COUNT(*)                                                    AS outlet_count,
          COUNT(CASE WHEN trx_juni>0 THEN 1 END)                    AS mat,
          COALESCE(SUM(trx_juni),0)                                  AS trx_juni,
          COALESCE(SUM(rev_juni),0)                                  AS rev_juni,
          COALESCE(SUM(trx_mei),0)                                   AS trx_mei,
          COALESCE(SUM(dev_trx),0)                                   AS dev_trx,
          COALESCE(SUM(dev_rev),0)                                   AS dev_rev
        FROM warroom_bumdes_outlet
        WHERE upline IS NOT NULL AND upline!=''
        GROUP BY upline ORDER BY trx_juni DESC
      `),
      pool.query(`
        SELECT nama_kota,
          COUNT(*)                                                    AS outlet_count,
          COUNT(CASE WHEN trx_juni>0 THEN 1 END)                    AS mat,
          COALESCE(SUM(trx_juni),0)                                  AS trx_juni,
          COALESCE(SUM(rev_juni),0)                                  AS rev_juni,
          COALESCE(SUM(dev_trx),0)                                   AS dev_trx
        FROM warroom_bumdes_outlet
        WHERE nama_kota IS NOT NULL AND nama_kota!=''
        GROUP BY nama_kota ORDER BY trx_juni DESC LIMIT 20
      `),
      pool.query(`
        SELECT tipe_outlet,
          COUNT(*)                                                    AS outlet_count,
          COUNT(CASE WHEN trx_juni>0 THEN 1 END)                    AS mat,
          COALESCE(SUM(trx_juni),0)                                  AS trx_juni,
          COALESCE(SUM(rev_juni),0)                                  AS rev_juni
        FROM warroom_bumdes_outlet
        WHERE tipe_outlet IS NOT NULL AND tipe_outlet!=''
        GROUP BY tipe_outlet ORDER BY outlet_count DESC
      `),
      pool.query('SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total FROM warroom_bumdes_outlet'),
    ]);

    res.json({
      summary:   sumR.rows[0],
      uplines:   upR.rows,
      kotas:     kotaR.rows,
      tipes:     tipeR.rows,
      last_sync: syncR.rows[0]?.last_sync,
      total:     syncR.rows[0]?.total,
    });
  } catch (err) {
    console.error('bumdes analytics:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ── OUTLETS (all rows for client-side filter/sort) ── */
async function outletsHandler(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, nama_kota,
        TO_CHAR(tanggal_registrasi,'DD/MM/YYYY') AS tanggal_registrasi,
        TO_CHAR(tanggal_aktifasi,'DD/MM/YYYY')   AS tanggal_aktifasi,
        trx_mei, rev_mei, trx_juni, rev_juni, dev_trx, dev_rev,
        TO_CHAR(synced_at,'YYYY-MM-DD HH24:MI')  AS synced_at
      FROM warroom_bumdes_outlet
      ORDER BY trx_juni DESC, id_outlet
    `);
    res.json({ outlets: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('bumdes outlets:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, outletsHandler };
