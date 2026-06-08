const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const pool    = require('../db');

const DATA_FILE = path.join(__dirname, '../../data/scoreboard.json');

function fmtRp(n) {
  if (!n && n !== 0) return 'Rp 0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

/* ── GET /api/ai-context ── */
router.get('/', async (req, res) => {
  const { page = 'scoreboard', bulan = 'JUN_2026', member_id } = req.query;

  try {
    const store      = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : {};
    const bulanData  = store[bulan] || {};
    const allRows    = bulanData.all_rows || [];
    const units      = allRows.filter(r => !r.is_subtotal && !r.is_parent);
    const totalRow   = allRows.find(r => r.nama === 'REVENUE BISNIS BMS');
    const daysElapsed = bulanData.days_elapsed || 1;
    const daysLeft    = Math.max(0, 30 - daysElapsed);

    /* ─ Scoreboard global (semua halaman butuh ini) ─ */
    let scoreboardCtx = '';
    if (allRows.length) {
      const sorted       = [...units].sort((a, b) => (b.est_kpi_juni || 0) - (a.est_kpi_juni || 0));
      const kritisUnits  = units.filter(u => u.status === 'Kritis').map(u => u.nama);
      const awasUnits    = units.filter(u => u.status === 'Awas').map(u => u.nama);
      const amanUnits    = units.filter(u => u.status === 'Aman').map(u => u.nama);
      const best         = sorted[0];
      const worst        = sorted[sorted.length - 1];

      scoreboardCtx = `
=== DATA BISNIS BMS — ${bulan.replace('_', ' ')} ===
Periode berjalan: hari ke-${daysElapsed} dari 30 | Sisa: ${daysLeft} hari
Sync terakhir: ${bulanData.synced_at || '—'}

TOTAL BMS:
- Revenue: ${fmtRp(totalRow?.juni || 0)} | Est Akhir: ${fmtRp(totalRow?.est_rev_juni || 0)}
- Est KPI: ${totalRow?.est_kpi_juni || 0}% | Real KPI: ${totalRow?.real_kpi || 0}%
- Status: ${totalRow?.status || '—'}

KONDISI UNIT:
- AMAN (${amanUnits.length}): ${amanUnits.join(', ') || '—'}
- AWAS  (${awasUnits.length}): ${awasUnits.join(', ') || '—'}
- KRITIS(${kritisUnits.length}): ${kritisUnits.join(', ') || '—'}
- Terbaik: ${best?.nama} (${best?.est_kpi_juni}%) | Terendah: ${worst?.nama} (${worst?.est_kpi_juni}%)

RANKING UNIT:
${sorted.map((u, i) =>
  `${i + 1}. ${u.nama}: Rev ${fmtRp(u.juni)}, Target ${fmtRp(u.target_rkap)}, ` +
  `Est KPI ${u.est_kpi_juni}%, Real KPI ${u.real_kpi}%, Status ${u.status}`
).join('\n')}`;
    }

    /* ─ Konteks per halaman ─ */
    let pageCtx = '';

    if (page === 'winme') {
      const w = allRows.find(r => r.nama === 'Winme');
      const q = allRows.find(r => r.nama === 'InstaQris');
      const g = allRows.find(r => r.nama === 'WINME&INSTAQRIS');
      pageCtx = `
=== FOKUS HALAMAN: WINME & INSTAQRIS ===
GRUP: Rev ${fmtRp(g?.juni)}, Target ${fmtRp(g?.target_rkap)}, Est KPI ${g?.est_kpi_juni}%, Status ${g?.status}

WINME   : Rev ${fmtRp(w?.juni)}, Target ${fmtRp(w?.target_rkap)}, Est KPI ${w?.est_kpi_juni}%, Real ${w?.real_kpi}%, Status ${w?.status}
INSTAQRIS: Rev ${fmtRp(q?.juni)}, Target ${fmtRp(q?.target_rkap)}, Est KPI ${q?.est_kpi_juni}%, Real ${q?.real_kpi}%, Status ${q?.status}
Kontribusi Winme: ${w && g ? ((w.juni / g.juni) * 100).toFixed(1) + '%' : '—'}
Kontribusi InstaQris: ${q && g ? ((q.juni / g.juni) * 100).toFixed(1) + '%' : '—'}
Gap Winme ke target: ${fmtRp((w?.target_rkap || 0) - (w?.juni || 0))}
Gap InstaQris ke target: ${fmtRp((q?.target_rkap || 0) - (q?.juni || 0))}`;
    }

    if (page === 'payment-agent') {
      const pa          = allRows.find(r => r.nama === 'PAYMENT AGENT');
      const paceIdeal   = pa ? (pa.target_rkap || 0) / 30 : 0;
      const paceAktual  = pa ? (pa.juni || 0) / daysElapsed : 0;
      const gapTotal    = pa ? (pa.target_rkap || 0) - (pa.juni || 0) : 0;
      const paceNeeded  = daysLeft > 0 ? gapTotal / daysLeft : 0;
      pageCtx = `
=== FOKUS HALAMAN: PAYMENT AGENT ===
Revenue: ${fmtRp(pa?.juni)} | Target RKAP: ${fmtRp(pa?.target_rkap)}
Est Rev: ${fmtRp(pa?.est_rev_juni)} | Gap ke target: ${fmtRp(gapTotal)}
Est KPI: ${pa?.est_kpi_juni}% | Real KPI: ${pa?.real_kpi}% | Status: ${pa?.status}

ANALISA PACE:
- Pace ideal/hari: ${fmtRp(Math.round(paceIdeal))}
- Pace aktual/hari: ${fmtRp(Math.round(paceAktual))}
- Pace yang dibutuhkan sisa ${daysLeft} hari: ${fmtRp(Math.round(paceNeeded))}/hari
- Deviation pace: ${paceAktual >= paceIdeal ? '+' : ''}${fmtRp(Math.round(paceAktual - paceIdeal))}/hari`;
    }

    if (page === 'dompet') {
      const sc  = allRows.find(r => r.nama === 'SpeedCash');
      const tb  = allRows.find(r => r.nama === 'Travel B2C');
      const pg  = allRows.find(r => r.nama === 'Pulsagram');
      const grp = allRows.find(r => r.nama === 'DOMPET DIGITAL SPEEDCASH');
      pageCtx = `
=== FOKUS HALAMAN: DOMPET DIGITAL SPEEDCASH ===
GRUP: Rev ${fmtRp(grp?.juni)}, Target ${fmtRp(grp?.target_rkap)}, Est KPI ${grp?.est_kpi_juni}%, Status ${grp?.status}

SPEEDCASH : Rev ${fmtRp(sc?.juni)}, Target ${fmtRp(sc?.target_rkap)}, Est KPI ${sc?.est_kpi_juni}%, Status ${sc?.status}
TRAVEL B2C: Rev ${fmtRp(tb?.juni)}, Target ${fmtRp(tb?.target_rkap)}, Est KPI ${tb?.est_kpi_juni}%, Status ${tb?.status}
PULSAGRAM : Rev ${fmtRp(pg?.juni)}, Target ${fmtRp(pg?.target_rkap)}, Est KPI ${pg?.est_kpi_juni}%, Status ${pg?.status}

Kontribusi SpeedCash: ${sc && grp ? ((sc.juni / grp.juni) * 100).toFixed(1) + '%' : '—'}
Unit bermasalah: ${[sc, tb, pg].filter(u => u && u.status !== 'Aman').map(u => `${u.nama}(${u.est_kpi_juni}%)`).join(', ') || 'tidak ada'}`;
    }

    if (page === 'leader-scoreboard') {
      /* Ambil data leader dari DB */
      const { rows: leaders } = await pool.query(`
        SELECT m.nama, m.unit, m.fungsi,
          COALESCE(json_agg(
            json_build_object('nama_target', mt.nama_target, 'target_revenue', mt.target_revenue,
              'pct_revenue', mp.pct_revenue, 'pencapaian_revenue', mp.pencapaian_revenue)
            ORDER BY mt.urutan
          ) FILTER (WHERE mt.id IS NOT NULL), '[]') AS targets
        FROM members m
        LEFT JOIN member_targets mt ON mt.member_id = m.id
        LEFT JOIN LATERAL (SELECT * FROM member_pencapaian WHERE target_id = mt.id ORDER BY tanggal DESC LIMIT 1) mp ON true
        WHERE m.posisi = 'leader' AND m.is_active = true
        GROUP BY m.id ORDER BY m.unit, m.nama
      `);

      const leaderLines = leaders.map(l => {
        const withPct = (l.targets || []).filter(t => parseFloat(t.pct_revenue) > 0);
        const avg     = withPct.length ? withPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / withPct.length : null;
        const pencap  = (l.targets || []).reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);
        const target  = (l.targets || []).reduce((s, t) => s + parseFloat(t.target_revenue || 0), 0);
        return `- ${l.nama} (${l.unit}): Avg KPI ${avg !== null ? avg.toFixed(1) + '%' : 'N/A'}, Pencapaian ${fmtRp(pencap)} / ${fmtRp(target)}`;
      });

      pageCtx = `
=== FOKUS HALAMAN: LEADER SCOREBOARD ===
Ranking semua leader lintas unit:
${leaderLines.join('\n') || '— belum ada data leader —'}`;
    }

    /* ─ Konteks profil anggota ─ */
    let memberCtx = '';
    if (page === 'anggota' && member_id) {
      const { rows: [member] } = await pool.query('SELECT * FROM members WHERE id = $1', [member_id]);
      const { rows: targets }  = await pool.query('SELECT * FROM member_targets WHERE member_id = $1 ORDER BY urutan', [member_id]);

      if (member) {
        const targetLines = await Promise.all(targets.map(async t => {
          const { rows: riwayat } = await pool.query(
            'SELECT * FROM member_pencapaian WHERE target_id = $1 ORDER BY tanggal DESC LIMIT 7', [t.id]
          );
          const last   = riwayat[0];
          const avgPct = riwayat.length ? riwayat.reduce((s, r) => s + parseFloat(r.pct_revenue || 0), 0) / riwayat.length : 0;
          const trend  = riwayat.length >= 2
            ? (parseFloat(riwayat[0].pct_revenue) > parseFloat(riwayat[1].pct_revenue) ? '↑ naik' : '↓ turun')
            : '—';
          return `  • "${t.nama_target}" | KR: ${t.key_result || '—'}\n` +
                 `    Target: ${fmtRp(t.target_revenue)} | Pencapaian terakhir: ${last ? fmtRp(last.pencapaian_revenue) + ' (' + parseFloat(last.pct_revenue).toFixed(1) + '%)' : 'belum ada'}\n` +
                 `    Avg 7 hari: ${avgPct.toFixed(1)}% | Tren: ${trend}`;
        }));

        memberCtx = `
=== FOKUS HALAMAN: PROFIL ${member.nama.toUpperCase()} ===
Nama: ${member.nama} | Posisi: ${member.posisi} | Fungsi: ${member.fungsi || '—'} | Unit: ${member.unit}

TARGET & PENCAPAIAN:
${targetLines.join('\n') || '— belum ada target —'}`;
      }
    }

    /* ─ Scoreboard Tim halaman ─ */
    if (page === 'scoreboard-tim' || page === 'scoreboard-tim-pa' || page === 'scoreboard-tim-sc') {
      const unitMap = {
        'scoreboard-tim':    'winme_instaqris',
        'scoreboard-tim-pa': 'payment_agent',
        'scoreboard-tim-sc': 'speedcash',
      };
      const unit = unitMap[page];
      const { rows: members } = await pool.query(`
        SELECT m.id, m.nama, m.posisi, m.fungsi, m.leader_id,
          COALESCE(json_agg(
            json_build_object('nama_target', mt.nama_target, 'target_revenue', mt.target_revenue,
              'pct_revenue', mp.pct_revenue, 'pencapaian_revenue', mp.pencapaian_revenue, 'tanggal', mp.tanggal)
            ORDER BY mt.urutan
          ) FILTER (WHERE mt.id IS NOT NULL), '[]') AS targets
        FROM members m
        LEFT JOIN member_targets mt ON mt.member_id = m.id
        LEFT JOIN LATERAL (SELECT * FROM member_pencapaian WHERE target_id = mt.id ORDER BY tanggal DESC LIMIT 1) mp ON true
        WHERE m.unit = $1 AND m.is_active = true
        GROUP BY m.id ORDER BY m.posisi DESC, m.nama
      `, [unit]);

      const leaders = members.filter(m => m.posisi === 'leader');
      const allTim  = members.filter(m => m.posisi === 'tim');
      const leaderLines = leaders.map(l => {
        const myTim  = allTim.filter(t => String(t.leader_id) === String(l.id));
        const withPct = (l.targets || []).filter(t => parseFloat(t.pct_revenue) > 0);
        const avg    = withPct.length ? withPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / withPct.length : null;
        const pencap = (l.targets || []).reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);
        const tgt    = (l.targets || []).reduce((s, t) => s + parseFloat(t.target_revenue || 0), 0);
        return `  LEADER ${l.nama}: KPI ${avg !== null ? avg.toFixed(1) + '%' : 'N/A'}, Pencapaian ${fmtRp(pencap)}/${fmtRp(tgt)}, Tim: ${myTim.length} orang`;
      });

      pageCtx = `
=== FOKUS HALAMAN: SCOREBOARD TIM (${unit.toUpperCase()}) ===
${leaderLines.join('\n') || '— belum ada data —'}`;
    }

    /* ─ System prompt final ─ */
    const today = new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });

    const systemPrompt = `Kamu adalah BRIC AI — analis bisnis senior internal BMS Retail. Tajam, jujur, berbasis data.

Hari ini: ${today}

GAYA JAWABAN:
- Singkat dan padat. Jawab langsung ke inti, tanpa basa-basi pembuka/penutup.
- Maksimal 5 poin per jawaban. Jika bisa 3, lebih baik.
- Gunakan bullet points (–) bukan paragraf panjang.
- Setiap poin WAJIB ada angka nyata dari data (%, Rp, hari). Dilarang kalimat tanpa angka.
- Dilarang generik: "perlu ditingkatkan", "perlu dioptimalkan" = tidak boleh. Tulis angka dan tindakan konkretnya.
- Jika user minta analisa mendalam, baru boleh lebih panjang — tapi tetap padat.
- Rahasia perusahaan: data ini internal BMS Retail, dilarang dibagikan ke pihak luar.
- Fokus pada yang ditanya saja, tidak perlu cross-compare kecuali diminta.

${scoreboardCtx}
${pageCtx}
${memberCtx}`;

    res.json({ systemPrompt, page, bulan });
  } catch (err) {
    console.error('AI context error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/ai-context/history — simpan pesan ── */
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
