const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

const CHUNK = 500; // maks 500 baris per query (500×16 params = 8000, aman < 65535)

async function upsertChunk(bulan, rows) {
  if (!rows.length) return;
  const str = f => rows.map(o => { const v = f(o); return v != null ? String(v).trim() : null; });
  const int = f => rows.map(o => parseInt(f(o))   || 0);
  const flt = f => rows.map(o => parseFloat(f(o)) || 0);
  await pool.query(`
    INSERT INTO warroom_pa_asdp_outlet
      (bulan, id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance,
       nama_kota, tanggal_registrasi, tanggal_aktifasi,
       trx_prev, rev_prev, trx_curr, rev_curr, dev_trx, dev_rev, synced_at)
    SELECT $1, t.id_outlet, t.upline, t.nama_pemilik, t.notelp_pemilik, t.tipe_outlet, t.balance,
           t.nama_kota,
           CASE
             WHEN NULLIF(t.tgl_reg,'') ~ '^\d{4}-\d{2}-\d{2}$' THEN NULLIF(t.tgl_reg,'')::date
             WHEN NULLIF(t.tgl_reg,'') ~ '^\d{1,2}/\d{1,2}/\d{4}$' THEN TO_DATE(t.tgl_reg,'DD/MM/YYYY')
             ELSE NULL
           END,
           CASE
             WHEN NULLIF(t.tgl_aktif,'') ~ '^\d{4}-\d{2}-\d{2}$' THEN NULLIF(t.tgl_aktif,'')::date
             WHEN NULLIF(t.tgl_aktif,'') ~ '^\d{1,2}/\d{1,2}/\d{4}$' THEN TO_DATE(t.tgl_aktif,'DD/MM/YYYY')
             ELSE NULL
           END,
           t.trx_prev, t.rev_prev, t.trx_curr, t.rev_curr, t.dev_trx, t.dev_rev, NOW()
    FROM unnest(
      $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[],
      $8::text[], $9::text[], $10::text[],
      $11::int[], $12::numeric[], $13::int[], $14::numeric[], $15::int[], $16::numeric[]
    ) AS t(id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance,
           nama_kota, tgl_reg, tgl_aktif,
           trx_prev, rev_prev, trx_curr, rev_curr, dev_trx, dev_rev)
    ON CONFLICT (bulan, id_outlet) DO UPDATE SET
      upline             = EXCLUDED.upline,
      nama_pemilik       = EXCLUDED.nama_pemilik,
      notelp_pemilik     = EXCLUDED.notelp_pemilik,
      tipe_outlet        = EXCLUDED.tipe_outlet,
      balance            = EXCLUDED.balance,
      nama_kota          = EXCLUDED.nama_kota,
      tanggal_registrasi = EXCLUDED.tanggal_registrasi,
      tanggal_aktifasi   = EXCLUDED.tanggal_aktifasi,
      trx_prev           = EXCLUDED.trx_prev,
      rev_prev           = EXCLUDED.rev_prev,
      trx_curr           = EXCLUDED.trx_curr,
      rev_curr           = EXCLUDED.rev_curr,
      dev_trx            = EXCLUDED.dev_trx,
      dev_rev            = EXCLUDED.dev_rev,
      synced_at          = EXCLUDED.synced_at
  `, [
    bulan,
    str(o => o.id_outlet),
    str(o => o.upline || null),
    str(o => o.nama_pemilik || null),
    str(o => o.notelp_pemilik || ''),
    str(o => o.tipe_outlet || null),
    int(o => o.balance),
    str(o => o.nama_kota || null),
    str(o => o.tanggal_registrasi || null),
    str(o => o.tanggal_aktifasi || null),
    int(o => o.trx_prev),
    flt(o => o.rev_prev),
    int(o => o.trx_curr),
    flt(o => o.rev_curr),
    int(o => o.dev_trx),
    flt(o => o.dev_rev),
  ]);
}

/* ── SYNC ── */
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { bulan, outlets } = req.body;
  if (!bulan || !Array.isArray(outlets) || outlets.length === 0) {
    return res.status(400).json({ error: 'bulan dan outlets array required' });
  }
  if (!/^\d{4}-\d{2}$/.test(bulan)) {
    return res.status(400).json({ error: 'bulan harus format YYYY-MM' });
  }

  const valid = outlets.filter(o => o.id_outlet);
  if (!valid.length) return res.json({ ok: true, count: 0 });

  // Respond langsung agar Apps Script tidak timeout; DB write jalan di background
  res.json({ ok: true, count: valid.length, bulan, chunks: Math.ceil(valid.length / CHUNK) });

  setImmediate(async () => {
    try {
      for (let i = 0; i < valid.length; i += CHUNK) {
        await upsertChunk(bulan, valid.slice(i, i + CHUNK));
      }
      console.log(`[pa-asdp sync] done: ${valid.length} outlets, bulan ${bulan}`);
    } catch (err) {
      console.error(`[pa-asdp sync] error bulan ${bulan}:`, err.message);
    }
  });
}

/* ── ANALYTICS ── */
async function analyticsHandler(req, res) {
  try {
    const blRes = await pool.query(
      `SELECT DISTINCT bulan FROM warroom_pa_asdp_outlet ORDER BY bulan DESC`
    );
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });

    let { bulan } = req.query;
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const [sumR, upR, kotaR, tipeR, syncR] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(trx_curr),0)                                                      AS total_trx_curr,
          COALESCE(SUM(rev_curr),0)                                                      AS total_rev_curr,
          COALESCE(SUM(trx_prev),0)                                                      AS total_trx_prev,
          COALESCE(SUM(rev_prev),0)                                                      AS total_rev_prev,
          COALESCE(SUM(CASE WHEN trx_prev=0 THEN trx_curr ELSE 0 END),0)                AS trx_new_mat,
          COALESCE(SUM(CASE WHEN trx_prev=0 THEN rev_curr ELSE 0 END),0)                AS rev_new_mat,
          COUNT(CASE WHEN trx_curr>0 THEN 1 END)                                         AS mat,
          COUNT(CASE WHEN trx_prev=0 AND trx_curr>0 THEN 1 END)                         AS nmat,
          COUNT(CASE WHEN trx_prev=0 AND trx_curr>=100 THEN 1 END)                      AS nmat_min100,
          COUNT(CASE WHEN trx_curr>=300 THEN 1 END)                                      AS mat_min300,
          COALESCE(SUM(dev_trx),0)                                                        AS dev_trx_total,
          COALESCE(SUM(dev_rev),0)                                                        AS dev_rev_total,
          COUNT(*)                                                                         AS total_outlet,
          COUNT(CASE WHEN dev_trx>0 AND trx_prev>0 THEN 1 END)                           AS growing,
          COUNT(CASE WHEN dev_trx<0 THEN 1 END)                                           AS declining,
          COUNT(CASE WHEN dev_trx=0 AND trx_prev>0 AND trx_curr>0 THEN 1 END)            AS stable,
          COUNT(CASE WHEN trx_prev>0 AND trx_curr=0 THEN 1 END)                          AS churned,
          COUNT(CASE WHEN trx_prev=0 AND trx_curr=0 THEN 1 END)                          AS belum_aktif,
          COUNT(CASE WHEN dev_trx>0 AND dev_rev<0 AND trx_prev>0 THEN 1 END)             AS anomali
        FROM warroom_pa_asdp_outlet WHERE bulan=$1
      `, [bulan]),

      pool.query(`
        SELECT upline,
          COUNT(*)                                                     AS outlet_count,
          COUNT(CASE WHEN trx_curr>0 THEN 1 END)                     AS mat,
          COALESCE(SUM(trx_curr),0)                                   AS trx_curr,
          COALESCE(SUM(rev_curr),0)                                   AS rev_curr,
          COALESCE(SUM(trx_prev),0)                                   AS trx_prev,
          COALESCE(SUM(dev_trx),0)                                    AS dev_trx,
          COALESCE(SUM(dev_rev),0)                                    AS dev_rev
        FROM warroom_pa_asdp_outlet
        WHERE bulan=$1 AND upline IS NOT NULL AND upline!=''
        GROUP BY upline ORDER BY trx_curr DESC
      `, [bulan]),

      pool.query(`
        SELECT nama_kota,
          COUNT(*)                                                     AS outlet_count,
          COUNT(CASE WHEN trx_curr>0 THEN 1 END)                     AS mat,
          COALESCE(SUM(trx_curr),0)                                   AS trx_curr,
          COALESCE(SUM(rev_curr),0)                                   AS rev_curr,
          COALESCE(SUM(dev_trx),0)                                    AS dev_trx
        FROM warroom_pa_asdp_outlet
        WHERE bulan=$1 AND nama_kota IS NOT NULL AND nama_kota!=''
        GROUP BY nama_kota ORDER BY trx_curr DESC LIMIT 20
      `, [bulan]),

      pool.query(`
        SELECT tipe_outlet,
          COUNT(*)                                                     AS outlet_count,
          COUNT(CASE WHEN trx_curr>0 THEN 1 END)                     AS mat,
          COALESCE(SUM(trx_curr),0)                                   AS trx_curr,
          COALESCE(SUM(rev_curr),0)                                   AS rev_curr
        FROM warroom_pa_asdp_outlet
        WHERE bulan=$1 AND tipe_outlet IS NOT NULL AND tipe_outlet!=''
        GROUP BY tipe_outlet ORDER BY outlet_count DESC
      `, [bulan]),

      pool.query(
        'SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total FROM warroom_pa_asdp_outlet WHERE bulan=$1',
        [bulan]
      ),
    ]);

    res.json({
      bulan,
      bulan_list: bulanList,
      summary:    sumR.rows[0],
      uplines:    upR.rows,
      kotas:      kotaR.rows,
      tipes:      tipeR.rows,
      last_sync:  syncR.rows[0]?.last_sync,
      total:      syncR.rows[0]?.total,
    });
  } catch (err) {
    console.error('pa-asdp analytics:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ── OUTLETS ── */
async function outletsHandler(req, res) {
  try {
    const blRes = await pool.query(
      `SELECT DISTINCT bulan FROM warroom_pa_asdp_outlet ORDER BY bulan DESC`
    );
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ outlets: [], bulan_list: [], total: 0 });

    let { bulan } = req.query;
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const r = await pool.query(`
      SELECT
        id_outlet, upline, nama_pemilik, notelp_pemilik, tipe_outlet, balance, nama_kota,
        TO_CHAR(tanggal_registrasi,'DD/MM/YYYY') AS tanggal_registrasi,
        TO_CHAR(tanggal_aktifasi,'DD/MM/YYYY')   AS tanggal_aktifasi,
        trx_prev, rev_prev, trx_curr, rev_curr, dev_trx, dev_rev,
        TO_CHAR(synced_at,'YYYY-MM-DD HH24:MI')  AS synced_at
      FROM warroom_pa_asdp_outlet
      WHERE bulan=$1
      ORDER BY trx_curr DESC, id_outlet
    `, [bulan]);

    res.json({ outlets: r.rows, total: r.rows.length, bulan, bulan_list: bulanList });
  } catch (err) {
    console.error('pa-asdp outlets:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler, outletsHandler };
