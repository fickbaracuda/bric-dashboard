const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/units', async (req, res) => {
  const { bulan = 'JUN_2026', metric = 'kpi', limit = 50 } = req.query;
  const orderBy = metric === 'rev' ? 'p.juni' : 'p.est_kpi_juni';

  try {
    const rankQuery = `
      SELECT
        u.id as unit_id,
        u.nama,
        p.juni,
        p.target_rkap,
        p.real_kpi,
        p.est_kpi_juni,
        p.status,
        RANK() OVER (ORDER BY ${orderBy} DESC NULLS LAST) as rank_sekarang
      FROM pencapaian p
      JOIN units u ON p.unit_id = u.id
      WHERE p.bulan = $1
        AND u.is_subtotal = FALSE
        AND u.nama NOT IN ('A. TOTAL BUSINESS RETAIL','B. TOTAL ESA','REVENUE BISNIS BMS')
      ORDER BY ${orderBy} DESC NULLS LAST
      LIMIT $2
    `;

    const result = await pool.query(rankQuery, [bulan, parseInt(limit)]);
    const rows = result.rows;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yday = yesterday.toISOString().split('T')[0];

    let snapshotMap = {};
    try {
      const snapResult = await pool.query(
        `SELECT unit_id, rank_posisi FROM snapshot_harian WHERE tanggal = $1 AND bulan = $2`,
        [yday, bulan]
      );
      snapResult.rows.forEach(r => { snapshotMap[r.unit_id] = r.rank_posisi; });
    } catch (_) {}

    const rankings = rows.map(r => {
      const rankSekarang = parseInt(r.rank_sekarang);
      const rankKemarin = snapshotMap[r.unit_id] || rankSekarang;
      const deltaRank = rankKemarin - rankSekarang;
      const words = r.nama.trim().split(' ');
      const inisial = words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : r.nama.substring(0, 2).toUpperCase();

      return {
        rank: rankSekarang,
        nama: r.nama,
        inisial,
        rev_juni: parseFloat(r.juni) || 0,
        target_rkap: parseFloat(r.target_rkap) || 0,
        real_kpi: parseFloat(r.real_kpi) || 0,
        est_kpi_juni: parseFloat(r.est_kpi_juni) || 0,
        status: r.status || 'Kritis',
        rank_kemarin: rankKemarin,
        delta_rank: deltaRank
      };
    });

    const estValues = rankings.map(r => r.est_kpi_juni);
    const unitDiAtasTarget = rankings.filter(r => r.est_kpi_juni >= 100).length;
    const rataRata = estValues.length > 0
      ? estValues.reduce((a, b) => a + b, 0) / estValues.length : 0;

    res.json({
      bulan,
      metric,
      synced_at: new Date().toISOString(),
      summary: {
        unit_terbaik: rankings[0] ? { nama: rankings[0].nama, nilai: rankings[0].est_kpi_juni } : null,
        unit_terendah: rankings[rankings.length - 1]
          ? { nama: rankings[rankings.length - 1].nama, nilai: rankings[rankings.length - 1].est_kpi_juni } : null,
        unit_di_atas_target: unitDiAtasTarget,
        rata_rata_est_kpi: parseFloat(rataRata.toFixed(2))
      },
      rankings
    });
  } catch (err) {
    console.error('Scoreboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
