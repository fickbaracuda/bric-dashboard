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

const SUB_UNIT_NAMES = ['SpeedCash', 'Travel B2C', 'Pulsagram'];
const WARNA_MAP = {
  'SpeedCash':  '#EF4444',
  'Travel B2C': '#1D9E75',
  'Pulsagram':  '#378ADD'
};

// GET /api/dompetdigital?bulan=JUN_2026
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

    const grupRow  = allRows.find(r => r.nama === 'DOMPET DIGITAL SPEEDCASH') || {};
    const subRows  = SUB_UNIT_NAMES.map(nama => allRows.find(r => r.nama === nama) || { nama });

    const totalJuniGrup = grupRow.juni || subRows.reduce((s, r) => s + (r.juni || 0), 0);

    const subUnits = subRows.map(row => {
      const juni       = row.juni          || 0;
      const targetRkap = row.target_rkap   || 0;
      const estRevJuni = row.est_rev_juni  || 0;
      const gapSurplus = estRevJuni - targetRkap;
      const isBermasalah = gapSurplus < 0;
      const revPerHari   = isBermasalah && daysLeft > 0
        ? Math.round(Math.abs(gapSurplus) / daysLeft)
        : 0;
      const kontribusiPct = totalJuniGrup > 0
        ? parseFloat((juni / totalJuniGrup * 100).toFixed(2))
        : 0;

      return {
        nama:                    row.nama,
        warna:                   WARNA_MAP[row.nama] || '#9CA3AF',
        juni,
        target_rkap:             targetRkap,
        est_rev_juni:            estRevJuni,
        real_kpi:                row.real_kpi     || 0,
        est_kpi_juni:            row.est_kpi_juni || 0,
        status:                  row.status       || 'Aman',
        kontribusi_pct:          kontribusiPct,
        gap_surplus:             gapSurplus,
        rev_per_hari_dibutuhkan: revPerHari,
        is_bermasalah:           isBermasalah
      };
    });

    const unitBermasalah = subUnits.filter(u => u.is_bermasalah).map(u => u.nama);
    const unitAman       = subUnits.filter(u => !u.is_bermasalah).map(u => u.nama);
    const sorted         = [...subUnits].sort((a, b) => b.est_kpi_juni - a.est_kpi_juni);
    const bestPerformer  = sorted[0]?.nama || '';
    const worstPerformer = sorted[sorted.length - 1]?.nama || '';
    const estRevGrup     = grupRow.est_rev_juni || subUnits.reduce((s, u) => s + u.est_rev_juni, 0);
    const targetRkapGrup = grupRow.target_rkap  || subUnits.reduce((s, u) => s + u.target_rkap,  0);
    const gapSurplusGrup = estRevGrup - targetRkapGrup;

    let trenHarian = [];
    try {
      const result = await pool.query(`
        SELECT
          tanggal,
          MAX(CASE WHEN unit_nama = 'SpeedCash'  THEN juni END) AS speedcash,
          MAX(CASE WHEN unit_nama = 'Travel B2C' THEN juni END) AS travel_b2c,
          MAX(CASE WHEN unit_nama = 'Pulsagram'  THEN juni END) AS pulsagram
        FROM daily_snapshot
        WHERE bulan = $1
          AND unit_nama IN ('SpeedCash', 'Travel B2C', 'Pulsagram')
        GROUP BY tanggal
        ORDER BY tanggal ASC
      `, [bulan]);

      const rows = result.rows;
      trenHarian = rows.map((row, i) => {
        if (i === 0) return {
          tanggal:    row.tanggal,
          speedcash:  Number(row.speedcash  || 0),
          travel_b2c: Number(row.travel_b2c || 0),
          pulsagram:  Number(row.pulsagram  || 0)
        };
        return {
          tanggal:    row.tanggal,
          speedcash:  Number(row.speedcash  || 0) - Number(rows[i - 1].speedcash  || 0),
          travel_b2c: Number(row.travel_b2c || 0) - Number(rows[i - 1].travel_b2c || 0),
          pulsagram:  Number(row.pulsagram  || 0) - Number(rows[i - 1].pulsagram  || 0)
        };
      });
    } catch (dbErr) {
      console.error('DB error tren harian dompetdigital:', dbErr.message);
    }

    res.json({
      bulan,
      synced_at:    bulanData.synced_at,
      days_elapsed: daysElapsed,
      days_left:    daysLeft,
      total_days:   totalDays,
      grup: {
        nama:         'DOMPET DIGITAL SPEEDCASH',
        juni:         grupRow.juni          || totalJuniGrup,
        target_rkap:  grupRow.target_rkap   || targetRkapGrup,
        est_rev_juni: grupRow.est_rev_juni  || estRevGrup,
        real_kpi:     grupRow.real_kpi      || 0,
        est_kpi_juni: grupRow.est_kpi_juni  || 0,
        status:       grupRow.status        || 'Aman'
      },
      sub_units: subUnits,
      summary: {
        total_rev_grup:   totalJuniGrup,
        est_kpi_grup:     grupRow.est_kpi_juni || 0,
        gap_surplus_grup: gapSurplusGrup,
        unit_bermasalah:  unitBermasalah,
        unit_aman:        unitAman,
        best_performer:   bestPerformer,
        worst_performer:  worstPerformer,
        ada_masalah:      unitBermasalah.length > 0
      },
      tren_harian: trenHarian
    });
  } catch (err) {
    console.error('Dompet Digital route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
