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
    const {
      bulan, q, page = 1, per_page = 200,
      tgl_dari, tgl_sampai,
      sort_col, sort_dir = 'asc',
    } = req.query;
    const limit  = Math.min(parseInt(per_page) || 200, 500);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

    const params = [];
    const conditions = [];
    // Kolom tanggal: 'Tanggal' (trx), 'tanggal' (qris), 'Tanggal Registrasi' (outlet)
    const TGL = `COALESCE(NULLIF(row_data->>'Tanggal',''), NULLIF(row_data->>'tanggal',''), NULLIF(row_data->>'Tanggal Registrasi',''))`;
    if (bulan) { params.push(bulan); conditions.push(`bulan=$${params.length}`); }
    if (q)     { params.push(`%${q.toUpperCase()}%`); conditions.push(`UPPER(row_data::text) LIKE $${params.length}`); }
    if (tgl_dari && tgl_sampai && tgl_dari <= tgl_sampai) {
      params.push(tgl_dari); conditions.push(`${TGL} IS NOT NULL AND (${TGL})::date >= $${params.length}::date`);
      params.push(tgl_sampai); conditions.push(`(${TGL})::date <= $${params.length}::date`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Sort — sort_col TIDAK masuk ke params WHERE (params dipakai bersama countRes/statRes)
    // dataParams = [...params, sort_col?, limit, offset] — hanya untuk query SELECT data
    const safeDir = sort_dir === 'desc' ? 'DESC' : 'ASC';
    let orderBy;
    let dataParams;
    if (sort_col) {
      orderBy  = `(row_data->>$${params.length + 1}) ${safeDir} NULLS LAST`;
      dataParams = [...params, sort_col, limit, offset];
    } else if (tgl_dari || tgl_sampai) {
      orderBy  = `(${TGL}) ASC NULLS LAST`;
      dataParams = [...params, limit, offset];
    } else {
      orderBy  = 'bulan DESC, id ASC';
      dataParams = [...params, limit, offset];
    }
    const limitIdx  = dataParams.length - 1;
    const offsetIdx = dataParams.length;

    try {
      const [dataRes, countRes, bulanRes, statRes] = await Promise.all([
        pool.query(
          `SELECT row_data FROM ${table} ${where} ORDER BY ${orderBy}
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          dataParams
        ),
        pool.query(`SELECT COUNT(*) AS total FROM ${table} ${where}`, params),
        pool.query(
          `SELECT bulan, sheet_name, COUNT(*) AS row_count, MAX(synced_at) AS last_synced
           FROM ${table} GROUP BY bulan, sheet_name ORDER BY bulan DESC`
        ),
        pool.query(
          `SELECT MIN(${TGL}) AS tgl_min, MAX(${TGL}) AS tgl_max
           FROM ${table} ${where}`,
          params
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
        tgl_min:    statRes.rows[0]?.tgl_min || null,
        tgl_max:    statRes.rows[0]?.tgl_max || null,
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

// Geser tanggal YYYY-MM-DD sebanyak N bulan (cap ke hari terakhir bulan tujuan)
function shiftMonthDate(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target  = new Date(Date.UTC(y, m - 1 + months, 1));
  const tY = target.getUTCFullYear(), tM = target.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(tY, tM, 0)).getUTCDate();
  return `${tY}-${String(tM).padStart(2,'0')}-${String(Math.min(d, lastDay)).padStart(2,'0')}`;
}

async function getOutletCatalog() {
  const res = await pool.query(`
    SELECT DISTINCT ON (COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')))
      COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) AS id_outlet,
      COALESCE(NULLIF(row_data->>'Nama Kategori', ''), 'Lainnya') AS kategori,
      COALESCE(NULLIF(row_data->>'Nama Paket',    ''), '-')       AS paket,
      COALESCE(NULLIF(row_data->>'Provinsi',      ''), '-')       AS provinsi,
      COALESCE(NULLIF(row_data->>'Kota',          ''), '-')       AS kota
    FROM iq_raw_outlet
    WHERE COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) IS NOT NULL
    ORDER BY COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')), bulan DESC
  `);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

async function aggTrxByOutlet(bulan, maxDay = null, tglDari = null, tglSampai = null) {
  if (!bulan) return new Map();
  const params = [bulan];
  let dateFilter = '';
  if (tglDari && tglSampai) {
    params.push(tglDari, tglSampai);
    dateFilter = `AND row_data->>'Tanggal' IS NOT NULL
                  AND (row_data->>'Tanggal')::date BETWEEN $2::date AND $3::date`;
  } else if (maxDay) {
    params.push(maxDay);
    dateFilter = `AND row_data->>'Tanggal' IS NOT NULL
                  AND EXTRACT(DAY FROM (row_data->>'Tanggal')::date) <= $2`;
  }
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
      ${dateFilter}
    GROUP BY row_data->>'ID Outlet'
  `, params);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

// GET /api/data-raw/analytics?bulan=2026-06&tgl_dari=2026-06-01&tgl_sampai=2026-06-15
async function analyticsRawHandler(req, res) {
  let { bulan, tgl_dari, tgl_sampai } = req.query;
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

    const dateRangeMode = !!(tgl_dari && tgl_sampai && tgl_dari <= tgl_sampai);
    let maxDay = null, maxTgl = null;
    let b2TglDari = null, b2TglSampai = null, b3TglDari = null, b3TglSampai = null;

    if (dateRangeMode) {
      // Geser range ke bulan sebelumnya untuk perbandingan head-to-head
      b2TglDari   = shiftMonthDate(tgl_dari,  -1);
      b2TglSampai = shiftMonthDate(tgl_sampai, -1);
      b3TglDari   = shiftMonthDate(tgl_dari,  -2);
      b3TglSampai = shiftMonthDate(tgl_sampai, -2);
    } else {
      // MTD alignment: temukan tanggal terakhir di b1, lalu filter b2 & b3 sampai hari yang sama
      const maxTglRes = await pool.query(
        `SELECT MAX(row_data->>'Tanggal') AS max_tgl
         FROM iq_raw_trx
         WHERE bulan=$1 AND row_data->>'Tanggal' IS NOT NULL`,
        [b1]
      );
      maxTgl = maxTglRes.rows[0]?.max_tgl;
      maxDay = maxTgl ? parseInt(String(maxTgl).slice(8, 10), 10) : null;
    }

    const [catalog, trxCur, trxPrev, trxPrev2] = await Promise.all([
      getOutletCatalog(),
      aggTrxByOutlet(b1, null, dateRangeMode ? tgl_dari : null, dateRangeMode ? tgl_sampai : null),
      aggTrxByOutlet(b2, dateRangeMode ? null : maxDay, b2TglDari, b2TglSampai),
      aggTrxByOutlet(b3, dateRangeMode ? null : maxDay, b3TglDari, b3TglSampai),
    ]);

    const katMap = new Map();
    const ensure = (kat) => {
      if (!katMap.has(kat)) katMap.set(kat, {
        kategori: kat, mcc: kat,
        j_set: new Set(), j_trx: 0, j_rev: 0, j_margin: 0,
        m_set: new Set(), m_trx: 0, m_rev: 0, m_margin: 0,
        a_set: new Set(), a_trx: 0, a_rev: 0, a_margin: 0,
      });
      return katMap.get(kat);
    };

    for (const [id, t] of trxCur) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.j_set.add(id); k.j_trx += +t.total_trx; k.j_rev += +t.total_omzet; k.j_margin += +t.total_margin;
    }
    for (const [id, t] of trxPrev) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.m_set.add(id); k.m_trx += +t.total_trx; k.m_rev += +t.total_omzet; k.m_margin += +t.total_margin;
    }
    for (const [id, t] of trxPrev2) {
      const k = ensure(catalog.get(id)?.kategori || 'Lainnya');
      k.a_set.add(id); k.a_trx += +t.total_trx; k.a_rev += +t.total_omzet; k.a_margin += +t.total_margin;
    }

    const tabel = Array.from(katMap.values()).map(k => {
      const jun_merchant = k.j_set.size, mei_merchant = k.m_set.size, apr_merchant = k.a_set.size;
      const dev_mei_jun_trx      = k.j_trx    - k.m_trx;
      const dev_mei_jun_margin   = k.j_margin  - k.m_margin;
      const dev_mei_jun_rev      = k.j_rev     - k.m_rev;
      const dev_mei_jun_merchant = jun_merchant - mei_merchant;
      const dev_apr_jun_trx      = k.j_trx    - k.a_trx;
      const dev_apr_jun_margin   = k.j_margin  - k.a_margin;
      const dev_apr_jun_rev      = k.j_rev     - k.a_rev;
      const dev_apr_jun_merchant = jun_merchant - apr_merchant;
      // Anomali: TRX naik tapi margin turun — indikasi transaksi kecil/mix buruk
      const is_anomali = dev_mei_jun_trx > 0 && dev_mei_jun_margin < 0;
      return {
        kategori: k.kategori, mcc: k.kategori,
        jun_merchant, jun_trx: k.j_trx, jun_rev: k.j_rev, jun_margin: k.j_margin,
        mei_merchant, mei_trx: k.m_trx, mei_rev: k.m_rev, mei_margin: k.m_margin,
        apr_merchant, apr_trx: k.a_trx, apr_rev: k.a_rev, apr_margin: k.a_margin,
        dev_mei_jun_trx, dev_mei_jun_margin, dev_mei_jun_rev, dev_mei_jun_merchant,
        dev_apr_jun_trx, dev_apr_jun_margin, dev_apr_jun_rev, dev_apr_jun_merchant,
        is_anomali,
      };
    }).sort((a, b) => b.jun_trx - a.jun_trx);  // default sort: TRX tertinggi

    const totMargin  = tabel.reduce((s, r) => s + r.jun_margin, 0);
    const totMarginM = tabel.reduce((s, r) => s + r.mei_margin, 0);
    const totTrx     = tabel.reduce((s, r) => s + r.jun_trx, 0);
    const totTrxM    = tabel.reduce((s, r) => s + r.mei_trx, 0);
    const totRev     = tabel.reduce((s, r) => s + r.jun_rev, 0);
    res.json({
      bulan, bulan_list: bulanList, b1, b2, b3,
      mtd_info: dateRangeMode ? {
        max_tgl:       tgl_sampai,
        max_day:       parseInt(tgl_sampai.slice(8, 10), 10),
        b1_label:      `${tgl_dari.slice(8)}/${tgl_dari.slice(5,7)} – ${tgl_sampai.slice(8)}/${tgl_sampai.slice(5,7)}`,
        b2_label:      `${b2TglDari.slice(8)}/${b2TglDari.slice(5,7)} – ${b2TglSampai.slice(8)}/${b2TglSampai.slice(5,7)}`,
        b3_label:      `${b3TglDari.slice(8)}/${b3TglDari.slice(5,7)} – ${b3TglSampai.slice(8)}/${b3TglSampai.slice(5,7)}`,
        is_mtd:        false,
        is_date_range: true,
        tgl_dari, tgl_sampai,
      } : {
        max_tgl:       maxTgl  || null,
        max_day:       maxDay  || null,
        b1_label:      maxDay ? `${b1} (1-${maxDay})` : b1,
        b2_label:      maxDay ? `${b2} (1-${maxDay})` : b2,
        b3_label:      maxDay ? `${b3} (1-${maxDay})` : b3,
        is_mtd:        maxDay !== null && maxDay < 28,
        is_date_range: false,
      },
      summary: {
        total_merchant:    tabel.reduce((s, r) => s + r.jun_merchant, 0),
        total_trx:         totTrx,
        total_margin:      totMargin,
        total_rev:         totRev,
        segmen_aktif:      tabel.filter(r => r.jun_trx > 0).length,
        segmen_tumbuh:     tabel.filter(r => r.dev_mei_jun_trx > 0).length,
        segmen_turun:      tabel.filter(r => r.dev_mei_jun_trx < 0).length,
        dev_trx_mei_jun:   totTrx    - totTrxM,
        dev_margin_mei_jun:totMargin - totMarginM,
      },
      tabel,
      top_trx:        [...tabel].filter(r => r.jun_trx > 0).sort((a,b) => b.jun_trx - a.jun_trx).slice(0, 10),
      top_margin:     [...tabel].filter(r => r.jun_margin > 0).sort((a,b) => b.jun_margin - a.jun_margin).slice(0, 10),
      top_growth:     [...tabel].filter(r => r.dev_mei_jun_trx > 0).sort((a,b) => b.dev_mei_jun_trx - a.dev_mei_jun_trx).slice(0, 10),
      segmen_masalah: [...tabel].filter(r => r.dev_mei_jun_trx < 0).sort((a,b) => a.dev_mei_jun_trx - b.dev_mei_jun_trx).slice(0, 10),
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
        COALESCE(SUM((row_data->>'Jumlah Transaksi')::numeric), 0)  AS trx,
        COALESCE(SUM((row_data->>'Margin')::numeric), 0)            AS margin
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
      if (!dm.has(d)) dm.set(d, { jun_rev: 0, jun_trx: 0, jun_margin: 0, jun_merchant: 0 });
      const e = dm.get(d);
      e.jun_rev      += Number(row.omzet);
      e.jun_trx      += Number(row.trx);
      e.jun_margin   += Number(row.margin);
      e.jun_merchant += 1;
    }

    const dates    = [...dateSet].sort().slice(-dayLimit);
    const byKategori = {};
    const segments   = [];

    for (const [kat, dm] of katDayMap) {
      const rows       = dates.map(d => ({ tanggal: d, ...(dm.get(d) || { jun_rev:0, jun_trx:0, jun_margin:0, jun_merchant:0 }) }));
      const totalTrx   = rows.reduce((s, r) => s + r.jun_trx, 0);
      const totalMargin= rows.reduce((s, r) => s + r.jun_margin, 0);
      byKategori[kat] = rows;
      segments.push({ kategori: kat, mcc: kat, total_trx: totalTrx, total_margin: totalMargin });
    }

    segments.sort((a, b) => b.total_trx - a.total_trx);  // default sort: TRX
    res.json({ dates, segments, byKategori });
  } catch (e) {
    console.error('[data-raw trendline]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── WAR-ROOM Penerbitan QRIS ──────────────────────────────────────────────
const STATUS_COLOR = {
  'Terbit':         '#10B981',
  'Belum Terbit':   '#3B82F6',
  'Perbaikan Data': '#F59E0B',
  'Rejected':       '#EF4444',
};

function parseAnyDate(s) {
  if (!s) return null;
  const str = String(s).trim().slice(0, 10);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str);
  return null;
}

async function qrisAnalyticsHandler(req, res) {
  let { bulan } = req.query;
  try {
    const blRes = await pool.query(
      `SELECT DISTINCT bulan FROM iq_raw_qris ORDER BY bulan DESC`
    );
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    // Outlet yang sudah aktivasi = yang diajukan ke PTEN untuk penerbitan QRIS
    // (registrasi saja belum diajukan, yang diajukan adalah yang sudah aktivasi instant/fleksibel)
    const activatedRes = await pool.query(`
      SELECT DISTINCT ON (COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')))
        COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) AS id_outlet,
        NULLIF(row_data->>'Tanggal Aktivasi', '') AS tgl_aktivasi
      FROM iq_raw_outlet
      WHERE COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) IS NOT NULL
        AND NULLIF(row_data->>'Tanggal Aktivasi', '') IS NOT NULL
      ORDER BY COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')), bulan DESC
    `);
    const activationMap = new Map(activatedRes.rows.map(r => [r.id_outlet, r.tgl_aktivasi]));
    const activatedIds  = [...activationMap.keys()];

    const [statusRes, byOutletRes, dailyRes, catalog, trxRes, perbaikanDaysRes] = await Promise.all([
      // Status distribution — hanya outlet yang sudah aktivasi
      pool.query(`
        SELECT COALESCE(NULLIF(row_data->>'status',''), 'Tidak Diketahui') AS status,
               COUNT(*) AS cnt
        FROM iq_raw_qris WHERE bulan=$1
          AND row_data->>'id_outlet' = ANY($2::text[])
        GROUP BY status ORDER BY cnt DESC
      `, [bulan, activatedIds]),

      // Per outlet + status (for segmentation) — hanya aktivasi
      pool.query(`
        SELECT row_data->>'id_outlet' AS id_outlet,
               COALESCE(NULLIF(row_data->>'status',''), 'Tidak Diketahui') AS status,
               COUNT(*) AS cnt
        FROM iq_raw_qris
        WHERE bulan=$1 AND row_data->>'id_outlet' IS NOT NULL
          AND row_data->>'id_outlet' = ANY($2::text[])
        GROUP BY row_data->>'id_outlet', status
      `, [bulan, activatedIds]),

      // Daily trend — hanya aktivasi
      pool.query(`
        SELECT row_data->>'tanggal' AS tanggal,
               COALESCE(NULLIF(row_data->>'status',''), 'Tidak Diketahui') AS status,
               COUNT(*) AS cnt
        FROM iq_raw_qris
        WHERE bulan=$1 AND row_data->>'tanggal' IS NOT NULL
          AND row_data->>'id_outlet' = ANY($2::text[])
        GROUP BY row_data->>'tanggal', status
        ORDER BY tanggal
      `, [bulan, activatedIds]),

      // Outlet catalog (all months, most recent per outlet)
      getOutletCatalog(),

      // Outlets with TRX this bulan
      pool.query(`
        SELECT DISTINCT row_data->>'ID Outlet' AS id_outlet
        FROM iq_raw_trx WHERE bulan=$1 AND row_data->>'ID Outlet' IS NOT NULL
      `, [bulan]),

      // Lama perbaikan data: tanggal perbaikan terakhir - tanggal aktivasi per outlet
      pool.query(`
        SELECT ROUND(AVG(diff_days)) AS avg_days_perbaikan FROM (
          SELECT MAX(q.row_data->>'tanggal')::date
               - MIN((o.row_data->>'Tanggal Aktivasi')::date) AS diff_days
          FROM iq_raw_qris q
          JOIN iq_raw_outlet o
            ON q.row_data->>'id_outlet' = COALESCE(NULLIF(o.row_data->>'ID Outlet',''), NULLIF(o.row_data->>'D Outlet',''))
          WHERE q.bulan=$1
            AND COALESCE(NULLIF(q.row_data->>'status',''), '') = 'Perbaikan Data'
            AND q.row_data->>'id_outlet' = ANY($2::text[])
            AND NULLIF(o.row_data->>'Tanggal Aktivasi','') IS NOT NULL
          GROUP BY q.row_data->>'id_outlet'
          HAVING MAX(q.row_data->>'tanggal')::date >= MIN((o.row_data->>'Tanggal Aktivasi')::date)
        ) sub
      `, [bulan, activatedIds]),
    ]);

    const avgDaysPerbaikan = perbaikanDaysRes.rows[0]?.avg_days_perbaikan != null
      ? Math.round(+perbaikanDaysRes.rows[0].avg_days_perbaikan)
      : null;

    // ── Status totals ───────────────────────────────────────────────────────
    const statusMap = {};
    let total = 0;
    for (const r of statusRes.rows) { statusMap[r.status] = +r.cnt; total += +r.cnt; }
    const terbit    = statusMap['Terbit']         || 0;
    const perbaikan = statusMap['Perbaikan Data'] || 0;
    const belum     = statusMap['Belum Terbit']   || 0;
    const rejected  = statusMap['Rejected']       || 0;

    const by_status = statusRes.rows.map(r => ({
      status: r.status, count: +r.cnt,
      rate: total > 0 ? +((+r.cnt / total) * 100).toFixed(1) : 0,
      color: STATUS_COLOR[r.status] || '#9CA3AF',
    }));

    // ── Outlet sets ─────────────────────────────────────────────────────────
    const trxSet        = new Set(trxRes.rows.map(r => r.id_outlet));
    const terbitSet     = new Set();
    const perbaikanSet  = new Set();
    const belumSet      = new Set();
    for (const r of byOutletRes.rows) {
      if (r.status === 'Terbit')         terbitSet.add(r.id_outlet);
      if (r.status === 'Perbaikan Data') perbaikanSet.add(r.id_outlet);
      if (r.status === 'Belum Terbit')   belumSet.add(r.id_outlet);
    }
    const terbitWithTrx  = [...terbitSet].filter(id => trxSet.has(id)).length;
    const activationRate = terbitSet.size > 0 ? +((terbitWithTrx / terbitSet.size) * 100).toFixed(1) : 0;

    // ── Segmentation by Kategori & Provinsi ─────────────────────────────────
    const katMap  = new Map();
    const provMap = new Map();
    const ensureKat = (k) => {
      if (!katMap.has(k)) katMap.set(k, { kategori:k, terbit:0, perbaikan:0, belum:0, rejected:0, outlets:new Set(), with_trx:0 });
      return katMap.get(k);
    };
    const ensureProv = (p) => {
      if (!provMap.has(p)) provMap.set(p, { provinsi:p, terbit:0, perbaikan:0, belum:0, rejected:0, outlets:new Set() });
      return provMap.get(p);
    };

    for (const r of byOutletRes.rows) {
      const info = catalog.get(r.id_outlet);
      const kat  = info?.kategori || 'Tidak Diketahui';
      const prov = info?.provinsi || 'Tidak Diketahui';
      const cnt  = +r.cnt;
      const k = ensureKat(kat);
      const p = ensureProv(prov);
      k.outlets.add(r.id_outlet); p.outlets.add(r.id_outlet);
      if (r.status === 'Terbit')         { k.terbit    += cnt; p.terbit    += cnt; if (trxSet.has(r.id_outlet)) k.with_trx++; }
      if (r.status === 'Perbaikan Data') { k.perbaikan += cnt; p.perbaikan += cnt; }
      if (r.status === 'Belum Terbit')   { k.belum     += cnt; p.belum     += cnt; }
      if (r.status === 'Rejected')       { k.rejected  += cnt; p.rejected  += cnt; }
    }

    const buildKat = (k) => {
      const tot = k.terbit + k.perbaikan + k.belum + k.rejected;
      return {
        kategori: k.kategori,
        terbit: k.terbit, perbaikan: k.perbaikan, belum: k.belum, rejected: k.rejected,
        total: tot, outlets: k.outlets.size, with_trx: k.with_trx,
        terbit_rate:     tot > 0        ? +((k.terbit    / tot)            * 100).toFixed(1) : 0,
        activation_rate: k.terbit > 0   ? +((k.with_trx  / k.terbit)      * 100).toFixed(1) : 0,
        perbaikan_rate:  tot > 0        ? +((k.perbaikan / tot)            * 100).toFixed(1) : 0,
      };
    };
    const buildProv = (p) => {
      const tot = p.terbit + p.perbaikan + p.belum + p.rejected;
      return {
        provinsi: p.provinsi,
        terbit: p.terbit, perbaikan: p.perbaikan, belum: p.belum, rejected: p.rejected,
        total: tot, outlets: p.outlets.size,
        terbit_rate:    tot > 0 ? +((p.terbit    / tot) * 100).toFixed(1) : 0,
        perbaikan_rate: tot > 0 ? +((p.perbaikan / tot) * 100).toFixed(1) : 0,
      };
    };

    const by_kategori = Array.from(katMap.values()).map(buildKat).sort((a,b) => b.total - a.total);
    const by_provinsi = Array.from(provMap.values()).map(buildProv).sort((a,b) => b.total - a.total);

    // ── Daily trend ─────────────────────────────────────────────────────────
    const dayMap = new Map();
    for (const r of dailyRes.rows) {
      if (!r.tanggal) continue;
      const d = String(r.tanggal).slice(0, 10);
      if (!dayMap.has(d)) dayMap.set(d, { tanggal:d, terbit:0, perbaikan:0, belum:0, rejected:0 });
      const e = dayMap.get(d); const cnt = +r.cnt;
      if (r.status === 'Terbit')         e.terbit    += cnt;
      if (r.status === 'Perbaikan Data') e.perbaikan += cnt;
      if (r.status === 'Belum Terbit')   e.belum     += cnt;
      if (r.status === 'Rejected')       e.rejected  += cnt;
    }
    const daily = [...dayMap.values()].sort((a,b) => a.tanggal.localeCompare(b.tanggal));

    const terbitDays  = daily.filter(d => d.terbit > 0);
    const avgTerbit   = terbitDays.length > 0 ? Math.round(terbitDays.reduce((s,d) => s+d.terbit,0) / terbitDays.length) : 0;
    const peakTerbit  = Math.max(...daily.map(d => d.terbit), 0);
    const peakDate    = daily.find(d => d.terbit === peakTerbit)?.tanggal || '';

    // ── Response ─────────────────────────────────────────────────────────────
    res.json({
      bulan, bulan_list: bulanList,
      summary: {
        total, terbit, perbaikan, belum, rejected,
        terbit_rate:    total > 0 ? +((terbit    / total) * 100).toFixed(1) : 0,
        perbaikan_rate: total > 0 ? +((perbaikan / total) * 100).toFixed(1) : 0,
        belum_rate:     total > 0 ? +((belum     / total) * 100).toFixed(1) : 0,
        terbit_outlets:    terbitSet.size,
        perbaikan_outlets: perbaikanSet.size,
        belum_outlets:     belumSet.size,
        terbit_with_trx:   terbitWithTrx,
        activation_rate:   activationRate,
        avg_daily_terbit:  avgTerbit,
        peak_daily_terbit: peakTerbit,
        peak_date:         peakDate,
        avg_days_perbaikan: avgDaysPerbaikan,    // rata-rata hari outlet dalam Perbaikan Data sejak aktivasi
        total_activated:    activatedIds.length,
      },
      by_status,
      by_kategori:  by_kategori.slice(0, 30),
      by_provinsi:  by_provinsi.slice(0, 20),
      top_terbit:   [...by_kategori].sort((a,b) => b.terbit_rate    - a.terbit_rate).filter(k => k.total >= 50).slice(0, 10),
      top_perbaikan:[...by_kategori].sort((a,b) => b.perbaikan     - a.perbaikan).slice(0, 10),
      top_activation:[...by_kategori].filter(k => k.terbit >= 10).sort((a,b) => b.activation_rate - a.activation_rate).slice(0, 10),
      bot_activation:[...by_kategori].filter(k => k.terbit >= 10).sort((a,b) => a.activation_rate - b.activation_rate).slice(0, 10),
      daily,
    });
  } catch (e) {
    console.error('[data-raw qris-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Outlet-level analytics ────────────────────────────────────────────────
async function getFullOutletCatalog() {
  const res = await pool.query(`
    SELECT DISTINCT ON (COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')))
      COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) AS id_outlet,
      COALESCE(NULLIF(row_data->>'Nama Merchant',    ''), '-')    AS nama_merchant,
      COALESCE(NULLIF(row_data->>'Nama Kategori',    ''), 'Lainnya') AS kategori,
      COALESCE(NULLIF(row_data->>'Kota',             ''), '-')    AS kota,
      COALESCE(NULLIF(row_data->>'Provinsi',         ''), '-')    AS provinsi,
      COALESCE(NULLIF(row_data->>'ID Upline',        ''), '-')    AS id_upline,
      COALESCE(NULLIF(row_data->>'Nama Paket',       ''), '-')    AS nama_paket,
      NULLIF(row_data->>'Tanggal Aktivasi',          '')          AS tgl_aktivasi
    FROM iq_raw_outlet
    WHERE COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) IS NOT NULL
    ORDER BY COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')), bulan DESC
  `);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

async function aggOutletPerf(bulan, maxDay = null) {
  if (!bulan) return new Map();
  const params = [bulan];
  let df = '';
  if (maxDay !== null) {
    params.push(maxDay);
    df = `AND row_data->>'Tanggal' IS NOT NULL
          AND EXTRACT(DAY FROM (row_data->>'Tanggal')::date) <= $2`;
  }
  const res = await pool.query(`
    SELECT
      row_data->>'ID Outlet'                                        AS id_outlet,
      COALESCE(SUM((row_data->>'Jumlah Transaksi')::numeric), 0)   AS total_trx,
      COALESCE(SUM((row_data->>'Jumlah Omzet')::numeric), 0)       AS total_omzet,
      COALESCE(SUM((row_data->>'Margin')::numeric), 0)             AS total_margin,
      COUNT(DISTINCT row_data->>'Tanggal')                         AS days_active
    FROM iq_raw_trx
    WHERE bulan=$1
      AND row_data->>'ID Outlet' IS NOT NULL AND row_data->>'ID Outlet' <> ''
      ${df}
    GROUP BY row_data->>'ID Outlet'
  `, params);
  return new Map(res.rows.map(r => [r.id_outlet, r]));
}

function territoryCluster(provinsi) {
  const p = (provinsi || '').toLowerCase();
  if (/jawa|jakarta|banten|yogyakarta/.test(p))                                         return 'Jawa';
  if (/sumatera|sumatra|aceh|riau|jambi|bengkulu|lampung|bangka|kepulauan riau/.test(p))return 'Sumatera';
  if (/kalimantan/.test(p))                                                             return 'Kalimantan';
  if (/sulawesi|gorontalo/.test(p))                                                     return 'Sulawesi';
  if (/bali|nusa tenggara/.test(p))                                                     return 'Bali & Nusa Tenggara';
  if (/maluku/.test(p))                                                                 return 'Maluku';
  if (/papua/.test(p))                                                                  return 'Papua';
  return 'Lainnya';
}

// GET /api/data-raw/outlet-analytics?bulan=2026-06
async function outletAnalyticsHandler(req, res) {
  let { bulan } = req.query;
  try {
    const blRes = await pool.query(`SELECT DISTINCT bulan FROM iq_raw_trx ORDER BY bulan DESC`);
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const b1 = bulan, b2 = prevBulanStr(b1), b3 = prevBulanStr(b2);

    const maxTglRes = await pool.query(
      `SELECT MAX(row_data->>'Tanggal') AS max_tgl FROM iq_raw_trx WHERE bulan=$1 AND row_data->>'Tanggal' IS NOT NULL`,
      [b1]
    );
    const maxTgl = maxTglRes.rows[0]?.max_tgl;
    const maxDay = maxTgl ? parseInt(String(maxTgl).slice(8, 10), 10) : null;

    const [catalog, junMap, meiMap, aprMap, percRes, dailyRes] = await Promise.all([
      getFullOutletCatalog(),
      aggOutletPerf(b1, null),
      aggOutletPerf(b2, maxDay),
      aggOutletPerf(b3, maxDay),

      pool.query(`
        SELECT
          percentile_cont(0.25) WITHIN GROUP (ORDER BY total_trx)    AS trx_p25,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY total_trx)    AS trx_p50,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY total_trx)    AS trx_p75,
          percentile_cont(0.90) WITHIN GROUP (ORDER BY total_trx)    AS trx_p90,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY total_margin) AS margin_p75,
          AVG(CASE WHEN total_trx > 0 THEN total_margin / total_trx END) AS avg_mpt
        FROM (
          SELECT SUM((row_data->>'Jumlah Transaksi')::numeric) AS total_trx,
                 SUM((row_data->>'Margin')::numeric)           AS total_margin
          FROM iq_raw_trx WHERE bulan=$1
            AND row_data->>'ID Outlet' IS NOT NULL AND row_data->>'ID Outlet' <> ''
          GROUP BY row_data->>'ID Outlet'
          HAVING SUM((row_data->>'Jumlah Transaksi')::numeric) > 0
        ) x
      `, [b1]),

      pool.query(`
        SELECT bulan,
          row_data->>'Tanggal'                                       AS tanggal,
          COALESCE(SUM((row_data->>'Jumlah Transaksi')::numeric), 0) AS trx,
          COALESCE(SUM((row_data->>'Jumlah Omzet')::numeric), 0)     AS omzet,
          COALESCE(SUM((row_data->>'Margin')::numeric), 0)           AS margin,
          COUNT(DISTINCT row_data->>'ID Outlet')                     AS active_outlets
        FROM iq_raw_trx
        WHERE bulan = ANY($1::text[]) AND row_data->>'Tanggal' IS NOT NULL
        GROUP BY bulan, row_data->>'Tanggal'
        ORDER BY bulan, tanggal
      `, [[b1, b2]]),
    ]);

    const p = percRes.rows[0] || {};
    const trxP25 = +p.trx_p25 || 2, trxP50 = +p.trx_p50 || 10;
    const trxP75 = +p.trx_p75 || 34, trxP90 = +p.trx_p90 || 89;
    const marginP75 = +p.margin_p75 || 0, avgMpt = +p.avg_mpt || 0;

    const allIds = new Set([...junMap.keys(), ...meiMap.keys(), ...aprMap.keys()]);
    const outlets = [];

    for (const id of allIds) {
      const j = junMap.get(id), m = meiMap.get(id), a = aprMap.get(id);
      const info = catalog.get(id);
      const jun_trx = j ? +j.total_trx : 0, jun_omzet = j ? +j.total_omzet : 0;
      const jun_margin = j ? +j.total_margin : 0, days_active = j ? +j.days_active : 0;
      const mei_trx = m ? +m.total_trx : 0, mei_margin = m ? +m.total_margin : 0;
      const apr_trx = a ? +a.total_trx : 0;
      if (jun_trx === 0 && mei_trx === 0 && apr_trx === 0) continue;

      const dev_trx = jun_trx - mei_trx, dev_margin = jun_margin - mei_margin;
      const growth_pct = mei_trx > 0 ? ((jun_trx - mei_trx) / mei_trx) * 100 : null;
      const avg_daily = days_active > 0 ? jun_trx / days_active : 0;
      const mpt = jun_trx > 0 ? jun_margin / jun_trx : 0;

      let seg;
      if      (jun_trx === 0 && mei_trx > 0)                     seg = 'churn';
      else if (jun_trx > 0 && mei_trx === 0 && apr_trx > 0)      seg = 'reaktivasi';
      else if (jun_trx > 0 && mei_trx === 0)                     seg = 'baru_aktif';
      else if (jun_trx >= trxP75 && jun_margin >= marginP75)      seg = 'superstar';
      else if (growth_pct !== null && growth_pct >= 20)           seg = 'tumbuh';
      else if (growth_pct !== null && growth_pct <= -25)          seg = 'at_risk';
      else if (growth_pct !== null && growth_pct <  -10)          seg = 'turun';
      else                                                        seg = 'stabil';

      outlets.push({
        id_outlet: id,
        nama_merchant: info?.nama_merchant || '-',
        kategori:      info?.kategori      || 'Lainnya',
        kota:          info?.kota          || '-',
        provinsi:      info?.provinsi      || '-',
        id_upline:     info?.id_upline     || '-',
        tgl_aktivasi:  info?.tgl_aktivasi  || null,
        territory_cluster: territoryCluster(info?.provinsi || ''),
        jun_trx, jun_margin, days_active,
        mei_trx, mei_margin, apr_trx,
        dev_trx, dev_margin,
        growth_pct:      growth_pct !== null ? Math.round(growth_pct * 10) / 10 : null,
        avg_daily:       Math.round(avg_daily * 10) / 10,
        mpt:             Math.round(mpt * 100) / 100,
        consistency_pct: maxDay ? Math.round(days_active / maxDay * 100) : null,
        segment:         seg,
      });
    }

    const sc = {};
    for (const o of outlets) sc[o.segment] = (sc[o.segment] || 0) + 1;

    const junAct = outlets.filter(o => o.jun_trx > 0);
    const meiAct = outlets.filter(o => o.mei_trx > 0);
    const totTJ = junAct.reduce((s, o) => s + o.jun_trx, 0);
    const totTM = meiAct.reduce((s, o) => s + o.mei_trx, 0);
    const totMJ = junAct.reduce((s, o) => s + o.jun_margin, 0);
    const totMM = meiAct.reduce((s, o) => s + o.mei_margin, 0);

    const byTrx    = [...outlets].filter(o => o.jun_trx > 0).sort((a,b) => b.jun_trx    - a.jun_trx);
    const byMargin = [...outlets].filter(o => o.jun_margin > 0).sort((a,b) => b.jun_margin - a.jun_margin);
    const bothAct  = outlets.filter(o => o.jun_trx > 0 && o.mei_trx > 0 && o.growth_pct !== null);
    const byGrow   = [...bothAct].sort((a,b) => b.growth_pct - a.growth_pct);
    const byDrop   = [...bothAct].sort((a,b) => a.growth_pct - b.growth_pct);
    const churnL   = outlets.filter(o => o.segment === 'churn').sort((a,b) => b.mei_trx - a.mei_trx);

    // Daily trend: align by day number
    const junDay = {}, meiDay = {};
    for (const r of dailyRes.rows) {
      const tgl = String(r.tanggal).slice(0, 10);
      const dn  = tgl.slice(8, 10);
      if (r.bulan === b1) junDay[tgl] = { tanggal: tgl, day: dn, trx: +r.trx, omzet: +r.omzet, margin: +r.margin, outlets: +r.active_outlets };
      else if (r.bulan === b2) meiDay[dn] = { trx: +r.trx, margin: +r.margin, outlets: +r.active_outlets };
    }
    const daily_trend = Object.values(junDay).sort((a,b) => a.tanggal.localeCompare(b.tanggal)).map(d => ({
      ...d,
      mei_trx:     meiDay[d.day]?.trx     || 0,
      mei_margin:  meiDay[d.day]?.margin  || 0,
      mei_outlets: meiDay[d.day]?.outlets || 0,
    }));

    res.json({
      bulan, b1, b2, b3, bulan_list: bulanList,
      mtd_info: {
        max_tgl: maxTgl, max_day: maxDay,
        b1_label: maxDay ? `${b1} (1-${maxDay})` : b1,
        b2_label: maxDay ? `${b2} (1-${maxDay})` : b2,
        is_mtd:   maxDay !== null && maxDay < 28,
      },
      summary: {
        outlet_aktif_jun:  junAct.length,
        outlet_aktif_mei:  meiAct.length,
        dev_outlet:        junAct.length - meiAct.length,
        churn_count:       sc.churn      || 0,
        baru_count:        sc.baru_aktif || 0,
        reaktivasi_count:  sc.reaktivasi || 0,
        superstar_count:   sc.superstar  || 0,
        tumbuh_count:      sc.tumbuh     || 0,
        stabil_count:      sc.stabil     || 0,
        at_risk_count:     sc.at_risk    || 0,
        turun_count:       sc.turun      || 0,
        total_trx_jun:     totTJ, total_trx_mei: totTM,
        total_margin_jun:  totMJ, total_margin_mei: totMM,
        dev_trx:           totTJ - totTM,
        dev_margin:        totMJ - totMM,
        avg_trx_per_outlet:    junAct.length ? Math.round(totTJ / junAct.length) : 0,
        avg_margin_per_outlet: junAct.length ? Math.round(totMJ / junAct.length) : 0,
      },
      thresholds: { trx_p25: trxP25, trx_p50: trxP50, trx_p75: trxP75, trx_p90: trxP90, margin_p75: marginP75, avg_mpt: avgMpt },
      segment_dist: [
        { key: 'superstar',  label: 'Superstar',  count: sc.superstar  || 0, color: '#7C3AED' },
        { key: 'tumbuh',     label: 'Tumbuh',     count: sc.tumbuh     || 0, color: '#059669' },
        { key: 'stabil',     label: 'Stabil',     count: sc.stabil     || 0, color: '#3B82F6' },
        { key: 'turun',      label: 'Turun',      count: sc.turun      || 0, color: '#F59E0B' },
        { key: 'at_risk',    label: 'At Risk',    count: sc.at_risk    || 0, color: '#EF4444' },
        { key: 'churn',      label: 'Churn',      count: sc.churn      || 0, color: '#DC2626' },
        { key: 'baru_aktif', label: 'Baru Aktif', count: sc.baru_aktif || 0, color: '#10B981' },
        { key: 'reaktivasi', label: 'Reaktivasi', count: sc.reaktivasi || 0, color: '#F97316' },
      ],
      outlets,
      daily_trend,
      action: {
        selamatkan: churnL.slice(0, 50),
        hubungi:    byGrow.filter(o => o.jun_trx >= trxP50).slice(0, 50),
        reward:     byTrx.filter(o => o.segment === 'superstar').slice(0, 30),
        reaktivasi: outlets.filter(o => o.jun_trx === 0 && o.mei_trx === 0 && o.apr_trx > 0).sort((a,b) => b.apr_trx - a.apr_trx).slice(0, 50),
        optimasi:   byTrx.filter(o => o.jun_trx >= trxP75 && o.mpt < avgMpt).slice(0, 50),
      },
    });
  } catch (e) {
    console.error('[outlet-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Affiliate Analytics ───────────────────────────────────────────────────
async function affiliateAnalyticsHandler(req, res) {
  let { bulan } = req.query;
  try {
    const blRes = await pool.query(`SELECT DISTINCT bulan FROM iq_raw_outlet ORDER BY bulan DESC`);
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const [uplineRes, summaryRes] = await Promise.all([
      pool.query(`
        WITH
        qris_latest AS (
          SELECT DISTINCT ON (row_data->>'id_outlet')
            row_data->>'id_outlet' AS id_outlet,
            row_data->>'status' AS qris_status
          FROM iq_raw_qris
          WHERE bulan = (SELECT MAX(bulan) FROM iq_raw_qris)
          ORDER BY row_data->>'id_outlet', row_data->>'tanggal' DESC
        ),
        trx_by_outlet AS (
          SELECT
            row_data->>'ID Outlet' AS id_outlet,
            SUM(COALESCE(NULLIF(row_data->>'Jumlah Transaksi','')::numeric, 0)) AS total_trx,
            SUM(COALESCE(NULLIF(row_data->>'Margin','')::numeric, 0))           AS total_margin,
            SUM(COALESCE(NULLIF(row_data->>'Jumlah Omzet','')::numeric, 0))     AS total_omzet
          FROM iq_raw_trx WHERE bulan = $1
          GROUP BY row_data->>'ID Outlet'
        ),
        aff_info AS (
          SELECT
            (row_data->>'ID Upline / ID Outlet')::text AS id_upline,
            row_data->>'Nama Pemilik'                  AS nama_pemilik,
            row_data->>'No. HP'                        AS no_hp,
            COALESCE(NULLIF(row_data->>'Komisi','')::numeric, 0) AS komisi
          FROM iq_raw_affiliate
          WHERE bulan = $1 AND row_data ? 'ID Upline / ID Outlet'
        ),
        outlets AS (
          SELECT
            COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) AS id_outlet,
            NULLIF(row_data->>'ID Upline','') AS id_upline,
            NULLIF(row_data->>'Tanggal Aktivasi','') AS tgl_akt
          FROM iq_raw_outlet
          WHERE bulan = $1
            AND COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) IS NOT NULL
            AND NULLIF(row_data->>'ID Upline','') IS NOT NULL
        )
        SELECT
          o.id_upline,
          COALESCE(MAX(a.nama_pemilik), o.id_upline)    AS nama_pemilik,
          MAX(a.no_hp)                                   AS no_hp,
          COALESCE(MAX(a.komisi), 0)                     AS komisi,
          COUNT(*)                                        AS total_downline,
          COUNT(*) FILTER (WHERE o.tgl_akt IS NULL)      AS registrasi_only,
          COUNT(*) FILTER (WHERE o.tgl_akt IS NOT NULL)  AS sudah_aktivasi,
          COUNT(*) FILTER (WHERE COALESCE(t.total_trx,0)>0) AS dengan_trx,
          COUNT(*) FILTER (WHERE q.qris_status='Terbit')        AS qris_terbit,
          COUNT(*) FILTER (WHERE q.qris_status='Belum Terbit')  AS qris_belum_terbit,
          COUNT(*) FILTER (WHERE q.qris_status='Perbaikan Data')AS qris_perbaikan,
          COUNT(*) FILTER (WHERE q.qris_status='Rejected')      AS qris_rejected,
          COUNT(*) FILTER (WHERE q.id_outlet IS NULL)            AS qris_tidak_diajukan,
          COALESCE(SUM(t.total_trx),    0)::bigint AS total_trx,
          COALESCE(SUM(t.total_margin), 0)         AS total_margin,
          COALESCE(SUM(t.total_omzet),  0)         AS total_omzet
        FROM outlets o
        LEFT JOIN qris_latest     q ON o.id_outlet = q.id_outlet
        LEFT JOIN trx_by_outlet   t ON o.id_outlet = t.id_outlet
        LEFT JOIN aff_info        a ON o.id_upline  = a.id_upline
        GROUP BY o.id_upline
        ORDER BY COUNT(*) DESC
      `, [bulan]),

      pool.query(`
        SELECT
          COUNT(DISTINCT NULLIF(row_data->>'ID Upline','')) AS total_upline,
          COUNT(*) AS total_downline
        FROM iq_raw_outlet
        WHERE bulan = $1
          AND NULLIF(row_data->>'ID Upline','') IS NOT NULL
          AND COALESCE(NULLIF(row_data->>'ID Outlet',''), NULLIF(row_data->>'D Outlet','')) IS NOT NULL
      `, [bulan]),
    ]);

    const uplines = uplineRes.rows.map(r => {
      const td = +r.total_downline, sa = +r.sudah_aktivasi, dt = +r.dengan_trx;
      return {
        id_upline:            r.id_upline,
        nama_pemilik:         r.nama_pemilik,
        no_hp:                r.no_hp,
        komisi:               +r.komisi || 0,
        total_downline:       td,
        registrasi_only:      +r.registrasi_only,
        sudah_aktivasi:       sa,
        dengan_trx:           dt,
        qris_terbit:          +r.qris_terbit,
        qris_belum_terbit:    +r.qris_belum_terbit,
        qris_perbaikan:       +r.qris_perbaikan,
        qris_rejected:        +r.qris_rejected,
        qris_tidak_diajukan:  +r.qris_tidak_diajukan,
        total_trx:            +r.total_trx,
        total_margin:         +r.total_margin,
        total_omzet:          +r.total_omzet,
        aktivasi_rate: td > 0 ? +((sa / td) * 100).toFixed(1) : 0,
        trx_rate:      sa > 0 ? +((dt / sa) * 100).toFixed(1) : 0,
      };
    });

    const sm = summaryRes.rows[0] || {};
    const totalAktivasi  = uplines.reduce((s, u) => s + u.sudah_aktivasi,   0);
    const totalDgnTrx    = uplines.reduce((s, u) => s + u.dengan_trx,       0);
    const totalTrx       = uplines.reduce((s, u) => s + u.total_trx,        0);
    const totalMargin    = uplines.reduce((s, u) => s + u.total_margin,      0);
    const totalQrisTerbit= uplines.reduce((s, u) => s + u.qris_terbit,      0);
    const totalQrisBelum = uplines.reduce((s, u) => s + u.qris_belum_terbit,0);
    const totalQrisPerbaikan = uplines.reduce((s, u) => s + u.qris_perbaikan,0);
    const td = +sm.total_downline || 0;

    res.json({
      bulan, bulan_list: bulanList,
      summary: {
        total_upline:      +sm.total_upline || 0,
        total_downline:    td,
        registrasi_only:   td - totalAktivasi,
        sudah_aktivasi:    totalAktivasi,
        dengan_trx:        totalDgnTrx,
        qris_terbit:       totalQrisTerbit,
        qris_belum_terbit: totalQrisBelum,
        qris_perbaikan:    totalQrisPerbaikan,
        total_trx:         totalTrx,
        total_margin:      +totalMargin.toFixed(2),
        aktivasi_rate: td > 0 ? +((totalAktivasi / td) * 100).toFixed(1) : 0,
        trx_rate: totalAktivasi > 0 ? +((totalDgnTrx / totalAktivasi) * 100).toFixed(1) : 0,
      },
      uplines,
    });
  } catch (e) {
    console.error('[affiliate-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function affiliateDownlinesHandler(req, res) {
  let { upline, bulan } = req.query;
  if (!upline) return res.status(400).json({ error: 'upline wajib' });
  try {
    const blRes = await pool.query(`SELECT DISTINCT bulan FROM iq_raw_outlet ORDER BY bulan DESC`);
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulan || !bulanList.includes(bulan)) bulan = bulanList[0];

    const r = await pool.query(`
      WITH
      qris_latest AS (
        SELECT DISTINCT ON (row_data->>'id_outlet')
          row_data->>'id_outlet' AS id_outlet,
          row_data->>'status'    AS qris_status,
          COALESCE(NULLIF(row_data->>'nmid',''), '-') AS nmid
        FROM iq_raw_qris
        WHERE bulan = (SELECT MAX(bulan) FROM iq_raw_qris)
        ORDER BY row_data->>'id_outlet', row_data->>'tanggal' DESC
      ),
      trx_agg AS (
        SELECT
          row_data->>'ID Outlet' AS id_outlet,
          SUM(COALESCE(NULLIF(row_data->>'Jumlah Transaksi','')::numeric, 0)) AS total_trx,
          SUM(COALESCE(NULLIF(row_data->>'Margin','')::numeric, 0))           AS total_margin,
          SUM(COALESCE(NULLIF(row_data->>'Jumlah Omzet','')::numeric, 0))     AS total_omzet
        FROM iq_raw_trx WHERE bulan = $1
        GROUP BY row_data->>'ID Outlet'
      )
      SELECT
        COALESCE(NULLIF(o.row_data->>'ID Outlet',''), NULLIF(o.row_data->>'D Outlet','')) AS id_outlet,
        o.row_data->>'Nama Merchant'      AS nama_merchant,
        o.row_data->>'Kota'               AS kota,
        o.row_data->>'Nama Paket'         AS nama_paket,
        o.row_data->>'Nama Kategori'      AS nama_kategori,
        NULLIF(o.row_data->>'Tanggal Registrasi','') AS tgl_reg,
        NULLIF(o.row_data->>'Tanggal Aktivasi','')   AS tgl_akt,
        COALESCE(q.qris_status, '-') AS qris_status,
        COALESCE(q.nmid, '-')        AS nmid,
        COALESCE(t.total_trx,    0)::bigint AS total_trx,
        COALESCE(t.total_margin, 0)         AS total_margin,
        COALESCE(t.total_omzet,  0)         AS total_omzet
      FROM iq_raw_outlet o
      LEFT JOIN qris_latest q ON
        COALESCE(NULLIF(o.row_data->>'ID Outlet',''), NULLIF(o.row_data->>'D Outlet','')) = q.id_outlet
      LEFT JOIN trx_agg t ON
        COALESCE(NULLIF(o.row_data->>'ID Outlet',''), NULLIF(o.row_data->>'D Outlet','')) = t.id_outlet
      WHERE o.bulan = $1
        AND NULLIF(o.row_data->>'ID Upline','') = $2
      ORDER BY COALESCE(t.total_trx, 0) DESC, o.row_data->>'Tanggal Registrasi' DESC
    `, [bulan, upline]);

    res.json({ bulan, upline, downlines: r.rows });
  } catch (e) {
    console.error('[affiliate-downlines]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── GET routes ────────────────────────────────────────────────────────────
router.get('/analytics',         analyticsRawHandler);
router.get('/trendline',         trendlineRawHandler);
router.get('/qris-analytics',    qrisAnalyticsHandler);
router.get('/outlet-analytics',  outletAnalyticsHandler);
router.get('/affiliate-analytics/downlines', affiliateDownlinesHandler);
router.get('/affiliate-analytics',           affiliateAnalyticsHandler);
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
