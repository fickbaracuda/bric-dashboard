const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const pool    = require('../db');

const DATA_FILE = path.join(__dirname, '../../data/scoreboard.json');

function fmtRp(n) {
  if (!n && n !== 0) return 'Rp 0';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

const PAGE_LABEL = {
  scoreboard:        'Unit Scoreboard',
  winme:             'Winme & InstaQris',
  'payment-agent':   'Payment Agent',
  dompet:            'Dompet Digital',
  'scoreboard-tim':  'Scoreboard Tim',
  'leader-scoreboard': 'Leader Scoreboard',
  anggota:           'Profil Anggota',
};

/* ── GET /api/ai-context ── */
router.get('/', async (req, res) => {
  const { page = 'scoreboard', bulan = 'JUN_2026', member_id } = req.query;

  try {
    /* ─ 1. Data Scoreboard (scoreboard.json) ─ */
    const store      = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : {};
    const bulanData  = store[bulan] || {};
    const allRows    = bulanData.all_rows || [];
    const units      = allRows.filter(r => !r.is_subtotal && !r.is_parent);
    const totalRow   = allRows.find(r => r.nama === 'REVENUE BISNIS BMS');
    const daysElapsed = bulanData.days_elapsed || 1;
    const daysLeft    = Math.max(0, 30 - daysElapsed);

    let scoreboardCtx = '[belum ada data scoreboard]';
    if (allRows.length) {
      const sorted      = [...units].sort((a, b) => (b.est_kpi_juni || 0) - (a.est_kpi_juni || 0));
      const byStatus    = s => units.filter(u => u.status === s).map(u => u.nama).join(', ') || '—';

      /* Pace kalkulasi per unit */
      const paceLines = units.map(u => {
        const pace    = daysElapsed > 0 ? (u.juni || 0) / daysElapsed : 0;
        const needed  = daysLeft > 0 ? ((u.target_rkap || 0) - (u.juni || 0)) / daysLeft : 0;
        return `  ${u.nama}: pace aktual ${fmtRp(Math.round(pace))}/hari, butuh ${fmtRp(Math.round(needed))}/hari sisa ${daysLeft} hari`;
      });

      scoreboardCtx = `
=== SCOREBOARD BMS — ${bulan.replace('_', ' ')} ===
Hari berjalan: ${daysElapsed}/30 | Sisa: ${daysLeft} hari | Sync: ${bulanData.synced_at || '—'}

TOTAL BMS: Rev ${fmtRp(totalRow?.juni || 0)} | Est Akhir ${fmtRp(totalRow?.est_rev_juni || 0)} | Est KPI ${totalRow?.est_kpi_juni || 0}% | Status ${totalRow?.status || '—'}

STATUS UNIT:
- Aman   : ${byStatus('Aman')}
- Awas   : ${byStatus('Awas')}
- Kritis : ${byStatus('Kritis')}

RANKING UNIT (Est KPI):
${sorted.map((u, i) =>
  `${i + 1}. ${u.nama}: Rev ${fmtRp(u.juni)}, Target ${fmtRp(u.target_rkap)}, Gap ${fmtRp((u.target_rkap || 0) - (u.juni || 0))}, Est KPI ${u.est_kpi_juni}%, Status ${u.status}`
).join('\n')}

PACE HARIAN:
${paceLines.join('\n')}`;
    }

    /* ─ 2. Data semua Leader & Tim (selalu, semua unit) ─ */
    const UNITS = [
      { key: 'winme_instaqris', label: 'WINME & INSTAQRIS' },
      { key: 'payment_agent',   label: 'PAYMENT AGENT' },
      { key: 'speedcash',       label: 'DOMPET DIGITAL SPEEDCASH' },
    ];

    const { rows: allMembers } = await pool.query(`
      SELECT
        m.id, m.nama, m.posisi, m.fungsi, m.unit, m.leader_id,
        COALESCE(json_agg(
          json_build_object(
            'nama_target',        mt.nama_target,
            'key_result',         mt.key_result,
            'target_revenue',     mt.target_revenue,
            'pencapaian_revenue', mp.pencapaian_revenue,
            'pct_revenue',        mp.pct_revenue,
            'tanggal',            mp.tanggal,
            'catatan',            mp.catatan
          ) ORDER BY mt.urutan
        ) FILTER (WHERE mt.id IS NOT NULL), '[]') AS targets
      FROM members m
      LEFT JOIN member_targets mt ON mt.member_id = m.id
      LEFT JOIN LATERAL (
        SELECT * FROM member_pencapaian WHERE target_id = mt.id ORDER BY tanggal DESC LIMIT 1
      ) mp ON true
      WHERE m.is_active = true
      GROUP BY m.id
      ORDER BY m.unit, m.posisi DESC, m.nama
    `);

    const memberCtxLines = [];
    for (const { key, label } of UNITS) {
      const unitMembers = allMembers.filter(m => m.unit === key);
      if (!unitMembers.length) { memberCtxLines.push(`\n[${label}] — belum ada data anggota`); continue; }

      memberCtxLines.push(`\n=== ${label} ===`);
      const leaders = unitMembers.filter(m => m.posisi === 'leader');
      const allTim  = unitMembers.filter(m => m.posisi === 'tim');

      for (const l of leaders) {
        const myTim   = allTim.filter(t => String(t.leader_id) === String(l.id));
        const targets = l.targets || [];
        const withPct = targets.filter(t => parseFloat(t.pct_revenue) > 0);
        const avgPct  = withPct.length
          ? withPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / withPct.length : null;
        const totalTgt = targets.reduce((s, t) => s + parseFloat(t.target_revenue || 0), 0);
        const totalPen = targets.reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);

        memberCtxLines.push(
          `LEADER ${l.nama}${l.fungsi ? ' (' + l.fungsi + ')' : ''}` +
          ` | KPI rata-rata: ${avgPct !== null ? avgPct.toFixed(1) + '%' : 'belum ada data'}` +
          ` | Pencapaian: ${fmtRp(totalPen)} / ${fmtRp(totalTgt)}` +
          ` | Gap: ${fmtRp(totalTgt - totalPen)}` +
          ` | Tim: ${myTim.length} orang`
        );
        for (const t of targets) {
          const pen = parseFloat(t.pencapaian_revenue || 0);
          const tgt = parseFloat(t.target_revenue || 0);
          memberCtxLines.push(
            `  • Target "${t.nama_target}"${t.key_result ? ' [KR: ' + t.key_result + ']' : ''}` +
            ` | ${fmtRp(pen)} / ${fmtRp(tgt)} | ${t.pct_revenue ? parseFloat(t.pct_revenue).toFixed(1) + '%' : '—'}` +
            `${t.tanggal ? ' | Update: ' + t.tanggal : ''}${t.catatan ? ' | ' + t.catatan : ''}`
          );
        }

        for (const tim of myTim) {
          const timTgt = (tim.targets || []).reduce((s, t) => s + parseFloat(t.target_revenue || 0), 0);
          const timPen = (tim.targets || []).reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);
          const timPct = (tim.targets || []).filter(t => parseFloat(t.pct_revenue) > 0);
          const timAvg = timPct.length
            ? timPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / timPct.length : null;
          memberCtxLines.push(
            `  TIM ${tim.nama}${tim.fungsi ? ' (' + tim.fungsi + ')' : ''}` +
            ` | KPI: ${timAvg !== null ? timAvg.toFixed(1) + '%' : 'belum ada data'}` +
            ` | Pencapaian: ${fmtRp(timPen)} / ${fmtRp(timTgt)}`
          );
          for (const t of (tim.targets || [])) {
            memberCtxLines.push(
              `    • "${t.nama_target}" ${fmtRp(parseFloat(t.pencapaian_revenue || 0))} / ${fmtRp(parseFloat(t.target_revenue || 0))}` +
              ` | ${t.pct_revenue ? parseFloat(t.pct_revenue).toFixed(1) + '%' : '—'}`
            );
          }
        }

        const orphan = allTim.filter(t => !t.leader_id);
        for (const t of orphan) memberCtxLines.push(`  TIM (tanpa leader) ${t.nama}`);
      }
    }

    /* ─ 3. Profil anggota spesifik (hanya jika ada member_id) ─ */
    let profileCtx = '';
    if (member_id) {
      const { rows: [m] }     = await pool.query('SELECT * FROM members WHERE id = $1', [member_id]);
      const { rows: targets } = await pool.query('SELECT * FROM member_targets WHERE member_id = $1 ORDER BY urutan', [member_id]);
      if (m) {
        const tLines = await Promise.all(targets.map(async t => {
          const { rows: riwayat } = await pool.query(
            'SELECT * FROM member_pencapaian WHERE target_id = $1 ORDER BY tanggal DESC LIMIT 7', [t.id]
          );
          const last   = riwayat[0];
          const avgPct = riwayat.length
            ? riwayat.reduce((s, r) => s + parseFloat(r.pct_revenue || 0), 0) / riwayat.length : 0;
          const trend  = riwayat.length >= 2
            ? (parseFloat(riwayat[0].pct_revenue) > parseFloat(riwayat[1].pct_revenue) ? '↑ naik' : '↓ turun') : '—';
          return `  • "${t.nama_target}"${t.key_result ? ' [KR: ' + t.key_result + ']' : ''}` +
                 ` | Target ${fmtRp(t.target_revenue)}` +
                 ` | Terakhir: ${last ? fmtRp(last.pencapaian_revenue) + ' (' + parseFloat(last.pct_revenue).toFixed(1) + '%)' : 'belum ada'}` +
                 ` | Avg 7hr: ${avgPct.toFixed(1)}% | Tren: ${trend}`;
        }));
        profileCtx = `\n=== PROFIL ANGGOTA: ${m.nama.toUpperCase()} ===\n` +
          `Posisi: ${m.posisi} | Fungsi: ${m.fungsi || '—'} | Unit: ${m.unit}\n` +
          (tLines.join('\n') || '— belum ada target —');
      }
    }

    /* ─ 4. System prompt final ─ */
    const today = new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });

    const systemPrompt =
`Kamu adalah BRIC AI — analis bisnis senior internal BMS Retail. Tajam, jujur, berbasis data.
Hari ini: ${today} | Halaman aktif user: ${PAGE_LABEL[page] || page}

GAYA JAWABAN:
- Singkat dan padat. Jawab langsung ke inti, tanpa basa-basi pembuka/penutup.
- Maksimal 5 poin per jawaban. Jika bisa 3, lebih baik.
- Gunakan bullet points (–) bukan paragraf panjang.
- Setiap poin WAJIB ada angka nyata dari data (%, Rp, hari). Dilarang kalimat tanpa angka.
- Dilarang generik: "perlu ditingkatkan" = tidak boleh. Tulis angka dan tindakan konkretnya.
- Jika user minta analisa mendalam, baru boleh lebih panjang — tapi tetap padat.
- Kamu punya akses ke SELURUH data dashboard: bisa jawab pertanyaan tentang unit manapun dari halaman manapun.
- Rahasia perusahaan: data ini internal BMS Retail, dilarang dibagikan ke luar.

${scoreboardCtx}
${memberCtxLines.join('\n')}
${profileCtx}`;

    res.json({ systemPrompt, page, bulan });
  } catch (err) {
    console.error('AI context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/ai-context/history ── */
router.post('/history', async (req, res) => {
  const { role, message, page } = req.body;
  const username = req.user?.username || 'unknown';
  const user_id  = req.user?.id || null;
  try {
    await pool.query(
      'INSERT INTO chat_history (user_id, username, page, role, message) VALUES ($1,$2,$3,$4,$5)',
      [user_id, username, page, role, message]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/ai-context/history ── */
router.get('/history', async (req, res) => {
  const { page, limit = 30 } = req.query;
  const username = req.user?.username;
  try {
    const result = await pool.query(
      `SELECT role, message, page, created_at FROM chat_history
       WHERE username = $1 ${page ? 'AND page = $2' : ''}
       ORDER BY created_at DESC LIMIT $${page ? 3 : 2}`,
      page ? [username, page, parseInt(limit)] : [username, parseInt(limit)]
    );
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/ai-context/history ── */
router.delete('/history', async (req, res) => {
  const { page } = req.query;
  const username = req.user?.username;
  try {
    await pool.query(
      'DELETE FROM chat_history WHERE username = $1' + (page ? ' AND page = $2' : ''),
      page ? [username, page] : [username]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
