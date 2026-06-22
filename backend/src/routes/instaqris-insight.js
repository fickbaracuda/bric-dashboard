/**
 * InstaQRIS Insight — Analytics & Upload API
 * 4 data sources: iq_outlet, iq_qris, iq_trx, iq_affiliate
 * All GET endpoints require JWT (requireAuth applied in app.js)
 * Upload endpoints also require JWT — uploads are user-initiated
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const multer  = require('multer');
const XLSX    = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-\/\.]+/g, ' ').trim();
}

function findVal(row, aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const n = normKey(alias);
    const k = keys.find(k2 => normKey(k2) === n);
    if (k !== undefined && row[k] !== null && row[k] !== undefined && row[k] !== '') {
      return row[k];
    }
  }
  return null;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    // Excel serial date — days since 1899-12-30
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    return parseDate(d);
  }
  if (typeof val === 'string') {
    val = val.trim();
    if (!val) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.substring(0, 10);
    const m1 = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  }
  return null;
}

function parseNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = String(val)
    .replace(/Rp\s*/gi, '')
    .replace(/\./g, '')   // thousand separator ID
    .replace(/,/g, '.')   // decimal separator ID
    .replace(/[()]/g, m => m === '(' ? '-' : '')
    .replace(/[^0-9\.\-]/g, '')
    .trim();
  return parseFloat(s) || 0;
}

function parseXLS(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Sheet tidak ditemukan dalam file');
  const ws = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { defval: null });
  if (!data.length) throw new Error('Sheet kosong — tidak ada data');
  return data;
}

/* ════════════════════════════════════════
   UPLOAD ENDPOINTS
════════════════════════════════════════ */

/* POST /upload/outlet — upsert master merchant */
router.post('/upload/outlet', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const data = parseXLS(req.file.buffer);

    const C = {
      id_outlet:     ['id outlet','id_outlet','idoutlet','outlet id','merchant id','id merchant','id'],
      nama_merchant: ['nama merchant','nama_merchant','nama','merchant name','nama toko'],
      tgl_registrasi:['tgl registrasi','tgl_registrasi','tanggal registrasi','tgl reg','tgl daftar','registration date'],
      tgl_aktivasi:  ['tgl aktivasi','tgl_aktivasi','tanggal aktivasi','tgl aktif','activation date'],
      paket:         ['paket','package','paket aktivasi','tipe paket','harga paket','nominal paket'],
      kota:          ['kota','city','kabupaten','kota kabupaten','kota/kabupaten'],
      provinsi:      ['provinsi','province','propinsi','prov'],
      mcc:           ['mcc','kode mcc','mcc code'],
      nama_kategori: ['nama kategori','nama_kategori','kategori','category','jenis usaha','tipe usaha'],
      id_upline:     ['id upline','id_upline','upline','upline id','affiliate id','id affiliate','kode upline'],
    };

    let count = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id_outlet = findVal(row, C.id_outlet);
      if (!id_outlet) continue;

      try {
        await pool.query(`
          INSERT INTO iq_outlet
            (id_outlet, nama_merchant, tgl_registrasi, tgl_aktivasi, paket,
             kota, provinsi, mcc, nama_kategori, id_upline, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (id_outlet) DO UPDATE SET
            nama_merchant  = EXCLUDED.nama_merchant,
            tgl_registrasi = COALESCE(EXCLUDED.tgl_registrasi, iq_outlet.tgl_registrasi),
            tgl_aktivasi   = COALESCE(EXCLUDED.tgl_aktivasi,   iq_outlet.tgl_aktivasi),
            paket          = COALESCE(EXCLUDED.paket,          iq_outlet.paket),
            kota           = COALESCE(EXCLUDED.kota,           iq_outlet.kota),
            provinsi       = COALESCE(EXCLUDED.provinsi,       iq_outlet.provinsi),
            mcc            = COALESCE(EXCLUDED.mcc,            iq_outlet.mcc),
            nama_kategori  = COALESCE(EXCLUDED.nama_kategori,  iq_outlet.nama_kategori),
            id_upline      = COALESCE(EXCLUDED.id_upline,      iq_outlet.id_upline),
            updated_at     = NOW()
        `, [
          String(id_outlet).trim(),
          findVal(row, C.nama_merchant) || null,
          parseDate(findVal(row, C.tgl_registrasi)),
          parseDate(findVal(row, C.tgl_aktivasi)),
          findVal(row, C.paket)        || null,
          findVal(row, C.kota)         || null,
          findVal(row, C.provinsi)     || null,
          findVal(row, C.mcc)          ? String(findVal(row, C.mcc)).trim() : null,
          findVal(row, C.nama_kategori)|| null,
          findVal(row, C.id_upline)    ? String(findVal(row, C.id_upline)).trim() : null,
        ]);
        count++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
        if (errors.length >= 20) break;
      }
    }

    res.json({ success: true, count, errors, total: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /upload/qris — upsert QRIS publication status */
router.post('/upload/qris', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const data = parseXLS(req.file.buffer);

    const C = {
      tanggal:   ['tanggal','date','tgl','tanggal penerbitan','tanggal terbit','tanggal update','tgl terbit'],
      id_outlet: ['id outlet','id_outlet','idoutlet','outlet id','merchant id','id merchant','id'],
      status:    ['status','status penerbitan','status qris','status terbit','keterangan','keterangan penerbitan'],
    };

    let count = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id_outlet = findVal(row, C.id_outlet);
      const status    = findVal(row, C.status);
      if (!id_outlet || !status) continue;

      const tanggal = parseDate(findVal(row, C.tanggal));

      try {
        if (tanggal) {
          await pool.query(`
            INSERT INTO iq_qris (tanggal, id_outlet, status, synced_at)
            VALUES ($1,$2,$3,NOW())
            ON CONFLICT (id_outlet, tanggal) DO UPDATE SET
              status    = EXCLUDED.status,
              synced_at = NOW()
          `, [tanggal, String(id_outlet).trim(), String(status).trim()]);
        } else {
          // No date — insert with today, allow duplicates by skipping unique check
          await pool.query(`
            INSERT INTO iq_qris (tanggal, id_outlet, status, synced_at)
            VALUES (CURRENT_DATE,$1,$2,NOW())
            ON CONFLICT (id_outlet, tanggal) DO UPDATE SET
              status    = EXCLUDED.status,
              synced_at = NOW()
          `, [String(id_outlet).trim(), String(status).trim()]);
        }
        count++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
        if (errors.length >= 20) break;
      }
    }

    res.json({ success: true, count, errors, total: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /upload/trx — upsert daily transactions per outlet */
router.post('/upload/trx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const data = parseXLS(req.file.buffer);

    const C = {
      tanggal:      ['tanggal','date','tgl','tanggal trx','tgl trx','transaction date','tgl transaksi'],
      id_outlet:    ['id outlet','id_outlet','idoutlet','outlet id','merchant id','id merchant','id'],
      jumlah_trx:   ['jumlah trx','jumlah transaksi','total trx','volume trx','trx','qty','count','jumlah'],
      jumlah_omzet: ['jumlah omzet','omzet','revenue','total omzet','gmv','amount','nominal','total','nilai'],
    };

    let count = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const tanggal   = parseDate(findVal(row, C.tanggal));
      const id_outlet = findVal(row, C.id_outlet);
      if (!tanggal || !id_outlet) continue;

      const jumlah_trx   = parseNum(findVal(row, C.jumlah_trx));
      const jumlah_omzet = parseNum(findVal(row, C.jumlah_omzet));

      try {
        await pool.query(`
          INSERT INTO iq_trx (tanggal, id_outlet, jumlah_trx, jumlah_omzet, synced_at)
          VALUES ($1,$2,$3,$4,NOW())
          ON CONFLICT (tanggal, id_outlet) DO UPDATE SET
            jumlah_trx   = EXCLUDED.jumlah_trx,
            jumlah_omzet = EXCLUDED.jumlah_omzet,
            synced_at    = NOW()
        `, [tanggal, String(id_outlet).trim(), jumlah_trx, jumlah_omzet]);
        count++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
        if (errors.length >= 20) break;
      }
    }

    res.json({ success: true, count, errors, total: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /upload/affiliate — insert affiliate records */
router.post('/upload/affiliate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const data = parseXLS(req.file.buffer);

    const C = {
      tanggal:   ['tanggal','date','tgl','periode','tanggal rekrutmen'],
      id_upline: ['id upline','id_upline','upline','upline id','affiliate','id affiliate','kode upline'],
      id_outlet: ['id outlet','id_outlet','outlet','downline','id downline','merchant id'],
      jumlah_downline_register: ['jumlah downline','downline register','jumlah recruit','register','total downline','downline'],
      komisi:    ['komisi','commission','komisi affiliate','total komisi','fee','komisi valid'],
    };

    let count = 0;
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id_upline = findVal(row, C.id_upline);
      if (!id_upline) continue;

      try {
        await pool.query(`
          INSERT INTO iq_affiliate
            (tanggal, id_upline, id_outlet, jumlah_downline_register, komisi, synced_at)
          VALUES ($1,$2,$3,$4,$5,NOW())
        `, [
          parseDate(findVal(row, C.tanggal)),
          String(id_upline).trim(),
          findVal(row, C.id_outlet) ? String(findVal(row, C.id_outlet)).trim() : null,
          parseNum(findVal(row, C.jumlah_downline_register)),
          parseNum(findVal(row, C.komisi)),
        ]);
        count++;
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
        if (errors.length >= 20) break;
      }
    }

    res.json({ success: true, count, errors, total: data.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   ANALYTICS ENDPOINTS
════════════════════════════════════════ */

/* GET /overview — status 4 tabel */
router.get('/overview', async (req, res) => {
  try {
    const [outlet, qris, trx, aff] = await Promise.all([
      pool.query(`SELECT COUNT(*) as cnt, MAX(updated_at) as last_update FROM iq_outlet`),
      pool.query(`SELECT COUNT(*) as cnt, MAX(synced_at) as last_update FROM iq_qris`),
      pool.query(`SELECT COUNT(*) as cnt, MAX(synced_at) as last_update FROM iq_trx`),
      pool.query(`SELECT COUNT(*) as cnt, MAX(synced_at) as last_update FROM iq_affiliate`),
    ]);
    res.json({
      outlet:    { count: +outlet.rows[0].cnt,    last_update: outlet.rows[0].last_update },
      qris:      { count: +qris.rows[0].cnt,      last_update: qris.rows[0].last_update },
      trx:       { count: +trx.rows[0].cnt,       last_update: trx.rows[0].last_update },
      affiliate: { count: +aff.rows[0].cnt,       last_update: aff.rows[0].last_update },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /periods — daftar bulan yang tersedia di iq_trx */
router.get('/periods', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT TO_CHAR(DATE_TRUNC('month', tanggal), 'YYYY-MM') as bulan
      FROM iq_trx
      ORDER BY bulan DESC
      LIMIT 24
    `);
    res.json(r.rows.map(x => x.bulan));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /kpi?bulan=YYYY-MM — 5 KPI utama + 2 rasio diagnostik + tren 3 bulan */
router.get('/kpi', async (req, res) => {
  try {
    const bulan = req.query.bulan || null;

    // Latest QRIS status per outlet
    const QRIS_CTE = `
      latest_qris AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      ),
      terbit AS (SELECT id_outlet FROM latest_qris WHERE status = 'Terbit')
    `;

    const periodFilter = bulan
      ? `DATE_TRUNC('month', t.tanggal) = DATE_TRUNC('month', $1::date)`
      : `DATE_TRUNC('month', t.tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    const params = bulan ? [`${bulan}-01`] : [];

    const [kpiR, nmatR, totalR, prevR] = await Promise.all([
      // MAT + total_trx + total_omzet for current period
      pool.query(`
        WITH ${QRIS_CTE}
        SELECT
          COUNT(DISTINCT t.id_outlet)      AS mat,
          COALESCE(SUM(t.jumlah_trx), 0)  AS total_trx,
          COALESCE(SUM(t.jumlah_omzet), 0)AS total_omzet,
          (SELECT COUNT(*) FROM iq_outlet) AS total_outlet,
          (SELECT COUNT(DISTINCT id_outlet) FROM terbit) AS total_terbit
        FROM iq_trx t
        JOIN terbit q ON q.id_outlet = t.id_outlet
        WHERE ${periodFilter} AND t.jumlah_trx > 0
      `, params),

      // NMAT — first transaction ever in this period
      pool.query(`
        WITH ${QRIS_CTE},
        first_trx AS (
          SELECT t.id_outlet, MIN(DATE_TRUNC('month', t.tanggal)) AS first_month
          FROM iq_trx t
          JOIN terbit q ON q.id_outlet = t.id_outlet
          WHERE t.jumlah_trx > 0
          GROUP BY t.id_outlet
        )
        SELECT COUNT(*) AS nmat
        FROM first_trx
        WHERE ${bulan
          ? `first_month = DATE_TRUNC('month', $1::date)`
          : `first_month = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`}
      `, params),

      // Funnel total (all-time MAT)
      pool.query(`
        WITH ${QRIS_CTE}
        SELECT COUNT(DISTINCT t.id_outlet) AS mat_alltime
        FROM iq_trx t
        JOIN terbit q ON q.id_outlet = t.id_outlet
        WHERE t.jumlah_trx > 0
      `),

      // Previous month KPI for MoM
      pool.query(`
        WITH ${QRIS_CTE}
        SELECT
          COUNT(DISTINCT t.id_outlet)      AS mat,
          COALESCE(SUM(t.jumlah_trx), 0)  AS total_trx,
          COALESCE(SUM(t.jumlah_omzet), 0)AS total_omzet
        FROM iq_trx t
        JOIN terbit q ON q.id_outlet = t.id_outlet
        WHERE DATE_TRUNC('month', t.tanggal) = ${bulan
          ? `DATE_TRUNC('month', $1::date) - INTERVAL '1 month'`
          : `(SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx) - INTERVAL '1 month'`}
        AND t.jumlah_trx > 0
      `, params),
    ]);

    const r       = kpiR.rows[0];
    const mat     = +r.mat     || 0;
    const trx     = +r.total_trx   || 0;
    const omzet   = +r.total_omzet || 0;
    const nmat    = +nmatR.rows[0].nmat || 0;
    const terbit  = +r.total_terbit || 0;
    const outlet  = +r.total_outlet || 0;
    const matAll  = +totalR.rows[0].mat_alltime || 0;

    const prev = prevR.rows[0];
    const prevMat   = +prev.mat || 0;
    const prevTrx   = +prev.total_trx || 0;
    const prevOmzet = +prev.total_omzet || 0;
    const prevAtpu  = prevMat > 0 ? prevTrx / prevMat : 0;
    const prevArpu  = prevMat > 0 ? prevOmzet / prevMat : 0;
    const prevArpt  = prevTrx > 0 ? prevOmzet / prevTrx : 0;

    const atpu = mat > 0 ? trx / mat : 0;
    const arpu = mat > 0 ? omzet / mat : 0;
    const arpt = trx > 0 ? omzet / trx : 0;

    const pctChange = (cur, prev) =>
      prev > 0 ? ((cur - prev) / prev * 100).toFixed(1) : null;

    res.json({
      bulan,
      mat,    mat_prev: prevMat,    mat_pct: pctChange(mat, prevMat),
      nmat,
      atpu,   atpu_prev: prevAtpu,  atpu_pct: pctChange(atpu, prevAtpu),
      arpu,   arpu_prev: prevArpu,  arpu_pct: pctChange(arpu, prevArpu),
      arpt,   arpt_prev: prevArpt,  arpt_pct: pctChange(arpt, prevArpt),
      nmat_mat_ratio: mat > 0 ? (nmat / mat * 100).toFixed(1) : 0,
      activation_rate: terbit > 0 ? (mat / terbit * 100).toFixed(1) : 0,
      total_outlet: outlet,
      total_terbit: terbit,
      mat_alltime: matAll,
      total_trx: trx,
      total_omzet: omzet,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /funnel — merchant stages all-time */
router.get('/funnel', async (req, res) => {
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM iq_outlet`),
      pool.query(`
        SELECT COUNT(DISTINCT id_outlet) AS cnt
        FROM (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        ) q WHERE status = 'Terbit'
      `),
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        )
        SELECT COUNT(DISTINCT t.id_outlet) AS cnt
        FROM iq_trx t
        JOIN lq ON lq.id_outlet = t.id_outlet AND lq.status = 'Terbit'
        WHERE t.jumlah_trx > 0
      `),
      pool.query(`
        SELECT COUNT(DISTINCT id_outlet) AS cnt
        FROM (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        ) q WHERE status != 'Terbit'
      `),
    ]);
    const registrasi = +r1.rows[0].cnt;
    const terbit     = +r2.rows[0].cnt;
    const mat        = +r3.rows[0].cnt;
    const non_terbit = +r4.rows[0].cnt;

    res.json({
      registrasi,
      terbit,
      mat,
      non_terbit,
      rate_reg_to_terbit: registrasi > 0 ? (terbit / registrasi * 100).toFixed(1) : 0,
      rate_terbit_to_mat: terbit > 0     ? (mat    / terbit    * 100).toFixed(1) : 0,
      rate_reg_to_mat:    registrasi > 0 ? (mat    / registrasi * 100).toFixed(1) : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /merchants?bulan=YYYY-MM&type=top|dormant|churn&limit=50 */
router.get('/merchants', async (req, res) => {
  try {
    const bulan  = req.query.bulan  || null;
    const type   = req.query.type   || 'top';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

    const QRIS_CTE = `
      WITH lq AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      )
    `;

    const periodExpr = bulan
      ? `DATE_TRUNC('month', t.tanggal) = DATE_TRUNC('month', '${bulan}-01'::date)`
      : `DATE_TRUNC('month', t.tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    if (type === 'top') {
      const r = await pool.query(`
        ${QRIS_CTE}
        SELECT o.id_outlet, o.nama_merchant, o.kota, o.provinsi, o.paket, o.nama_kategori, o.id_upline,
               lq.status AS qris_status,
               COALESCE(SUM(t.jumlah_trx), 0)   AS total_trx,
               COALESCE(SUM(t.jumlah_omzet), 0) AS total_omzet
        FROM iq_outlet o
        LEFT JOIN lq ON lq.id_outlet = o.id_outlet
        LEFT JOIN iq_trx t ON t.id_outlet = o.id_outlet
          AND ${periodExpr} AND t.jumlah_trx > 0
        GROUP BY o.id_outlet, o.nama_merchant, o.kota, o.provinsi, o.paket, o.nama_kategori, o.id_upline, lq.status
        ORDER BY total_omzet DESC
        LIMIT $1
      `, [limit]);
      return res.json(r.rows);
    }

    if (type === 'dormant') {
      // QRIS Terbit tapi tidak ada trx di periode ini
      const r = await pool.query(`
        ${QRIS_CTE}
        SELECT o.id_outlet, o.nama_merchant, o.kota, o.provinsi, o.paket, o.id_upline,
               'Terbit' AS qris_status,
               COALESCE(
                 (SELECT MAX(t2.tanggal) FROM iq_trx t2 WHERE t2.id_outlet = o.id_outlet AND t2.jumlah_trx > 0),
                 NULL
               ) AS last_trx_date,
               COALESCE(
                 (SELECT SUM(t2.jumlah_trx) FROM iq_trx t2 WHERE t2.id_outlet = o.id_outlet),
                 0
               ) AS total_trx_alltime
        FROM iq_outlet o
        JOIN lq ON lq.id_outlet = o.id_outlet AND lq.status = 'Terbit'
        WHERE NOT EXISTS (
          SELECT 1 FROM iq_trx t
          WHERE t.id_outlet = o.id_outlet
            AND ${periodExpr}
            AND t.jumlah_trx > 0
        )
        ORDER BY total_trx_alltime DESC
        LIMIT $1
      `, [limit]);
      return res.json(r.rows);
    }

    if (type === 'churn') {
      // Pernah aktif tapi ≥30 hari tidak transaksi
      const r = await pool.query(`
        ${QRIS_CTE}
        SELECT o.id_outlet, o.nama_merchant, o.kota, o.provinsi, o.id_upline,
               lq.status AS qris_status,
               lt.last_date,
               lt.total_trx,
               (CURRENT_DATE - lt.last_date::date) AS days_inactive
        FROM iq_outlet o
        JOIN lq ON lq.id_outlet = o.id_outlet AND lq.status = 'Terbit'
        JOIN (
          SELECT id_outlet,
                 MAX(tanggal)        AS last_date,
                 SUM(jumlah_trx)     AS total_trx
          FROM iq_trx WHERE jumlah_trx > 0
          GROUP BY id_outlet
        ) lt ON lt.id_outlet = o.id_outlet
        WHERE CURRENT_DATE - lt.last_date::date >= 30
        ORDER BY days_inactive DESC
        LIMIT $1
      `, [limit]);
      return res.json(r.rows);
    }

    res.status(400).json({ error: 'type tidak valid (top|dormant|churn)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /geography?bulan=YYYY-MM&level=provinsi|kota */
router.get('/geography', async (req, res) => {
  try {
    const bulan = req.query.bulan || null;
    const level = req.query.level === 'kota' ? 'kota' : 'provinsi';

    const periodExpr = bulan
      ? `DATE_TRUNC('month', t.tanggal) = DATE_TRUNC('month', '${bulan}-01'::date)`
      : `DATE_TRUNC('month', t.tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    const r = await pool.query(`
      WITH lq AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      ),
      period_trx AS (
        SELECT id_outlet, SUM(jumlah_trx) AS trx, SUM(jumlah_omzet) AS omzet
        FROM iq_trx WHERE ${periodExpr} AND jumlah_trx > 0
        GROUP BY id_outlet
      )
      SELECT
        COALESCE(o.${level}, 'Tidak Diketahui') AS wilayah,
        COUNT(DISTINCT o.id_outlet)                                                        AS total_merchant,
        COUNT(DISTINCT CASE WHEN lq.status = 'Terbit' THEN o.id_outlet END)               AS qris_terbit,
        COUNT(DISTINCT CASE WHEN lq.status IN ('Rejected','Perbaikan Data') THEN o.id_outlet END) AS non_terbit,
        COUNT(DISTINCT pt.id_outlet)                                                       AS mat,
        COALESCE(SUM(pt.omzet), 0)                                                        AS total_omzet,
        COALESCE(SUM(pt.trx),   0)                                                        AS total_trx,
        CASE WHEN COUNT(DISTINCT CASE WHEN lq.status='Terbit' THEN o.id_outlet END) > 0
          THEN ROUND(COUNT(DISTINCT pt.id_outlet) * 100.0 /
               COUNT(DISTINCT CASE WHEN lq.status='Terbit' THEN o.id_outlet END), 1)
          ELSE 0 END                                                                       AS activation_rate
      FROM iq_outlet o
      LEFT JOIN lq ON lq.id_outlet = o.id_outlet
      LEFT JOIN period_trx pt ON pt.id_outlet = o.id_outlet
      WHERE o.${level} IS NOT NULL AND o.${level} != ''
      GROUP BY o.${level}
      ORDER BY total_omzet DESC
      LIMIT 100
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /package?bulan=YYYY-MM — analisis per paket aktivasi */
router.get('/package', async (req, res) => {
  try {
    const bulan = req.query.bulan || null;

    const periodExpr = bulan
      ? `DATE_TRUNC('month', tanggal) = DATE_TRUNC('month', '${bulan}-01'::date)`
      : `DATE_TRUNC('month', tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    const r = await pool.query(`
      WITH lq AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      ),
      period_trx AS (
        SELECT id_outlet, SUM(jumlah_trx) AS trx, SUM(jumlah_omzet) AS omzet
        FROM iq_trx WHERE ${periodExpr} AND jumlah_trx > 0
        GROUP BY id_outlet
      )
      SELECT
        COALESCE(o.paket, 'Tidak Diketahui') AS paket,
        COUNT(DISTINCT o.id_outlet)           AS total_merchant,
        COUNT(DISTINCT CASE WHEN lq.status = 'Terbit' THEN o.id_outlet END) AS qris_terbit,
        COUNT(DISTINCT pt.id_outlet)          AS mat,
        COALESCE(SUM(pt.omzet), 0)           AS total_omzet,
        COALESCE(SUM(pt.trx),   0)           AS total_trx,
        COALESCE(AVG(CASE WHEN pt.id_outlet IS NOT NULL THEN pt.omzet END), 0) AS avg_arpu,
        COALESCE(AVG(CASE WHEN pt.id_outlet IS NOT NULL THEN pt.trx   END), 0) AS avg_atpu
      FROM iq_outlet o
      LEFT JOIN lq ON lq.id_outlet = o.id_outlet
      LEFT JOIN period_trx pt ON pt.id_outlet = o.id_outlet
      GROUP BY o.paket
      ORDER BY total_omzet DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /mcc?bulan=YYYY-MM — analisis per MCC / kategori bisnis */
router.get('/mcc', async (req, res) => {
  try {
    const bulan = req.query.bulan || null;

    const periodExpr = bulan
      ? `DATE_TRUNC('month', tanggal) = DATE_TRUNC('month', '${bulan}-01'::date)`
      : `DATE_TRUNC('month', tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    const r = await pool.query(`
      WITH lq AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      ),
      period_trx AS (
        SELECT id_outlet, SUM(jumlah_trx) AS trx, SUM(jumlah_omzet) AS omzet
        FROM iq_trx WHERE ${periodExpr} AND jumlah_trx > 0
        GROUP BY id_outlet
      )
      SELECT
        COALESCE(o.nama_kategori, o.mcc, 'Tidak Diketahui') AS kategori,
        o.mcc,
        COUNT(DISTINCT o.id_outlet)           AS total_merchant,
        COUNT(DISTINCT CASE WHEN lq.status = 'Terbit' THEN o.id_outlet END) AS qris_terbit,
        COUNT(DISTINCT pt.id_outlet)          AS mat,
        COALESCE(SUM(pt.omzet), 0)           AS total_omzet,
        COALESCE(SUM(pt.trx),   0)           AS total_trx,
        COALESCE(AVG(CASE WHEN pt.id_outlet IS NOT NULL THEN pt.omzet END), 0) AS avg_arpu,
        COALESCE(AVG(CASE WHEN pt.id_outlet IS NOT NULL THEN pt.trx   END), 0) AS avg_atpu
      FROM iq_outlet o
      LEFT JOIN lq ON lq.id_outlet = o.id_outlet
      LEFT JOIN period_trx pt ON pt.id_outlet = o.id_outlet
      GROUP BY o.nama_kategori, o.mcc
      ORDER BY total_omzet DESC
      LIMIT 50
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /qris-quality — kualitas penerbitan QRIS */
router.get('/qris-quality', async (req, res) => {
  try {
    const [summaryR, byAreaR, trendR] = await Promise.all([
      // Summary keseluruhan (latest status per outlet)
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        )
        SELECT
          COUNT(*)                                                              AS total,
          COUNT(CASE WHEN status = 'Terbit' THEN 1 END)                        AS terbit,
          COUNT(CASE WHEN status = 'Perbaikan Data' THEN 1 END)                AS perbaikan,
          COUNT(CASE WHEN status = 'Rejected' THEN 1 END)                      AS rejected,
          COUNT(CASE WHEN status NOT IN ('Terbit','Perbaikan Data','Rejected') THEN 1 END) AS lainnya,
          ROUND(COUNT(CASE WHEN status='Terbit' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1)         AS success_rate,
          ROUND(COUNT(CASE WHEN status='Perbaikan Data' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1) AS perbaikan_rate,
          ROUND(COUNT(CASE WHEN status='Rejected' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1)       AS rejected_rate
        FROM lq
      `),

      // Rejected/Perbaikan per provinsi
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (q.id_outlet) q.id_outlet, q.status, o.provinsi
          FROM iq_qris q
          LEFT JOIN iq_outlet o ON o.id_outlet = q.id_outlet
          ORDER BY q.id_outlet, q.tanggal DESC NULLS LAST, q.id DESC
        )
        SELECT
          COALESCE(provinsi, 'Tidak Diketahui') AS provinsi,
          COUNT(*) AS total,
          COUNT(CASE WHEN status = 'Terbit' THEN 1 END)         AS terbit,
          COUNT(CASE WHEN status != 'Terbit' THEN 1 END)        AS non_terbit,
          ROUND(COUNT(CASE WHEN status='Terbit' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1) AS success_rate
        FROM lq
        WHERE provinsi IS NOT NULL AND provinsi != ''
        GROUP BY provinsi
        ORDER BY non_terbit DESC
        LIMIT 20
      `),

      // Tren per tanggal (submission harian)
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', tanggal), 'YYYY-MM') AS bulan,
          COUNT(*)                                                AS total,
          COUNT(CASE WHEN status='Terbit' THEN 1 END)            AS terbit,
          COUNT(CASE WHEN status='Perbaikan Data' THEN 1 END)    AS perbaikan,
          COUNT(CASE WHEN status='Rejected' THEN 1 END)          AS rejected
        FROM iq_qris
        WHERE tanggal IS NOT NULL
        GROUP BY DATE_TRUNC('month', tanggal)
        ORDER BY DATE_TRUNC('month', tanggal) DESC
        LIMIT 12
      `),
    ]);

    res.json({
      summary:  summaryR.rows[0],
      by_area:  byAreaR.rows,
      trend:    trendR.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /affiliate?bulan=YYYY-MM — leaderboard + quality scores */
router.get('/affiliate', async (req, res) => {
  try {
    const bulan = req.query.bulan || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const periodExpr = bulan
      ? `DATE_TRUNC('month', tanggal) = DATE_TRUNC('month', '${bulan}-01'::date)`
      : `DATE_TRUNC('month', tanggal) = (SELECT DATE_TRUNC('month', MAX(tanggal)) FROM iq_trx)`;

    const [leaderR, summaryR] = await Promise.all([
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        ),
        period_mat AS (
          SELECT DISTINCT id_outlet FROM iq_trx
          WHERE ${periodExpr} AND jumlah_trx > 0
        ),
        period_gmv AS (
          SELECT id_outlet, SUM(jumlah_omzet) AS omzet
          FROM iq_trx WHERE ${periodExpr}
          GROUP BY id_outlet
        ),
        outlet_detail AS (
          SELECT
            o.id_upline,
            o.id_outlet,
            lq.status,
            COALESCE(pm.id_outlet IS NOT NULL, FALSE) AS is_mat,
            COALESCE(pg.omzet, 0)                     AS omzet
          FROM iq_outlet o
          LEFT JOIN lq ON lq.id_outlet = o.id_outlet
          LEFT JOIN period_mat pm ON pm.id_outlet = o.id_outlet
          LEFT JOIN period_gmv pg ON pg.id_outlet = o.id_outlet
          WHERE o.id_upline IS NOT NULL
        )
        SELECT
          id_upline,
          COUNT(*)                                                     AS total_downlines,
          COUNT(CASE WHEN status = 'Terbit' THEN 1 END)               AS terbit_count,
          COUNT(CASE WHEN status = 'Terbit' AND is_mat THEN 1 END)    AS mat_count,
          SUM(omzet)                                                   AS gmv_jaringan,
          COUNT(CASE WHEN status = 'Terbit' THEN 1 END) * 20000       AS komisi_valid,
          COUNT(CASE WHEN status != 'Terbit' OR status IS NULL THEN 1 END) * 20000 AS komisi_pending,
          ROUND(COUNT(CASE WHEN status='Terbit' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1) AS activation_quality,
          ROUND(COUNT(CASE WHEN status='Terbit' AND is_mat THEN 1 END)*100.0/
                NULLIF(COUNT(CASE WHEN status='Terbit' THEN 1 END),0),1)               AS transaction_quality
        FROM outlet_detail
        GROUP BY id_upline
        HAVING COUNT(*) > 0
        ORDER BY komisi_valid DESC
        LIMIT $1
      `, [limit]),

      // Summary total komisi
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        )
        SELECT
          COUNT(DISTINCT o.id_upline)                                          AS total_affiliate,
          COUNT(DISTINCT o.id_outlet)                                          AS total_downlines,
          COUNT(DISTINCT CASE WHEN lq.status='Terbit' THEN o.id_outlet END)   AS total_terbit,
          COUNT(DISTINCT CASE WHEN lq.status='Terbit' THEN o.id_outlet END)*20000 AS total_komisi_valid,
          COUNT(DISTINCT CASE WHEN lq.status!='Terbit' OR lq.status IS NULL THEN o.id_outlet END)*20000 AS total_komisi_pending
        FROM iq_outlet o
        LEFT JOIN lq ON lq.id_outlet = o.id_outlet
        WHERE o.id_upline IS NOT NULL
      `),
    ]);

    res.json({
      leaderboard: leaderR.rows,
      summary:     summaryR.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /cohort — cohort retention matrix (last 8 cohorts) */
router.get('/cohort', async (req, res) => {
  try {
    const [cohortR, churnR] = await Promise.all([
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        ),
        first_trx AS (
          SELECT t.id_outlet, MIN(DATE_TRUNC('month', t.tanggal)) AS cohort_month
          FROM iq_trx t
          JOIN lq ON lq.id_outlet = t.id_outlet AND lq.status = 'Terbit'
          WHERE t.jumlah_trx > 0
          GROUP BY t.id_outlet
        ),
        activity AS (
          SELECT
            ft.id_outlet,
            ft.cohort_month,
            DATE_TRUNC('month', t.tanggal) AS act_month,
            EXTRACT(YEAR FROM AGE(DATE_TRUNC('month', t.tanggal), ft.cohort_month)) * 12 +
            EXTRACT(MONTH FROM AGE(DATE_TRUNC('month', t.tanggal), ft.cohort_month)) AS m_offset
          FROM first_trx ft
          JOIN iq_trx t ON t.id_outlet = ft.id_outlet AND t.jumlah_trx > 0
          WHERE DATE_TRUNC('month', t.tanggal) >= ft.cohort_month
        )
        SELECT
          TO_CHAR(cohort_month, 'YYYY-MM') AS cohort,
          COUNT(DISTINCT id_outlet) AS cohort_size,
          COUNT(DISTINCT CASE WHEN m_offset=0 THEN id_outlet END) AS m0,
          COUNT(DISTINCT CASE WHEN m_offset=1 THEN id_outlet END) AS m1,
          COUNT(DISTINCT CASE WHEN m_offset=2 THEN id_outlet END) AS m2,
          COUNT(DISTINCT CASE WHEN m_offset=3 THEN id_outlet END) AS m3,
          COUNT(DISTINCT CASE WHEN m_offset=4 THEN id_outlet END) AS m4,
          COUNT(DISTINCT CASE WHEN m_offset=5 THEN id_outlet END) AS m5
        FROM activity
        WHERE cohort_month >= NOW() - INTERVAL '12 months'
        GROUP BY cohort_month
        ORDER BY cohort_month DESC
        LIMIT 12
      `),

      // Merchant churn list (≥30 days inactive)
      pool.query(`
        WITH lq AS (
          SELECT DISTINCT ON (id_outlet) id_outlet, status
          FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
        )
        SELECT
          o.id_outlet, o.nama_merchant, o.kota, o.provinsi, o.id_upline,
          lt.last_date,
          lt.total_trx,
          (CURRENT_DATE - lt.last_date::date) AS days_inactive
        FROM iq_outlet o
        JOIN lq ON lq.id_outlet = o.id_outlet AND lq.status = 'Terbit'
        JOIN (
          SELECT id_outlet, MAX(tanggal) AS last_date, SUM(jumlah_trx) AS total_trx
          FROM iq_trx WHERE jumlah_trx > 0
          GROUP BY id_outlet
        ) lt ON lt.id_outlet = o.id_outlet
        WHERE CURRENT_DATE - lt.last_date::date >= 30
        ORDER BY days_inactive DESC
        LIMIT 100
      `),
    ]);

    res.json({
      cohort: cohortR.rows,
      churn:  churnR.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /trend?months=6 — tren KPI bulanan (untuk chart) */
router.get('/trend', async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 6, 12);

    const r = await pool.query(`
      WITH lq AS (
        SELECT DISTINCT ON (id_outlet) id_outlet, status
        FROM iq_qris ORDER BY id_outlet, tanggal DESC NULLS LAST, id DESC
      ),
      terbit AS (SELECT id_outlet FROM lq WHERE status = 'Terbit'),
      monthly AS (
        SELECT
          DATE_TRUNC('month', t.tanggal)                AS bulan,
          COUNT(DISTINCT t.id_outlet)                   AS mat,
          COALESCE(SUM(t.jumlah_trx), 0)               AS total_trx,
          COALESCE(SUM(t.jumlah_omzet), 0)             AS total_omzet
        FROM iq_trx t
        JOIN terbit q ON q.id_outlet = t.id_outlet
        WHERE t.jumlah_trx > 0
        GROUP BY DATE_TRUNC('month', t.tanggal)
        ORDER BY DATE_TRUNC('month', t.tanggal) DESC
        LIMIT $1
      )
      SELECT
        TO_CHAR(bulan, 'YYYY-MM') AS bulan,
        mat,
        total_trx,
        total_omzet,
        CASE WHEN mat > 0 THEN ROUND(total_trx::numeric / mat, 1) ELSE 0 END   AS atpu,
        CASE WHEN mat > 0 THEN ROUND(total_omzet / mat, 0) ELSE 0 END          AS arpu,
        CASE WHEN total_trx > 0 THEN ROUND(total_omzet / total_trx, 0) ELSE 0 END AS arpt
      FROM monthly
      ORDER BY bulan ASC
    `, [months]);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
