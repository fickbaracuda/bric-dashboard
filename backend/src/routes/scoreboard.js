const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');

const DATA_FILE    = path.join(__dirname, '../../data/scoreboard.json');
const SECRET_TOKEN = process.env.APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret';

const EXCLUDE_TOTAL = ['A. TOTAL BUSINESS RETAIL','B. TOTAL ESA','REVENUE BISNIS BMS'];
const TOTAL_ROW_NAME = 'REVENUE BISNIS BMS';

function ensureDir() {
  const d = path.dirname(DATA_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// POST /api/scoreboard/sync
router.post('/sync', (req, res) => {
  const { token, bulan, synced_at, days_elapsed, all_rows } = req.body;
  if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  try {
    ensureDir();
    const store = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : {};

    store[bulan || 'JUN_2026'] = { synced_at, days_elapsed, all_rows };
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    console.log(`Synced ${all_rows?.length} rows for ${bulan}`);
    res.json({ success: true, rows: all_rows?.length });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scoreboard/units
router.get('/units', (req, res) => {
  const { bulan = 'JUN_2026', metric = 'kpi' } = req.query;

  try {
    if (!fs.existsSync(DATA_FILE))
      return res.status(404).json({ error: 'Belum ada data. Silakan sync dari Google Sheets.' });

    const store    = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const bulanData = store[bulan];
    if (!bulanData)
      return res.status(404).json({ error: `Data ${bulan} belum tersedia.` });

    const allRows      = bulanData.all_rows || [];
    const daysElapsed  = bulanData.days_elapsed || 1;

    // Non-subtotal units only (for ranking)
    const units = allRows.filter(r =>
      !r.is_subtotal && EXCLUDE_TOTAL.indexOf(r.nama) === -1
    );

    // Sort by metric
    const sorted = [...units].sort((a, b) =>
      metric === 'rev' ? b.juni - a.juni : b.est_kpi_juni - a.est_kpi_juni
    );

    const rankings = sorted.map((u, i) => {
      const words  = u.nama.trim().split(' ');
      const inisial = words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : u.nama.substring(0, 2).toUpperCase();
      return { rank: i + 1, nama: u.nama, inisial, ...u, rev_juni: u.juni, delta_rank: 0, rank_kemarin: i + 1 };
    });

    // Total row (REVENUE BISNIS BMS)
    const totalRow = allRows.find(r => r.nama === TOTAL_ROW_NAME) || null;

    // Summary
    const totalJuni  = units.reduce((s, u) => s + (u.juni || 0), 0);
    const totalMei   = units.reduce((s, u) => s + (u.mei  || 0), 0);
    const avgRevHari = totalRow?.avg_rev_day || (daysElapsed > 0 ? totalJuni / daysElapsed : 0);

    const byStatus = (s) => units.filter(u => u.status === s).length;

    res.json({
      bulan,
      metric,
      synced_at:    bulanData.synced_at,
      days_elapsed: daysElapsed,
      all_rows:     allRows,
      rankings,
      total_row:    totalRow,
      summary: {
        revenue_juni:       totalJuni,
        revenue_mei:        totalMei,
        delta_vs_mei:       totalJuni - totalMei,
        avg_rev_hari:       Math.round(avgRevHari),
        est_kpi_juni:       totalRow?.est_kpi_juni || 0,
        real_kpi:           totalRow?.real_kpi || 0,
        unit_total:         units.length,
        unit_aman:          byStatus('Aman'),
        unit_waspada:       byStatus('Waspada'),
        unit_awas:          byStatus('Awas'),
        unit_kritis:        byStatus('Kritis'),
        unit_terbaik:       rankings[0] ? { nama: rankings[0].nama, nilai: rankings[0].est_kpi_juni } : null,
        unit_terendah:      rankings[rankings.length - 1]
          ? { nama: rankings[rankings.length - 1].nama, nilai: rankings[rankings.length - 1].est_kpi_juni } : null,
        rata_rata_est_kpi:  parseFloat(
          (units.reduce((s, u) => s + (u.est_kpi_juni || 0), 0) / (units.length || 1)).toFixed(2)
        )
      }
    });
  } catch (err) {
    console.error('Read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
