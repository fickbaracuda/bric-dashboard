const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

/* â”€â”€ SYNC â”€â”€ */
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { outlets } = req.body;
  if (!Array.isArray(outlets) || outlets.length === 0) {
    return res.status(400).json({ error: 'outlets array required' });
  }

  const valid = outlets.filter(o => o.id_outlet);
  if (!valid.length) return res.json({ ok: true, count: 0 });

  const str = f => valid.map(o => { const v = f(o); return v != null ? String(v).trim() : null; });
  const int = f => valid.map(o => parseInt(f(o)) || 0);
  const flt = f => valid.map(o => parseFloat(f(o)) || 0);

  await pool.query(`
    INSERT INTO warroom_lpd_outlet
      (id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet,
       nama_kota, tanggal_registrasi, tanggal_aktifasi,
       trx_mei, rev_mei, trx_juni, rev_juni, dev_trx, dev_rev, synced_at)
    SELECT t.id_outlet, t.upline, t.nama_pemilik, t.notelp_pemilik, t.tipe_outlet,
           t.nama_kota, NULLIF(t.tgl_reg,'')::date, NULLIF(t.tgl_aktif,'')::date,
           t.trx_mei, t.rev_mei, t.trx_juni, t.rev_juni, t.dev_trx, t.dev_rev, NOW()
    FROM unnest(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
      $6::text[], $7::text[], $8::text[],
      $9::int[], $10::numeric[], $11::int[], $12::numeric[], $13::int[], $14::numeric[]
    ) AS t(id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet,
           nama_kota, tgl_reg, tgl_aktif,
           trx_mei, rev_mei, trx_juni, rev_juni, dev_trx, dev_rev)
    ON CONFLICT (id_outlet) DO UPDATE SET
      upline             = EXCLUDED.upline,
      nama_pemilik       = EXCLUDED.nama_pemilik,
      notelp_pemilik     = EXCLUDED.notelp_pemilik,
      tipe_outlet        = EXCLUDED.tipe_outlet,
      nama_kota          = EXCLUDED.nama_kota,
      tanggal_registrasi = EXCLUDED.tanggal_registrasi,
      tanggal_aktifasi   = EXCLUDED.tanggal_aktifasi,
      trx_mei            = EXCLUDED.trx_mei,
      rev_mei            = EXCLUDED.rev_mei,
      trx_juni           = EXCLUDED.trx_juni,
      rev_juni           = EXCLUDED.rev_juni,
      dev_trx            = EXCLUDED.dev_trx,
      dev_rev            = EXCLUDED.dev_rev,
      synced_at          = EXCLUDED.synced_at
  `, [
    str(o => o.id_outlet),
    str(o => o.upline || null),
    str(o => o.nama_pemilik || null),
    str(o => o.notelp_pemilik || ''),
    str(o => o.tipe_outlet || null),
    str(o => o.nama_kota || null),
    str(o => o.tanggal_registrasi || null),
    str(o => o.tanggal_aktifasi || null),
    int(o => o.trx_mei),
    flt(o => o.rev_mei),
    int(o => o.trx_juni),
    flt(o => o.rev_juni),
    int(o => o.dev_trx),
    flt(o => o.dev_rev),
  ]);

  res.json({ ok: true, count: valid.length });
}

/* â”€â”€ ANALYTICS â”€â”€ */
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
        FROM warroom_lpd_outlet
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
        FROM warroom_lpd_outlet
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
        FROM warroom_lpd_outlet
        WHERE nama_kota IS NOT NULL AND nama_kota!=''
        GROUP BY nama_kota ORDER BY trx_juni DESC LIMIT 20
      `),
      pool.query(`
        SELECT tipe_outlet,
          COUNT(*)                                                    AS outlet_count,
          COUNT(CASE WHEN trx_juni>0 THEN 1 END)                    AS mat,
          COALESCE(SUM(trx_juni),0)                                  AS trx_juni,
          COALESCE(SUM(rev_juni),0)                                  AS rev_juni
        FROM warroom_lpd_outlet
        WHERE tipe_outlet IS NOT NULL AND tipe_outlet!=''
        GROUP BY tipe_outlet ORDER BY outlet_count DESC
      `),
      pool.query('SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total FROM warroom_lpd_outlet'),
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

/* â”€â”€ OUTLETS (all rows for client-side filter/sort) â”€â”€ */
async function outletsHandler(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, nama_kota,
        TO_CHAR(tanggal_registrasi,'DD/MM/YYYY') AS tanggal_registrasi,
        TO_CHAR(tanggal_aktifasi,'DD/MM/YYYY')   AS tanggal_aktifasi,
        trx_mei, rev_mei, trx_juni, rev_juni, dev_trx, dev_rev,
        TO_CHAR(synced_at,'YYYY-MM-DD HH24:MI')  AS synced_at
      FROM warroom_lpd_outlet
      ORDER BY trx_juni DESC, id_outlet
    `);
    res.json({ outlets: r.rows, total: r.rows.length });
  } catch (err) {
    console.error('bumdes outlets:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, outletsHandler };
