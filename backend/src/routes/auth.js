const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const pool    = require('../db');

const JWT_SECRET  = process.env.JWT_SECRET  || 'bric-jwt-secret-2026';
const JWT_EXPIRES = '8h';

// Seed admin dari env jika tabel kosong
async function seedAdminIfEmpty() {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(count.rows[0].count) === 0) {
      const adminPass  = process.env.ADMIN_PASSWORD  || 'BricAdmin2026';
      const viewerPass = process.env.VIEWER_PASSWORD || 'BricView2026';
      const adminHash  = await bcrypt.hash(adminPass,  10);
      const viewerHash = await bcrypt.hash(viewerPass, 10);

      await pool.query(`
        INSERT INTO users (username, password_hash, full_name, unit, role) VALUES
        ('admin',  $1, 'Administrator', 'Semua Unit', 'admin'),
        ('viewer', $2, 'Viewer',        'Semua Unit', 'viewer')
      `, [adminHash, viewerHash]);

      console.log('Seeded default users: admin, viewer');
    }
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

seedAdminIfEmpty();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, password_hash, full_name, unit, role, is_active
       FROM users WHERE username = $1`,
      [username.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }
    if (!user.is_active) {
      return res.status(401).json({ error: 'Akun Anda tidak aktif. Hubungi administrator.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    // Update last_login
    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, unit: user.unit },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      token,
      username: user.username,
      full_name: user.full_name,
      unit: user.unit,
      role: user.role
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

module.exports = router;
