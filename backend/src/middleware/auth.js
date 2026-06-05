const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'bric-jwt-secret-2026';

module.exports = function requireAuth(req, res, next) {
  // Allow sync endpoint without auth (called by Apps Script)
  if (req.path === '/sync' && req.method === 'POST') return next();

  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token tidak ditemukan. Silakan login.' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token tidak valid atau sudah expired.' });
  }
};
