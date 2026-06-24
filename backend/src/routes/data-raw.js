const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

// Whitelist tabel — mencegah SQL injection pada nama tabel
const TABLES = {
  outlet:    'iq_raw_outlet',
  affiliate: 'iq_raw_affiliate',
  qris:      'iq_raw_qris',
  trx:       'iq_raw_trx',
};

// ── Factory: sync handler (token auth, no JWT) ───────────────────────────
function makeSyncHandler(table) {
  return async function (req, res) {
    const token = req.headers['x-sync-token'] || req.body?.token;
    if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { bulan, sheet_name, rows } = req.body;
    if (!bulan || !Array.isArray(rows))
      return res.status(400).json({ error: 'bulan (YYYY-MM) dan rows[] wajib ada' });
    if (rows.length === 0)
      return res.json({ ok: true, bulan, rows_inserted: 0 });

    const t0 = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${table} WHERE bulan=$1`, [bulan]);
      await client.query(
        `INSERT INTO ${table} (bulan, sheet_name, row_data)
         SELECT $1, $2, value FROM jsonb_array_elements($3::jsonb)`,
        [bulan, sheet_name || bulan, JSON.stringify(rows)]
      );
      await client.query('COMMIT');
      res.json({
        ok: true, bulan,
        sheet_name: sheet_name || bulan,
        rows_inserted: rows.length,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[data-raw ${table} sync]`, e.message);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  };
}

// ── Factory: list handler (requireAuth via router) ───────────────────────
function makeListHandler(table) {
  return async function (req, res) {
    const { bulan, q, page = 1, per_page = 200 } = req.query;
    const limit  = Math.min(parseInt(per_page) || 200, 500);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const params = [];
    const conditions = [];
    if (bulan) { params.push(bulan); conditions.push(`bulan=$${params.length}`); }
    if (q)     { params.push(`%${q.toUpperCase()}%`); conditions.push(`UPPER(row_data::text) LIKE $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    try {
      const [dataRes, countRes, bulanRes] = await Promise.all([
        pool.query(
          `SELECT row_data FROM ${table} ${where} ORDER BY bulan DESC, id
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`, params),
        pool.query(
          `SELECT bulan, sheet_name, COUNT(*) AS row_count, MAX(synced_at) AS last_synced
           FROM ${table} GROUP BY bulan, sheet_name ORDER BY bulan DESC`
        ),
      ]);

      let columns = [];
      if (dataRes.rows.length > 0) columns = Object.keys(dataRes.rows[0].row_data || {});

      res.json({
        rows:       dataRes.rows.map(r => r.row_data),
        total:      parseInt(countRes.rows[0].total),
        page:       parseInt(page),
        per_page:   limit,
        columns,
        bulan_list: bulanRes.rows,
      });
    } catch (e) {
      console.error(`[data-raw ${table} list]`, e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// ── WAR-ROOM Analitik — helpers ───────────────────────────────────────────
function prevBulanStr(bulan) {
  const [y, m] = bulan.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function getOutletCatalog() {
  const res = await pool.query(`
    SELECT DISTINCT ON (row_data->>'ID Outlet')
      row_data->>'ID Outlet'                                    AS id_outlet,
      COALESCE(NULLIF(row_data->>'Nama Kategori', ''), 'Lainnya') AS kategori,
      COALESCE(NULLIF(row_data->>'Nama Paket',    ''), '-')       AS paket,
      COALESCE(NULLIF(row_data->>'Provinsi',      ''), '-')       AS provinsi,
      COALESCE(NULLIF(row_data->>'Kota',          ''), '-')       AS kota
    FROM iq_raw_outlet
    WHERE row_data->>'ID Outlet' IS NOT NULL AND row_data->>'ID Outlet' <> ''
    ORDER BY row_data->>'ID Outlet', bulan DESC
  `);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

async function aggTrxByOutlet(bulan) {
  if (!bulan) return new Map();
  const res = await pool.query(`
    SELECT
      row_data->>'ID Outlet' AS id_outlet,
      COALESCE(SUM((row_data->>'Jumlah Transaksi')::numeric), 0) AS total_trx,
      COALESCE(SUM((row_data->>'Jumlah Omzet')::numeric), 0)     AS total_omzet,
      COALESCE(SUM((row_data->>'Margin')::numeric), 0)           AS total_margin
    FROM iq_raw_trx
    WHERE bulan=$1
      AND row_data->>'ID Outlet' IS NOT NULL
      AND row_data->>'ID Outlet' <> ''
    GROUP BY row_data->>'ID Outlet'
  `, [bulan]);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

// GET /api/data-raw/analytics?bulan=2026-06
async function analyticsRawHandler(req, res) {
  let { bulan } = req.query;
  try {
    const blRes = await pool.query(
      `SELECT DISTINCT bulan FROM iq_raw_trx ORDER BY bulan DESC`
    );
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const b1 = bulan;
    const b2 = prevBulanStr(b1);
    const b3 = prevBulanStr(b2);

    const [catalog, trxCur, trxPrev, trxPrev2] = await Promise.all([
      getOutletCatalog(),
      aggTrxByOutlet(b1),
      aggTrxByOutlet(b2),
      aggTrxByOutlet(b3),
    ]);

    const katMap = new Map();
    const ensure = (kat) => {
      if (!katMap.has(kat)) katMap.set(kat, {
        kategori: kat, mcc: kat,
        j_set: new Set(), j_trx: 0, j_rev: 0, j_margin: 0,
        m_set: new Set(), m_trx: 0, m_rev: 0,
        a_set: new Set(), a_trx: 0, a_rev: 0,
      });
      return katMap.get(kat);
    };

    for (const [id, t] of trxCur) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.j_set.add(id); k.j_trx += +t.total_trx; k.j_rev += +t.total_omzet; k.j_margin += +t.total_margin;
    }
    for (const [id, t] of trxPrev) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.m_set.add(id); k.m_trx += +t.total_trx; k.m_rev += +t.total_omzet;
    }
    for (const [id, t] of trxPrev2) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.a_set.add(id); k.a_trx += +t.total_trx; k.a_rev += +t.total_omzet;
    }

    const tabel = Array.from(katMap.values()).map(k => {
      const jun_merchant = k.j_set.size, mei_merchant = k.m_set.size, apr_merchant = k.a_set.size;
      const dev_mei_jun_rev      = k.j_rev - k.m_rev;
      const dev_mei_jun_merchant = jun_merchant - mei_merchant;
      const dev_mei_jun_trx      = k.j_trx - k.m_trx;
      const dev_apr_jun_rev      = k.j_rev - k.a_rev;
      const dev_apr_jun_merchant = jun_merchant - apr_merchant;
      const dev_apr_jun_trx      = k.j_trx - k.a_trx;
      return {
        kategori: k.kategori, mcc: k.kategori,
        jun_merchant, jun_trx: k.j_trx, jun_rev: k.j_rev, jun_margin: k.j_margin,
        mei_merchant, mei_trx: k.m_trx, mei_rev: k.m_rev,
        apr_merchant, apr_trx: k.a_trx, apr_rev: k.a_rev,
        dev_mei_jun_rev, dev_mei_jun_merchant, dev_mei_jun_trx,
        dev_apr_jun_rev, dev_apr_jun_merchant, dev_apr_jun_trx,
        is_anomali: dev_mei_jun_merchant > 0 && dev_mei_jun_rev < 0,
      };
    }).sort((a, b) => b.jun_rev - a.jun_rev);

    const totRev  = tabel.reduce((s, r) => s + r.jun_rev, 0);
    const totRevM = tabel.reduce((s, r) => s + r.mei_rev, 0);
    res.json({
      bulan, bulan_list: bulanList, b1, b2, b3,
      summary: {
        total_merchant:  tabel.reduce((s, r) => s + r.jun_merchant, 0),
        total_trx:       tabel.reduce((s, r) => s + r.jun_trx, 0),
        total_rev:       totRev,
        segmen_aktif:    tabel.filter(r => r.jun_rev > 0).length,
        segmen_tumbuh:   tabel.filter(r => r.dev_mei_jun_rev > 0).length,
        segmen_turun:    tabel.filter(r => r.dev_mei_jun_rev < 0).length,
        dev_rev_mei_jun: totRev - totRevM,
      },
      tabel,
      top_rev:        tabel.filter(r => r.jun_rev > 0).slice(0, 10),
      top_growth:     [...tabel].filter(r => r.dev_mei_jun_rev > 0).sort((a,b) => b.dev_mei_jun_rev - a.dev_mei_jun_rev).slice(0, 10),
      segmen_masalah: [...tabel].filter(r => r.dev_mei_jun_rev < 0).sort((a,b) => a.dev_mei_jun_rev - b.dev_mei_jun_rev).slice(0, 10),
      anomali:        tabel.filter(r => r.is_anomali),
    });
  } catch (e) {
    console.error('[data-raw analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// GET /api/data-raw/trendline?days=30&bulan=2026-06
async function trendlineRawHandler(req, res) {
  const { days = 30, bulan } = req.query;
  const dayLimit = Math.min(parseInt(days) || 30, 90);
  try {
    const catalog = await getOutletCatalog();

    const blRes = await pool.query(
      `SELECT DISTINCT bulan FROM iq_raw_trx ORDER BY bulan DESC LIMIT 3`
    );
    const bulans = bulan ? [bulan] : blRes.rows.map(r => r.bulan);

    const dayRes = await pool.query(`
      SELECT
        row_data->>'ID Outlet' AS id_outlet,
        row_data->>'Tanggal'   AS tanggal,
        COALESCE(SUM((row_data->>'Jumlah Omzet')::numeric), 0)      AS omzet,
        COALESCE(SUM((row_data->>'Jumlah Transaksi')::numeric), 0)  AS trx
      FROM iq_raw_trx
      WHERE bulan = ANY($1::text[])
        AND row_data->>'ID Outlet' IS NOT NULL AND row_data->>'ID Outlet' <> ''
        AND row_data->>'Tanggal' IS NOT NULL
      GROUP BY row_data->>'ID Outlet', row_data->>'Tanggal'
    `, [bulans]);

    const katDayMap = new Map();
    const dateSet   = new Set();

    for (const row of dayRes.rows) {
      const info = catalog.get(row.id_outlet);
      const kat  = info?.kategori || 'Lainnya';
      const d    = row.tanggal;
      dateSet.add(d);
      if (!katDayMap.has(kat)) katDayMap.set(kat, new Map());
      const dm = katDayMap.get(kat);
      if (!dm.has(d)) dm.set(d, { jun_rev: 0, jun_trx: 0, jun_merchant: 0 });
      const e = dm.get(d);
      e.jun_rev      += Number(row.omzet);
      e.jun_trx      += Number(row.trx);
      e.jun_merchant += 1;
    }

    const dates    = [...dateSet].sort().slice(-dayLimit);
    const byKategori = {};
    const segments   = [];

    for (const [kat, dm] of katDayMap) {
      const rows     = dates.map(d => ({ tanggal: d, ...(dm.get(d) || { jun_rev:0, jun_trx:0, jun_merchant:0 }) }));
      const totalRev = rows.reduce((s, r) => s + r.jun_rev, 0);
      byKategori[kat] = rows;
      segments.push({ kategori: kat, mcc: kat, total_rev: totalRev });
    }

    segments.sort((a, b) => b.total_rev - a.total_rev);
    res.json({ dates, segments, byKategori });
  } catch (e) {
    console.error('[data-raw trendline]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET routes ────────────────────────────────────────────────────────────
router.get('/analytics', analyticsRawHandler);
router.get('/trendline', trendlineRawHandler);
router.get('/outlet',    makeListHandler(TABLES.outlet));
router.get('/affiliate', makeListHandler(TABLES.affiliate));
router.get('/qris',      makeListHandler(TABLES.qris));
router.get('/trx',       makeListHandler(TABLES.trx));

// ── Exports ───────────────────────────────────────────────────────────────
module.exports = router;
module.exports.outletSyncHandler    = makeSyncHandler(TABLES.outlet);
module.exports.affiliateSyncHandler = makeSyncHandler(TABLES.affiliate);
module.exports.qrisSyncHandler      = makeSyncHandler(TABLES.qris);
module.exports.trxSyncHandler       = makeSyncHandler(TABLES.trx);
