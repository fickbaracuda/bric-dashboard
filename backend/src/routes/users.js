const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../db');

const UNITS = [
  'Payment Agent', 'SpeedCash', 'Travel B2C', 'Pulsagram',
  'Winme', 'InstaQris', 'DOMPET DIGITAL SPEEDCASH',
  'WINME&INSTAQRIS', 'Semua Unit', 'FA', 'OP'
];

// Middleware: hanya admin yang bisa akses user management
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang bisa mengakses fitur ini.' });
  }
  next();
}

// GET /api/users — daftar semua user
router.get('/', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, unit, role, is_active, created_at, last_login
       FROM users ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — tambah user baru
router.post('/', adminOnly, async (req, res) => {
  const { username, password, full_name, unit, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, unit, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, full_name, unit, role, is_active, created_at`,
      [username.trim().toLowerCase(), hash, full_name || null, unit || null, role || 'viewer']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username sudah digunakan.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — update user
router.put('/:id', adminOnly, async (req, res) => {
  const { full_name, unit, role, is_active, password } = req.body;
  const { id } = req.params;

  try {
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password minimal 6 karakter.' });
      }
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE users SET password_hash=$1, full_name=$2, unit=$3, role=$4, is_active=$5 WHERE id=$6`,
        [hash, full_name, unit, role, is_active, id]
      );
    } else {
      await pool.query(
        `UPDATE users SET full_name=$1, unit=$2, role=$3, is_active=$4 WHERE id=$5`,
        [full_name, unit, role, is_active, id]
      );
    }

    const result = await pool.query(
      `SELECT id, username, full_name, unit, role, is_active, created_at FROM users WHERE id=$1`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — hapus user
router.delete('/:id', adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    // Prevent deleting own account
    if (String(req.user?.id) === String(id)) {
      return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri.' });
    }
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/units — daftar unit untuk dropdown
router.get('/units', (req, res) => {
  res.json(UNITS);
});

module.exports = router;
module.exports.UNITS = UNITS;
