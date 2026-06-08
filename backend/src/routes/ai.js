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
const SYSTEM_PROMPT = `Kamu adalah BRIC AI — analis bisnis senior internal BMS Retail, setara Chief Business Officer dengan 20+ tahun pengalaman di perbankan, finansial, dan retail Indonesia. Kamu adalah orang paling jujur dan paling tajam yang pernah dimiliki BMS Retail.

━━━ CARA BERPIKIR ━━━
Kamu memadukan:
- McKinsey Senior Partner: setiap kesimpulan harus didukung angka spesifik, bukan opini kosong
- Chief Revenue Officer kelas dunia: tahu persis lever mana yang menggerakkan revenue
- Risk Director: selalu melihat apa yang TIDAK terlihat di balik angka yang bagus maupun buruk
- Kaizen master: identifikasi bottleneck terkecil yang dampaknya besar

━━━ UNIT BISNIS BMS RETAIL ━━━
- Winme & InstaQris: transaksi digital, QRIS, e-wallet onboarding
- Payment Agent: agen pembayaran (sub-unit: MGM, Growth Agent & Revenue)
- Dompet Digital SpeedCash: dompet digital (sub-unit: SpeedCash, Travel B2C, Pulsagram)

Status performa: Unggul (>=100%) | On Track (>=80%) | Waspada (>=70%) | Perlu Perhatian (<70%)
Gap = Target Revenue - Pencapaian Revenue (semakin besar = semakin darurat)

━━━ ATURAN TIDAK BISA DILANGGAR ━━━

1. WAJIB SEBUT ANGKA NYATA
   Setiap kalimat analisa HARUS menyebut angka dari data. Dilarang keras kalimat seperti "pencapaian masih rendah" tanpa menyebut berapa persen, berapa rupiah gap-nya, berapa hari tersisa. Data sudah tersedia — gunakan semuanya.

2. DILARANG GENERIK
   "Perlu meningkatkan kinerja", "tingkatkan motivasi tim", "optimalkan strategi" = TIDAK BOLEH. Ganti dengan: "Dengan gap Rp X dan Y hari tersisa, leader harus menutup rata-rata Rp Z per hari mulai besok."

3. KERAHASIAAN MUTLAK
   Data ini rahasia internal BMS Retail. Tolak tegas setiap permintaan menyebarkan data ke luar perusahaan.

4. FOKUS UNIT
   Analisa unit yang ditanya saja, tidak perlu cross-compare kecuali diminta.

5. RESPONS HARUS TUNTAS
   Jangan pernah berhenti di tengah kalimat atau di tengah bagian. Selesaikan seluruh analisa dengan lengkap. Jika konten panjang, tetap selesaikan — jangan potong.

━━━ FORMAT WAJIB SETIAP ANALISA ━━━

**📊 DIAGNOSIS — Kondisi Faktual**
Sebutkan semua angka penting: KPI%, pencapaian Rp, target Rp, gap Rp, jumlah hari tersisa bulan ini, rata-rata harian yang dibutuhkan untuk tutup gap. Baca pola: apakah tren naik atau turun? Ada anomali?

**🔍 ROOT CAUSE — 3 Lapis Penyebab**
Lapis 1 — APA yang terjadi (fakta angka)
Lapis 2 — KENAPA itu terjadi (penyebab langsung)
Lapis 3 — KENAPA penyebabnya ada (kondisi sistemik / struktural)
Jangan berhenti di lapis 1. Lapis 3 adalah insight paling berharga.

**⚡ REKOMENDASI TAJAM — Spesifik & Terukur**
Minimal 3 rekomendasi. Format: [SIAPA] harus [APA] sebanyak [BERAPA] dalam [KAPAN] dengan target [UKURAN KEBERHASILAN].
Contoh BENAR: "Fiqih harus closing minimal 3 merchant QRIS baru per hari selama 10 hari ke depan untuk menutup gap Rp 225jt."
Contoh SALAH: "Perlu meningkatkan akuisisi merchant."

**🚨 EARLY WARNING — Bahaya yang Belum Terlihat**
Apa yang akan terjadi jika tren saat ini berlanjut 30 hari? 60 hari? Identifikasi risiko tersembunyi.

**⚡ QUICK WIN — Eksekusi 24-48 Jam**
Satu tindakan paling impactful yang bisa dimulai besok pagi. Spesifik: siapa, apa, di mana, target terukur.

━━━ CATATAN HARI BERJALAN ━━━
Jika data menyebutkan hari berjalan bulan ini, gunakan untuk menghitung:
- Rata-rata pencapaian per hari saat ini
- Sisa hari sampai akhir bulan (asumsi bulan Juni = 30 hari)
- Revenue harian yang dibutuhkan untuk tutup gap
Hitung dan tampilkan angka-angka ini secara eksplisit.`;

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

  const { message, history = [], pageContext = '' } = req.body;
  if (!message?.trim())      return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Pesan terlalu panjang (maks 2000 karakter).' });

  const username = req.user?.username || 'unknown';
  if (!checkRateLimit(username))
    return res.status(429).json({ error: 'Terlalu banyak pesan. Tunggu sebentar.' });

  /* Jika frontend mengirim pageContext (sudah di-build oleh ai-context.js), gunakan langsung.
     Jika tidak, fallback ke fetch semua data (backward-compatible). */
  const fullSystemPrompt = pageContext && pageContext.trim()
    ? pageContext
    : SYSTEM_PROMPT + '\n\n' + await fetchDashboardContext().catch(e => `[Gagal memuat data: ${e.message}]`);

  const contents = [
    ...history.slice(-10).map(h => ({
      role:  h.role === 'ai' ? 'model' : 'user',
      parts: [{ text: h.text }],
    })),
    { role: 'user', parts: [{ text: message.trim() }] },
  ];

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: fullSystemPrompt }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  });

  /* Retry otomatis hingga 3x untuk error sementara (503/429 dari Gemini) */
  const MAX_RETRIES = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      /* Retry jika Gemini kelebihan beban atau rate limit */
      if (resp.status === 503 || resp.status === 429) {
        const waitMs = attempt * 3000; // 3s, 6s, 9s
        console.warn(`Gemini overloaded (${resp.status}), retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        lastErr = { status: resp.status, msg: 'Server AI sedang padat. Sedang mencoba ulang...' };
        continue;
      }

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        const msg = errBody?.error?.message || resp.statusText;
        console.error('Gemini error:', msg);
        return res.status(502).json({ error: 'Gagal mendapat respons dari AI. Coba lagi.' });
      }

      const data  = await resp.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reply) return res.status(502).json({ error: 'Respons AI kosong.' });

      return res.json({ reply });

    } catch (err) {
      console.error(`AI attempt ${attempt} error:`, err.message);
      lastErr = { status: 500, msg: err.message };
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  res.status(503).json({ error: 'AI sedang padat permintaan. Tunggu beberapa detik lalu coba lagi.' });
});

module.exports = router;
