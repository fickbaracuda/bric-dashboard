/**
 * Permintaan Tambahan Saldo — Tim Operation (halaman Rekonsiliasi
 * OCBC/Mandiri/BRI, dan bank lain di masa depan) memberi tahu Finance
 * (user BRIC dengan unit = 'FA') bahwa diperlukan tambahan saldo.
 *
 * Sengaja sederhana: hanya bank_code + requester_name (diisi manual, BUKAN
 * diambil dari akun BRIC yang login). Dua status saja: PENDING/ACKNOWLEDGED
 * — tidak ada PROCESSING/COMPLETED di scope awal ini.
 *
 * Semua endpoint di sini pakai JWT (didaftarkan di app.js dengan
 * requireAuth). /pending dan /:id/acknowledge WAJIB tambahan cek
 * req.user.unit === 'FA' di backend (bukan cuma sembunyikan tombol di
 * frontend) — dicek via middleware requireFA di bawah.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');

const VALID_BANK_CODES = ['OCBC', 'MANDIRI', 'BRI'];
const DOUBLE_SUBMIT_WINDOW_SECONDS = 10;
const PENDING_LIMIT = 20;

function requireFA(req, res, next) {
  if (req.user?.unit !== 'FA') {
    return res.status(403).json({ error: 'Hanya user unit FA yang bisa mengakses endpoint ini.' });
  }
  next();
}

// Rate limit wajar utk endpoint create — cegah spam, bukan mekanisme
// keamanan utama (double-submit guard di bawah sudah menangani klik ganda).
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan dalam waktu singkat, coba lagi sebentar lagi.' },
});

/**
 * Validasi requester_name: wajib string, trim, panjang 2-100, TOLAK kalau
 * mengandung karakter `<`/`>` (HTML tag/script injection sederhana — nama
 * orang yang sah tidak pernah butuh karakter ini). Escape saat dirender
 * tetap dilakukan di frontend (React otomatis escape teks JSX) sbg
 * pertahanan berlapis, TIDAK pernah dangerouslySetInnerHTML.
 */
function validateRequesterName(raw) {
  if (typeof raw !== 'string') return { error: 'Nama Requester wajib diisi.' };
  const trimmed = raw.trim();
  if (trimmed.length < 2) return { error: 'Nama Requester minimal 2 karakter.' };
  if (trimmed.length > 100) return { error: 'Nama Requester maksimal 100 karakter.' };
  if (/[<>]/.test(trimmed)) return { error: 'Nama Requester tidak boleh mengandung karakter HTML/script.' };
  return { value: trimmed };
}

function mapRequest(r) {
  return {
    id: r.id,
    bank_code: r.bank_code,
    requester_name: r.requester_name,
    status: r.status,
    requested_at: r.requested_at,
    acknowledged_by_username: r.acknowledged_by_username || null,
    acknowledged_at: r.acknowledged_at || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/finance/balance-requests — buat permintaan baru
// Semua user BRIC yang sudah login (JWT) boleh membuat permintaan.
// ─────────────────────────────────────────────────────────────────────────
router.post('/', createLimiter, async (req, res) => {
  try {
    const bankCode = String(req.body?.bank_code || '').trim().toUpperCase();
    if (!VALID_BANK_CODES.includes(bankCode)) {
      return res.status(400).json({ error: `bank_code wajib salah satu dari: ${VALID_BANK_CODES.join(', ')}` });
    }
    const nameCheck = validateRequesterName(req.body?.requester_name);
    if (nameCheck.error) return res.status(400).json({ error: nameCheck.error });
    const requesterName = nameCheck.value;

    const userId = req.user?.id || null;
    const username = req.user?.username || null;

    // Perlindungan double submit: user yg sama, bank+nama sama, dalam
    // 10 detik terakhir -> jangan buat baris baru, kembalikan yg sudah ada.
    const dupRes = await pool.query(
      `SELECT * FROM finance_balance_requests
       WHERE requested_by_user_id = $1 AND bank_code = $2 AND requester_name = $3
         AND requested_at > NOW() - (INTERVAL '1 second' * $4)
       ORDER BY requested_at DESC LIMIT 1`,
      [userId, bankCode, requesterName, DOUBLE_SUBMIT_WINDOW_SECONDS]
    );
    if (dupRes.rows.length) {
      return res.status(409).json({
        success: false,
        message: 'Permintaan yang sama baru saja dikirim — mohon tunggu beberapa saat.',
        request: mapRequest(dupRes.rows[0]),
      });
    }

    const insertRes = await pool.query(
      `INSERT INTO finance_balance_requests (bank_code, requester_name, requested_by_user_id, requested_by_username)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bankCode, requesterName, userId, username]
    );

    res.json({
      success: true,
      message: 'Permintaan tambahan saldo berhasil dikirim.',
      request: mapRequest(insertRes.rows[0]),
    });
  } catch (e) {
    console.error('finance-balance-requests create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/finance/balance-requests/pending — HANYA unit FA
// ─────────────────────────────────────────────────────────────────────────
router.get('/pending', requireFA, async (req, res) => {
  try {
    const [countRes, rowsRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS c FROM finance_balance_requests WHERE status = 'PENDING'`),
      pool.query(
        `SELECT id, bank_code, requester_name, status, requested_at
         FROM finance_balance_requests WHERE status = 'PENDING'
         ORDER BY requested_at ASC LIMIT $1`,
        [PENDING_LIMIT]
      ),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      count: Number(countRes.rows[0]?.c || 0),
      requests: rowsRes.rows.map(mapRequest),
    });
  } catch (e) {
    console.error('finance-balance-requests pending error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/finance/balance-requests/:id/acknowledge — HANYA unit FA
// UPDATE atomic ber-syarat status='PENDING' — hanya SATU user FA yang bisa
// berhasil kalau ada race condition (2 orang menekan "SAYA TERIMA" bersamaan).
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/acknowledge', requireFA, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });

    const userId = req.user?.id || null;
    const username = req.user?.username || null;

    const updateRes = await pool.query(
      `UPDATE finance_balance_requests
       SET status = 'ACKNOWLEDGED', acknowledged_by_user_id = $2, acknowledged_by_username = $3,
           acknowledged_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING'
       RETURNING *`,
      [id, userId, username]
    );

    if (updateRes.rows.length) {
      return res.json({
        success: true,
        message: 'Permintaan telah diterima.',
        request: mapRequest(updateRes.rows[0]),
      });
    }

    // Tidak ada baris ter-update -> id tidak ada, ATAU sudah diterima user
    // FA lain lebih dulu (race condition) — jangan overwrite acknowledged_by.
    const existing = await pool.query('SELECT * FROM finance_balance_requests WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });
    }
    return res.status(409).json({
      success: false,
      already_acknowledged: true,
      message: `Permintaan ini sudah diterima oleh ${existing.rows[0].acknowledged_by_username || 'user FA lain'}.`,
      request: mapRequest(existing.rows[0]),
    });
  } catch (e) {
    console.error('finance-balance-requests acknowledge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
// exported utk unit test (backend/scripts/test-finance-balance-requests.js)
module.exports.validateRequesterName = validateRequesterName;
module.exports.VALID_BANK_CODES = VALID_BANK_CODES;
