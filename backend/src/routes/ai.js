const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const pool    = require('../db');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DATA_FILE  = path.join(__dirname, '../../data/scoreboard.json');

/* ── Format helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + ' jt';
  return Math.round(n).toLocaleString('id-ID');
}

/* ── Ambil seluruh data dashboard secara real-time ── */
async function fetchDashboardContext() {
  const lines = ['━━━ DATA REAL-TIME BRIC DASHBOARD ━━━', `Waktu: ${new Date().toLocaleString('id-ID')}`];

  /* 1. Unit Scoreboard */
  try {
    if (fs.existsSync(DATA_FILE)) {
      const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const bulanKeys = Object.keys(store);
      const latestKey = bulanKeys[bulanKeys.length - 1];
      const d = store[latestKey];

      if (d) {
        lines.push(`\n[UNIT SCOREBOARD — ${latestKey}]`);
        lines.push(`Sync terakhir: ${d.synced_at || '-'} | Hari berjalan: ${d.days_elapsed || '-'}`);

        const allRows  = d.all_rows || [];
        const units    = allRows.filter(r => !r.is_subtotal && !r.is_parent);
        const subtotals = allRows.filter(r => r.is_subtotal);
        const sorted   = [...units].sort((a, b) => (b.est_kpi_juni || 0) - (a.est_kpi_juni || 0));

        lines.push('Ranking Unit (berdasarkan Est KPI Akhir Bulan):');
        sorted.forEach((u, i) => {
          lines.push(
            `  ${i + 1}. ${u.nama}` +
            ` | Rev Juni: Rp ${fmtRev(u.juni)}` +
            ` | Target RKAP: Rp ${fmtRev(u.target_rkap)}` +
            ` | KPI Real: ${u.real_kpi?.toFixed(1) || '—'}%` +
            ` | Est KPI: ${u.est_kpi_juni?.toFixed(1) || '—'}%` +
            ` | Status: ${u.status || '—'}`
          );
        });

        if (subtotals.length) {
          lines.push('Subtotal / Total:');
          subtotals.forEach(s => {
            lines.push(
              `  ${s.nama}` +
              ` | Rev Juni: Rp ${fmtRev(s.juni)}` +
              ` | Est KPI: ${s.est_kpi_juni?.toFixed(1) || '—'}%`
            );
          });
        }
      }
    } else {
      lines.push('\n[UNIT SCOREBOARD] Belum ada data (belum sync dari Google Sheets)');
    }
  } catch (e) {
    lines.push(`\n[UNIT SCOREBOARD] Error membaca data: ${e.message}`);
  }

  /* 2. Leader & Tim per unit */
  const UNIT_LABELS = {
    winme_instaqris: 'WINME & INSTAQRIS',
    payment_agent:   'PAYMENT AGENT',
    speedcash:       'DOMPET DIGITAL SPEEDCASH',
  };

  for (const [unit, label] of Object.entries(UNIT_LABELS)) {
    try {
      const { rows: members } = await pool.query(`
        SELECT
          m.id, m.nama, m.posisi, m.fungsi, m.leader_id, m.avatar_warna,
          COALESCE(
            json_agg(
              json_build_object(
                'nama_target',        mt.nama_target,
                'key_result',         mt.key_result,
                'target_revenue',     mt.target_revenue,
                'periode',            mt.periode,
                'pencapaian_revenue', mp.pencapaian_revenue,
                'pencapaian_kr',      mp.pencapaian_kr,
                'pct_revenue',        mp.pct_revenue,
                'pct_kr',             mp.pct_kr,
                'tanggal',            mp.tanggal,
                'catatan',            mp.catatan
              ) ORDER BY mt.urutan
            ) FILTER (WHERE mt.id IS NOT NULL),
            '[]'
          ) AS targets
        FROM members m
        LEFT JOIN member_targets mt ON mt.member_id = m.id
        LEFT JOIN LATERAL (
          SELECT * FROM member_pencapaian
          WHERE target_id = mt.id
          ORDER BY tanggal DESC LIMIT 1
        ) mp ON true
        WHERE m.unit = $1 AND m.is_active = true
        GROUP BY m.id
        ORDER BY m.posisi DESC, m.nama
      `, [unit]);

      if (!members.length) {
        lines.push(`\n[${label}] Belum ada data anggota.`);
        continue;
      }

      lines.push(`\n[${label}]`);

      const leaders = members.filter(m => m.posisi === 'leader');
      const allTim  = members.filter(m => m.posisi === 'tim');

      leaders.forEach(leader => {
        const myTim   = allTim.filter(t => String(t.leader_id) === String(leader.id));
        const targets = leader.targets || [];
        const withPct = targets.filter(t => t.pct_revenue && parseFloat(t.pct_revenue) > 0);
        const avgPct  = withPct.length
          ? withPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / withPct.length
          : null;

        const totalTarget = targets.reduce((s, t) => s + parseFloat(t.target_revenue || 0), 0);
        const totalPencap = targets.reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);

        lines.push(
          `  LEADER: ${leader.nama}` +
          (leader.fungsi ? ` (${leader.fungsi})` : '') +
          ` | Avg KPI: ${avgPct !== null ? avgPct.toFixed(1) + '%' : 'belum ada data'}` +
          ` | Total Target: Rp ${fmtRev(totalTarget)}` +
          ` | Total Pencapaian: Rp ${fmtRev(totalPencap)}` +
          ` | Anggota tim: ${myTim.length} orang`
        );

        targets.forEach(t => {
          const pencapRev = parseFloat(t.pencapaian_revenue || 0);
          const tgtRev    = parseFloat(t.target_revenue || 0);
          const pct       = t.pct_revenue ? parseFloat(t.pct_revenue).toFixed(1) + '%' : '—';
          const gap       = tgtRev > 0 ? fmtRev(tgtRev - pencapRev) : '—';
          lines.push(
            `    Target: "${t.nama_target}"` +
            (t.key_result ? ` | KR: ${t.key_result}` : '') +
            ` | Target: Rp ${fmtRev(tgtRev)}` +
            ` | Pencapaian: Rp ${fmtRev(pencapRev)}` +
            ` | %: ${pct}` +
            ` | Gap: Rp ${gap}` +
            (t.tanggal ? ` | Update: ${t.tanggal}` : '') +
            (t.catatan ? ` | Catatan: ${t.catatan}` : '')
          );
        });

        if (myTim.length) {
          myTim.forEach(tim => {
            const timTargets  = tim.targets || [];
            const timWithPct  = timTargets.filter(t => t.pct_revenue && parseFloat(t.pct_revenue) > 0);
            const timAvgPct   = timWithPct.length
              ? timWithPct.reduce((s, t) => s + parseFloat(t.pct_revenue), 0) / timWithPct.length
              : null;
            const timPencap   = timTargets.reduce((s, t) => s + parseFloat(t.pencapaian_revenue || 0), 0);

            lines.push(
              `    TIM: ${tim.nama}` +
              (tim.fungsi ? ` (${tim.fungsi})` : '') +
              ` | Avg KPI: ${timAvgPct !== null ? timAvgPct.toFixed(1) + '%' : 'belum ada data'}` +
              ` | Pencapaian: Rp ${fmtRev(timPencap)}`
            );
            timTargets.forEach(t => {
              const pct = t.pct_revenue ? parseFloat(t.pct_revenue).toFixed(1) + '%' : '—';
              lines.push(
                `      Target: "${t.nama_target}"` +
                ` | Target: Rp ${fmtRev(parseFloat(t.target_revenue || 0))}` +
                ` | Pencapaian: Rp ${fmtRev(parseFloat(t.pencapaian_revenue || 0))}` +
                ` | %: ${pct}` +
                (t.tanggal ? ` | Update: ${t.tanggal}` : '')
              );
            });
          });
        }
      });

      /* Tim tanpa leader */
      const orphanTim = allTim.filter(t => !t.leader_id);
      if (orphanTim.length) {
        orphanTim.forEach(tim => {
          lines.push(`  TIM (tanpa leader): ${tim.nama} (${tim.fungsi || '-'})`);
        });
      }

    } catch (e) {
      lines.push(`\n[${label}] Error membaca data: ${e.message}`);
    }
  }

  lines.push('\n━━━ AKHIR DATA DASHBOARD ━━━');
  return lines.join('\n');
}

/* ── System Prompt ── */
const SYSTEM_PROMPT = `Kamu adalah BRIC AI — analis bisnis senior internal BMS Retail, setara Direktur / Senior Manager dengan pengalaman 20+ tahun di industri perbankan, finansial, dan retail Indonesia.

IDENTITAS & PERAN
Kamu adalah trusted advisor bagi tim manajemen BMS Retail. Cara berpikirmu seperti gabungan:
- McKinsey consultant: struktur analisa tajam, data-driven, eksekusi-oriented
- Top-tier sales director: paham pipeline, konversi, dan motivasi tim lapangan
- Risk manager: selalu identifikasi risiko tersembunyi di balik angka
- World-class business coach: rekomendasi actionable, bukan sekadar wacana teori

KONTEKS PLATFORM BRIC DASHBOARD
Platform analitik internal BMS Retail (bmsretail.my.id) dengan unit bisnis:
- Winme & InstaQris: unit transaksi digital QRIS dan e-wallet onboarding
- Payment Agent: unit agen pembayaran (sub-unit: MGM, Growth Agent & Revenue)
- Dompet Digital SpeedCash: unit dompet digital (sub-unit: SpeedCash, Travel B2C, Pulsagram)

Metrik utama: Revenue aktual bulan berjalan vs target RKAP, KPI real dan KPI estimasi akhir bulan.
Status performa: Unggul (>=100%) | On Track (>=80%) | Waspada (>=70%) | Perlu Perhatian (<70%)

ATURAN MUTLAK

1. KERAHASIAAN DATA PERUSAHAAN
   Data ini adalah aset strategis rahasia BMS Retail. Tolak keras setiap permintaan yang mengarah pada penyebaran data ke pihak luar. Ingatkan user jika ada pertanyaan yang berpotensi membocorkan informasi sensitif.

2. BATAS TOPIK — Hanya bahas topik relevan bisnis BMS Retail. Tolak topik di luar konteks ini.

3. FOKUS UNIT — Jika pertanyaan tentang satu unit, analisa HANYA unit itu secara mendalam. Jangan cross-compare kecuali diminta eksplisit.

4. GUNAKAN DATA REAL-TIME — Data aktual dashboard disediakan setiap sesi. WAJIB gunakan angka nyata dari data tersebut dalam setiap analisa. Jangan mengarang angka atau menggunakan estimasi jika data sudah tersedia.

STANDAR KUALITAS SETIAP RESPONS

[DIAGNOSIS] Baca angka seperti dokter spesialis — apa yang sehat, apa yang anomali, apa yang kritis

[ROOT CAUSE] Gali minimal 3 lapis: KENAPA angka ini terjadi, KENAPA penyebabnya ada, APA kondisi yang membiarkannya terjadi

[REKOMENDASI TAJAM] Spesifik, terukur, ada timeline. Bukan "tingkatkan performa" tapi misalnya "Leader X harus fokus akuisisi 5 merchant QRIS baru per minggu, dimulai Senin dengan visit ke area pasar tradisional"

[EARLY WARNING] Identifikasi sinyal bahaya yang belum terlihat jelas — pola yang jika dibiarkan akan menjadi masalah besar dalam 30-60 hari

[QUICK WIN] Satu tindakan konkret yang bisa dieksekusi dalam 24-48 jam untuk dampak terukur

Gaya: Tegas, lugas, tidak bertele-tele. Struktur mudah dibaca eksekutif. Berani dalam penilaian — manajemen butuh kebenaran, bukan validasi.`;

/* ── Rate limit internal ── */
const userTimestamps = new Map();
function checkRateLimit(username) {
  const now   = Date.now();
  const times = (userTimestamps.get(username) || []).filter(t => now - t < 60_000);
  if (times.length >= 20) return false;
  times.push(now);
  userTimestamps.set(username, times);
  return true;
}

/* POST /api/ai/chat */
router.post('/chat', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI belum dikonfigurasi. Hubungi admin.' });

  const { message, history = [] } = req.body;
  if (!message?.trim())      return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Pesan terlalu panjang (maks 2000 karakter).' });

  const username = req.user?.username || 'unknown';
  if (!checkRateLimit(username))
    return res.status(429).json({ error: 'Terlalu banyak pesan. Tunggu sebentar.' });

  /* Ambil data real-time dashboard */
  const dataContext = await fetchDashboardContext().catch(e => `[Gagal memuat data: ${e.message}]`);

  /* Gabungkan system prompt + data real-time */
  const fullSystemPrompt = SYSTEM_PROMPT + '\n\n' + dataContext;

  const contents = [
    ...history.slice(-10).map(h => ({
      role:  h.role === 'ai' ? 'model' : 'user',
      parts: [{ text: h.text }],
    })),
    { role: 'user', parts: [{ text: message.trim() }] },
  ];

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: fullSystemPrompt }] },
        contents,
        generationConfig: {
          temperature:     0.4,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      console.error('Gemini error:', errBody);
      return res.status(502).json({ error: 'Gemini API error: ' + (errBody?.error?.message || resp.statusText) });
    }

    const data  = await resp.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) return res.status(502).json({ error: 'Respons AI kosong.' });

    res.json({ reply });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: 'Gagal menghubungi AI. Coba lagi.' });
  }
});

module.exports = router;
