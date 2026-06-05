const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/scoreboard.json');
const SECRET_TOKEN = process.env.APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret';

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// POST /api/scoreboard/sync — Apps Script pushes data here
router.post('/sync', (req, res) => {
  const { token, bulan, synced_at, units } = req.body;

  if (token !== SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    ensureDataDir();
    const existing = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      : {};

    existing[bulan || 'JUN_2026'] = { synced_at, units };
    fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
    console.log(`Synced ${units?.length} units for ${bulan}`);
    res.json({ success: true, units: units?.length });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scoreboard/units — Frontend reads data
router.get('/units', (req, res) => {
  const { bulan = 'JUN_2026', metric = 'kpi' } = req.query;

  try {
    if (!fs.existsSync(DATA_FILE)) {
      return res.status(404).json({ error: 'Belum ada data. Silakan sync dari Google Sheets.' });
    }

    const allData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const bulanData = allData[bulan];

    if (!bulanData) {
      return res.status(404).json({ error: `Data untuk ${bulan} belum tersedia.` });
    }

    const units = bulanData.units || [];

    const sorted = [...units].sort((a, b) =>
      metric === 'rev' ? b.juni - a.juni : b.est_kpi_juni - a.est_kpi_juni
    );

    const rankings = sorted.map((u, i) => {
      const words = u.nama.trim().split(' ');
      const inisial = words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : u.nama.substring(0, 2).toUpperCase();

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
      synced_at: bulanData.synced_at || new Date().toISOString(),
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
    console.error('Scoreboard read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
