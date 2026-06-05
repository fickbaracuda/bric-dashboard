const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const pool    = require('../db');

const DATA_FILE = path.join(__dirname, '../../data/scoreboard.json');

const DAYS_IN_MONTH = {
  JAN:31, FEB:28, MAR:31, APR:30, MEI:31, JUN:30,
  JUL:31, AGU:31, SEP:30, OKT:31, NOV:30, DES:31
};

// GET /api/winme?bulan=JUN_2026
router.get('/', async (req, res) => {
  const { bulan = 'JUN_2026' } = req.query;

  try {
    if (!fs.existsSync(DATA_FILE))
      return res.status(404).json({ error: 'Belum ada data. Silakan sync dari Google Sheets.' });

    const store     = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const bulanData = store[bulan];
    if (!bulanData)
      return res.status(404).json({ error: `Data ${bulan} belum tersedia.` });

    const allRows     = bulanData.all_rows || [];
    const daysElapsed = bulanData.days_elapsed || 1;
    const monthKey    = bulan.split('_')[0];
    const daysInMonth = DAYS_IN_MONTH[monthKey] || 30;
    const daysLeft    = Math.max(daysInMonth - daysElapsed, 0);

    const grupRow  = allRows.find(r => r.nama === 'WINME&INSTAQRIS') || {};
    const winmeRow = allRows.find(r => r.nama === 'Winme')            || {};
    const instaRow = allRows.find(r => r.nama === 'InstaQris')        || {};

    const totalGrupJuni = (winmeRow.juni || 0) + (instaRow.juni || 0);
    const winmePct  = totalGrupJuni > 0 ? (winmeRow.juni || 0) / totalGrupJuni * 100 : 0;
    const instaPct  = totalGrupJuni > 0 ? (instaRow.juni || 0) / totalGrupJuni * 100 : 0;

    const bmsRow   = allRows.find(r => r.nama === 'REVENUE BISNIS BMS') || {};
    const totalBms = bmsRow.juni || 0;
    const kontribBms = totalBms > 0 ? totalGrupJuni / totalBms * 100 : 0;

    const grupJuni   = grupRow.juni || totalGrupJuni;
    const gapTarget  = Math.max((grupRow.target_rkap || 0) - grupJuni, 0);
    const surplus    = (grupRow.est_kpi_juni || 0) >= 100;

    // Tren harian dari PostgreSQL
    let trenHarian = [];
    try {
      const result = await pool.query(`
        SELECT
          tanggal,
          MAX(CASE WHEN unit_nama = 'Winme'     THEN juni END) as winme,
          MAX(CASE WHEN unit_nama = 'InstaQris' THEN juni END) as instaqris
        FROM daily_snapshot
        WHERE bulan = $1
          AND unit_nama IN ('Winme', 'InstaQris')
        GROUP BY tanggal
        ORDER BY tanggal ASC
      `, [bulan]);

      const rows = result.rows;
      trenHarian = rows.map((row, i) => {
        if (i === 0) return {
          tanggal:   row.tanggal,
          winme:     Number(row.winme     || 0),
          instaqris: Number(row.instaqris || 0)
        };
        return {
          tanggal:   row.tanggal,
          winme:     Number(row.winme     || 0) - Number(rows[i-1].winme     || 0),
          instaqris: Number(row.instaqris || 0) - Number(rows[i-1].instaqris || 0)
        };
      });
    } catch (dbErr) {
      console.error('DB error tren harian winme:', dbErr.message);
    }

    res.json({
      bulan,
      synced_at:    bulanData.synced_at,
      days_elapsed: daysElapsed,
      days_left:    daysLeft,
      grup: {
        nama:         'WINME&INSTAQRIS',
        juni:         grupJuni,
        target_rkap:  grupRow.target_rkap  || 0,
        est_rev_juni: grupRow.est_rev_juni || 0,
        real_kpi:     grupRow.real_kpi     || 0,
        est_kpi_juni: grupRow.est_kpi_juni || 0,
        status:       grupRow.status       || 'Aman'
      },
      produk: [
        {
          nama:           'Winme',
          warna:          '#378ADD',
          juni:           winmeRow.juni         || 0,
          target_rkap:    winmeRow.target_rkap  || 0,
          est_rev_juni:   winmeRow.est_rev_juni || 0,
          real_kpi:       winmeRow.real_kpi     || 0,
          est_kpi_juni:   winmeRow.est_kpi_juni || 0,
          status:         winmeRow.status       || 'Aman',
          kontribusi_pct: parseFloat(winmePct.toFixed(2))
        },
        {
          nama:           'InstaQris',
          warna:          '#1D9E75',
          juni:           instaRow.juni         || 0,
          target_rkap:    instaRow.target_rkap  || 0,
          est_rev_juni:   instaRow.est_rev_juni || 0,
          real_kpi:       instaRow.real_kpi     || 0,
          est_kpi_juni:   instaRow.est_kpi_juni || 0,
          status:         instaRow.status       || 'Aman',
          kontribusi_pct: parseFloat(instaPct.toFixed(2))
        }
      ],
      tren_harian: trenHarian,
      summary: {
        total_rev_grup:       grupJuni,
        est_kpi_grup:         grupRow.est_kpi_juni || 0,
        kontribusi_vs_bms_pct: parseFloat(kontribBms.toFixed(2)),
        surplus_target:       surplus,
        gap_target_grup:      gapTarget
      }
    });
  } catch (err) {
    console.error('Winme route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
