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

/** Sisa Saldo: wajib diisi, angka, tidak boleh negatif (nol tetap sah — mis. saldo sudah benar-benar habis). */
function validateRemainingBalance(raw) {
  if (raw === undefined || raw === null || raw === '') return { error: 'Sisa Saldo wajib diisi.' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: 'Sisa Saldo harus berupa angka.' };
  if (n < 0) return { error: 'Sisa Saldo tidak boleh negatif.' };
  return { value: n };
}

function mapRequest(r) {
  return {
    id: r.id,
    bank_code: r.bank_code,
    requester_name: r.requester_name,
    remaining_balance: r.remaining_balance !== null && r.remaining_balance !== undefined ? Number(r.remaining_balance) : null,
    status: r.status,
    requested_at: r.requested_at,
    acknowledged_by_username: r.acknowledged_by_username || null,
    acknowledged_at: r.acknowledged_at || null,
    transferred_by_username: r.transferred_by_username || null,
    transferred_at: r.transferred_at || null,
  };
}

/** Versi lengkap utk riwayat/audit — ikut menyertakan requested_by_username (spec: "tercatat detail mulai dari waktu dan requesternya"). */
function mapHistoryRow(r) {
  return {
    ...mapRequest(r),
    requested_by_username: r.requested_by_username || null,
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

    const balanceCheck = validateRemainingBalance(req.body?.remaining_balance);
    if (balanceCheck.error) return res.status(400).json({ error: balanceCheck.error });
    const remainingBalance = balanceCheck.value;

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
      `INSERT INTO finance_balance_requests (bank_code, requester_name, remaining_balance, requested_by_user_id, requested_by_username)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [bankCode, requesterName, remainingBalance, userId, username]
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
        `SELECT id, bank_code, requester_name, remaining_balance, status, requested_at
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
// GET /api/finance/balance-requests/acknowledged?bank_code= — HANYA unit FA
// Permintaan yang sudah diterima (ACKNOWLEDGED) tapi BELUM ditransfer —
// dipakai FaTransferPanel.jsx di halaman Rekonsiliasi utk menampilkan
// tombol "Dana Sudah Ditransfer" per permintaan. Difilter per bank_code
// karena panel ini muncul di halaman Rekonsiliasi per-bank (bukan global).
// ─────────────────────────────────────────────────────────────────────────
router.get('/acknowledged', requireFA, async (req, res) => {
  try {
    const bankCode = req.query.bank_code ? String(req.query.bank_code).trim().toUpperCase() : null;
    if (!bankCode || !VALID_BANK_CODES.includes(bankCode)) {
      return res.status(400).json({ error: `bank_code wajib salah satu dari: ${VALID_BANK_CODES.join(', ')}` });
    }
    const r = await pool.query(
      `SELECT id, bank_code, requester_name, remaining_balance, status, requested_at,
              acknowledged_by_username, acknowledged_at
       FROM finance_balance_requests
       WHERE status = 'ACKNOWLEDGED' AND bank_code = $1
       ORDER BY acknowledged_at ASC LIMIT $2`,
      [bankCode, PENDING_LIMIT]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: r.rows.length, requests: r.rows.map(mapRequest) });
  } catch (e) {
    console.error('finance-balance-requests acknowledged error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/finance/balance-requests/history?bank_code=&limit=
// Riwayat audit — SEMUA user login boleh lihat (read-only, tidak sensitif;
// tujuannya justru transparansi: "setiap permintaan tercatat detail mulai
// dari waktu dan requesternya"). Menyertakan PENDING & ACKNOWLEDGED, urut
// requested_at terbaru dulu. Didaftarkan SEBELUM GET /:id supaya "history"
// tidak ke-capture sbg parameter :id.
// ─────────────────────────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const bankCode = req.query.bank_code ? String(req.query.bank_code).trim().toUpperCase() : null;
    if (bankCode && !VALID_BANK_CODES.includes(bankCode)) {
      return res.status(400).json({ error: `bank_code wajib salah satu dari: ${VALID_BANK_CODES.join(', ')}` });
    }
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const params = [];
    let whereClause = '';
    if (bankCode) {
      params.push(bankCode);
      whereClause = `WHERE bank_code = $${params.length}`;
    }
    params.push(limit);

    const r = await pool.query(
      `SELECT id, bank_code, requester_name, remaining_balance, status,
              requested_by_username, requested_at, acknowledged_by_username, acknowledged_at,
              transferred_by_username, transferred_at
       FROM finance_balance_requests ${whereClause}
       ORDER BY requested_at DESC LIMIT $${params.length}`,
      params
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: r.rows.length, requests: r.rows.map(mapHistoryRow) });
  } catch (e) {
    console.error('finance-balance-requests history error:', e.message);
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

// ─────────────────────────────────────────────────────────────────────────
// POST /api/finance/balance-requests/:id/mark-transferred — HANYA unit FA
// UPDATE atomic ber-syarat status='ACKNOWLEDGED' — mencegah menandai
// transfer pada permintaan yang belum diterima ATAU yang sudah ditandai
// transfer sebelumnya (double-klik). FA MANAPUN boleh menandai transfer,
// tidak harus FA yang sama yang meng-acknowledge (konsisten dgn sifat
// "SAYA TERIMA" — kerja tim, bukan personal).
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/mark-transferred', requireFA, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });

    const userId = req.user?.id || null;
    const username = req.user?.username || null;

    const updateRes = await pool.query(
      `UPDATE finance_balance_requests
       SET status = 'TRANSFERRED', transferred_by_user_id = $2, transferred_by_username = $3,
           transferred_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'ACKNOWLEDGED'
       RETURNING *`,
      [id, userId, username]
    );

    if (updateRes.rows.length) {
      return res.json({
        success: true,
        message: 'Dana ditandai sudah ditransfer.',
        request: mapRequest(updateRes.rows[0]),
      });
    }

    const existing = await pool.query('SELECT * FROM finance_balance_requests WHERE id = $1', [id]);
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });
    }
    return res.status(409).json({
      success: false,
      message: existing.rows[0].status === 'TRANSFERRED'
        ? `Permintaan ini sudah ditandai transfer oleh ${existing.rows[0].transferred_by_username || 'user FA lain'}.`
        : 'Permintaan ini belum berstatus ACKNOWLEDGED — tidak bisa ditandai transfer.',
      request: mapRequest(existing.rows[0]),
    });
  } catch (e) {
    console.error('finance-balance-requests mark-transferred error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/finance/balance-requests/:id — cek status 1 permintaan.
// Dipakai Tim Operation (pemohon) utk polling status permintaan MEREKA
// SENDIRI (mis. notifikasi "sedang diproses" begitu FA menekan SAYA
// TERIMA) — HANYA boleh dilihat oleh pemohon aslinya (requested_by_user_id
// cocok dgn req.user.id) ATAU unit FA. WAJIB didaftarkan PALING AKHIR di
// antara route GET supaya tidak menangkap /pending atau /history.
// ─────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id tidak valid' });

    const r = await pool.query('SELECT * FROM finance_balance_requests WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Permintaan tidak ditemukan.' });

    const row = r.rows[0];
    const isOwner = req.user?.id != null && String(row.requested_by_user_id) === String(req.user.id);
    const isFA = req.user?.unit === 'FA';
    if (!isOwner && !isFA) {
      return res.status(403).json({ error: 'Anda tidak berhak melihat status permintaan ini.' });
    }

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, request: mapRequest(row) });
  } catch (e) {
    console.error('finance-balance-requests status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
// exported utk unit test (backend/scripts/test-finance-balance-requests.js)
module.exports.validateRequesterName = validateRequesterName;
module.exports.validateRemainingBalance = validateRemainingBalance;
module.exports.VALID_BANK_CODES = VALID_BANK_CODES;
