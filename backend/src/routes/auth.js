const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const USERS = [
  { username: 'admin',  password: process.env.ADMIN_PASSWORD  || 'BricAdmin2026', role: 'admin'  },
  { username: 'viewer', password: process.env.VIEWER_PASSWORD || 'BricView2026',  role: 'viewer' }
];

const JWT_SECRET = process.env.JWT_SECRET || 'bric-jwt-secret-2026';
const JWT_EXPIRES = '8h';

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const user = USERS.find(
    u => u.username === username.trim() && u.password === password
  );

  if (!user) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  const token = jwt.sign(
    { username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  res.json({ token, username: user.username, role: user.role });
});

module.exports = router;
