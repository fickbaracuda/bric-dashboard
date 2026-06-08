const express = require('express');
const router  = express.Router();

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const SYSTEM_PROMPT = `Kamu adalah asisten AI untuk BRIC Dashboard — platform analitik bisnis internal BMS Retail (bmsretail.my.id).

Dashboard ini memiliki fitur:
- Unit Scoreboard: ranking seluruh unit bisnis berdasarkan KPI dan revenue bulanan
- Leader Scoreboard: ranking leader lintas unit dengan analisa pencapaian
- Winme & InstaQris: analytics unit Winme dan InstaQris (warna ungu #7F77DD)
- Payment Agent: analytics unit Payment Agent (warna hijau #639922)
- Dompet Digital / SpeedCash: analytics unit Dompet Digital SpeedCash
- Scoreboard Tim: tracking pencapaian harian leader dan anggota tim per unit
- Profil Anggota: detail target, pencapaian, dan riwayat bar chart per anggota

Status performa: Unggul (≥100%), On Track (≥80%), Waspada (≥70%), Perlu Perhatian (<70%).

Tugas kamu: bantu tim internal memahami data performa, memberikan analisa bisnis, saran peningkatan, dan menjawab pertanyaan seputar dashboard.
Gunakan bahasa Indonesia yang profesional namun ramah dan mudah dipahami.
Jika ditanya data spesifik yang kamu tidak punya, arahkan user untuk melihat halaman yang sesuai di dashboard.`;

/* Rate limit internal: max 20 pesan/menit per user */
const userTimestamps = new Map();
function checkRateLimit(username) {
  const now = Date.now();
  const key = username;
  const times = (userTimestamps.get(key) || []).filter(t => now - t < 60_000);
  if (times.length >= 20) return false;
  times.push(now);
  userTimestamps.set(key, times);
  return true;
}

/* POST /api/ai/chat
   body: { message: string, history: [{role, text}] } */
router.post('/chat', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI belum dikonfigurasi. Hubungi admin.' });

  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Pesan terlalu panjang (maks 2000 karakter).' });

  const username = req.user?.username || 'unknown';
  if (!checkRateLimit(username))
    return res.status(429).json({ error: 'Terlalu banyak pesan. Tunggu sebentar.' });

  /* Bangun conversation history untuk Gemini */
  const contents = [
    /* History sebelumnya */
    ...history.slice(-10).map(h => ({
      role:  h.role === 'ai' ? 'model' : 'user',
      parts: [{ text: h.text }],
    })),
    /* Pesan baru */
    { role: 'user', parts: [{ text: message.trim() }] },
  ];

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('Gemini error:', err);
      return res.status(502).json({ error: 'Gemini API error: ' + (err?.error?.message || resp.statusText) });
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
