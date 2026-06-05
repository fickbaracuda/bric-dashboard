const express = require('express');
const router = express.Router();
const https = require('https');

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const SECRET_TOKEN = process.env.APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret';

function fetchFromSheet(bulan) {
  return new Promise((resolve, reject) => {
    const url = `${APPS_SCRIPT_URL}?token=${SECRET_TOKEN}&bulan=${bulan}`;

    const get = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location, redirectCount + 1);
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from Apps Script')); }
        });
      }).on('error', reject);
    };

    get(url);
  });
}

router.get('/units', async (req, res) => {
  const { bulan = 'JUN_2026', metric = 'kpi' } = req.query;

  try {
    const sheetData = await fetchFromSheet(bulan);

    if (sheetData.error) {
      return res.status(401).json({ error: sheetData.error });
    }

    const units = sheetData.units || [];

    // Sort by metric
    const sorted = [...units].sort((a, b) => {
      if (metric === 'rev') return b.juni - a.juni;
      return b.est_kpi_juni - a.est_kpi_juni;
    });

    // Assign ranks
    const rankings = sorted.map((u, i) => {
      const inisial = (() => {
        const words = u.nama.trim().split(' ');
        return words.length >= 2
          ? (words[0][0] + words[1][0]).toUpperCase()
          : u.nama.substring(0, 2).toUpperCase();
      })();

      return {
        rank: i + 1,
        nama: u.nama,
        inisial,
        rev_juni: u.juni || 0,
        target_rkap: u.target_rkap || 0,
        real_kpi: u.real_kpi || 0,
        est_kpi_juni: u.est_kpi_juni || 0,
        status: u.status || 'Kritis',
        rank_kemarin: i + 1,
        delta_rank: 0
      };
    });

    const estValues = rankings.map(r => r.est_kpi_juni);
    const unitDiAtasTarget = rankings.filter(r => r.est_kpi_juni >= 100).length;
    const rataRata = estValues.length > 0
      ? estValues.reduce((a, b) => a + b, 0) / estValues.length : 0;

    res.json({
      bulan,
      metric,
      synced_at: sheetData.synced_at || new Date().toISOString(),
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
    console.error('Scoreboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
