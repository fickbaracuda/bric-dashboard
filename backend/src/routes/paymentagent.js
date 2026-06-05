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

// GET /api/paymentagent?bulan=JUN_2026
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
    const totalDays   = DAYS_IN_MONTH[monthKey] || 30;
    const daysLeft    = Math.max(totalDays - daysElapsed, 1);

    const paRow  = allRows.find(r => r.nama === 'PAYMENT AGENT') || {};
    const bmsRow = allRows.find(r => r.nama === 'REVENUE BISNIS BMS') || {};

    const juni       = paRow.juni          || 0;
    const mei        = paRow.mei           || 0;
    const targetRkap = paRow.target_rkap   || 0;
    const estRevJuni = paRow.est_rev_juni  || 0;
    const avgRevDay  = paRow.avg_rev_day   || (daysElapsed > 0 ? Math.round(juni / daysElapsed) : 0);
    const deltaVsMei = juni - mei;

    const paceIdeal      = totalDays > 0 ? Math.round(targetRkap / totalDays) : 0;
    const paceAktual     = daysElapsed > 0 ? Math.round(juni / daysElapsed) : 0;
    const gapPace        = paceAktual - paceIdeal;
    const revDibutuhkan  = daysLeft > 0 ? Math.round((targetRkap - juni) / daysLeft) : 0;
    const surplusRkap    = estRevJuni - targetRkap;
    const onTrack        = estRevJuni >= targetRkap;

    const bmsJuni        = bmsRow.juni        || 0;
    const bmsTargetRkap  = bmsRow.target_rkap  || 0;
    const bmsEstRev      = bmsRow.est_rev_juni || 0;
    const kontribRevPct  = bmsJuni      > 0 ? parseFloat((juni       / bmsJuni      * 100).toFixed(2)) : 0;
    const kontribRkapPct = bmsTargetRkap > 0 ? parseFloat((targetRkap / bmsTargetRkap * 100).toFixed(2)) : 0;
    const kontribEstPct  = bmsEstRev    > 0 ? parseFloat((estRevJuni  / bmsEstRev    * 100).toFixed(2)) : 0;

    let trenHarian = [];
    try {
      const result = await pool.query(`
        SELECT tanggal, juni AS rev_kumulatif
        FROM daily_snapshot
        WHERE bulan = $1 AND unit_nama = 'PAYMENT AGENT'
        ORDER BY tanggal ASC
      `, [bulan]);

      const rows = result.rows;
      trenHarian = rows.map((row, i) => ({
        tanggal:    row.tanggal,
        rev:        i === 0 ? Number(row.rev_kumulatif) : Number(row.rev_kumulatif) - Number(rows[i - 1].rev_kumulatif),
        pace_ideal: paceIdeal
      }));
    } catch (dbErr) {
      console.error('DB error tren harian paymentagent:', dbErr.message);
    }

    res.json({
      bulan,
      synced_at:    bulanData.synced_at,
      days_elapsed: daysElapsed,
      days_left:    daysLeft,
      total_days:   totalDays,
      unit: {
        nama:         'PAYMENT AGENT',
        juni,
        mei,
        delta_vs_mei: deltaVsMei,
        target_rkap:  targetRkap,
        est_rev_juni: estRevJuni,
        avg_rev_day:  avgRevDay,
        real_kpi:     paRow.real_kpi     || 0,
        est_kpi_juni: paRow.est_kpi_juni || 0,
        status:       paRow.status       || 'Aman'
      },
      pace: {
        pace_ideal_per_hari:     paceIdeal,
        pace_aktual_per_hari:    paceAktual,
        gap_pace:                gapPace,
        rev_dibutuhkan_per_hari: revDibutuhkan,
        surplus_rkap:            surplusRkap,
        on_track:                onTrack
      },
      kontribusi: {
        rev_pct:     kontribRevPct,
        rkap_pct:    kontribRkapPct,
        est_rev_pct: kontribEstPct
      },
      tren_harian: trenHarian
    });
  } catch (err) {
    console.error('Payment Agent route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
