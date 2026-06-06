const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

const authRoutes       = require('./routes/auth');
const scoreboardRoutes = require('./routes/scoreboard');
const usersRoutes      = require('./routes/users');
const winmeRoutes         = require('./routes/winme');
const paymentAgentRoutes  = require('./routes/paymentagent');
const dompetDigitalRoutes = require('./routes/dompetdigital');
const requireAuth         = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Nginx proxy (required for rate-limit + X-Forwarded-For)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false
}));

// Hide server fingerprint
app.disable('x-powered-by');

// Rate limit: semua API maksimal 100 req/menit per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Terlalu banyak request. Coba lagi sebentar.' },
  standardHeaders: true,
  legacyHeaders: false
}));

// Rate limit ketat untuk login: max 10 percobaan per 15 menit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth',       authRoutes);
app.use('/api/scoreboard', requireAuth, scoreboardRoutes);
app.use('/api/users',      requireAuth, usersRoutes);
app.use('/api/winme',          requireAuth, winmeRoutes);
app.use('/api/paymentagent',   requireAuth, paymentAgentRoutes);
app.use('/api/dompetdigital',  requireAuth, dompetDigitalRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404 untuk semua route tidak dikenal
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BRIC Backend running on port ${PORT} (localhost only)`);
});

module.exports = app;
