const express  = require('express');
const router   = express.Router();

/* In-memory presence store — resets on restart (intentional) */
const sessions = new Map(); // username → { username, role, unit, lastSeen }
const TTL      = 2 * 60 * 1000; // 2 menit tanpa ping = dianggap offline

function prune() {
  const cutoff = Date.now() - TTL;
  for (const [k, v] of sessions) {
    if (v.lastSeen < cutoff) sessions.delete(k);
  }
}

/* POST /api/presence/ping
   Dikirim frontend setiap 30 detik.
   Mengembalikan daftar semua user yang sedang aktif. */
router.post('/ping', (req, res) => {
  const { username, role, unit } = req.user;
  sessions.set(username, { username, role, unit, lastSeen: Date.now() });
  prune();
  res.json([...sessions.values()].map(u => ({
    username: u.username,
    role:     u.role,
    unit:     u.unit,
  })));
});

module.exports = router;
