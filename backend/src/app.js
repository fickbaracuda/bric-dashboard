const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
require('dotenv').config();

const authRoutes       = require('./routes/auth');
const scoreboardRoutes = require('./routes/scoreboard');
const usersRoutes      = require('./routes/users');
const winmeRoutes         = require('./routes/winme');
const paymentAgentRoutes  = require('./routes/paymentagent');
const dompetDigitalRoutes = require('./routes/dompetdigital');
const membersRoutes       = require('./routes/members');
const presenceRoutes      = require('./routes/presence');
const aiRoutes            = require('./routes/ai');
const aiContextRoutes     = require('./routes/ai-context');
const warroomRoutes       = require('./routes/warroom');
const ekspedisiRoutes     = require('./routes/warroom-ekspedisi');
const fastpayRoutes       = require('./routes/warroom-fastpay');
const farmingRoutes       = require('./routes/warroom-farming');
const dmFastpayRoutes     = require('./routes/warroom-dm-fastpay');
const iqTrxRoutes         = require('./routes/warroom-instaqris-trx');
const asdpRoutes          = require('./routes/warroom-asdp');
const bumdesRoutes        = require('./routes/warroom-bumdes');
const lpdRoutes           = require('./routes/warroom-lpd');
const dataRawRoutes       = require('./routes/data-raw');
const systemRoutes        = require('./routes/system');
const requireAuth         = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Nginx proxy (required for rate-limit + X-Forwarded-For)
app.set('trust proxy', 1);

// Gzip compression — reduces JSON response size ~70%
app.use(compression({ level: 6, threshold: 1024 }));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false
}));

// Hide server fingerprint
app.disable('x-powered-by');

// Rate limit: semua API maksimal 1000 req/menit per IP
// Semua user kantor keluar dari satu IP (NAT) + presence ping tiap 30s per user
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
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
app.use(express.json({ limit: '30mb' }));

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth',       authRoutes);
app.use('/api/scoreboard', requireAuth, scoreboardRoutes);
app.use('/api/users',      requireAuth, usersRoutes);
app.use('/api/winme',          requireAuth, winmeRoutes);
app.use('/api/paymentagent',   requireAuth, paymentAgentRoutes);
app.use('/api/dompetdigital',  requireAuth, dompetDigitalRoutes);
app.use('/api/members',        requireAuth, membersRoutes);
app.use('/api/presence',       requireAuth, presenceRoutes);
app.use('/api/ai',             requireAuth, aiRoutes);
app.use('/api/ai-context',     requireAuth, aiContextRoutes);
app.post('/api/warroom/segmen/sync',      warroomRoutes.syncHandler);            // token auth, no JWT
app.post('/api/warroom/speedcash/sync',  warroomRoutes.speedcashSyncHandler);   // token auth, no JWT
app.post('/api/warroom/ekspedisi/sync',    ekspedisiRoutes.syncHandler);          // token auth, no JWT
app.get('/api/warroom/ekspedisi/analytics', requireAuth, ekspedisiRoutes.analyticsHandler);
app.post('/api/warroom/fastpay/sync',      fastpayRoutes.syncHandler);            // token auth, no JWT
app.get('/api/warroom/fastpay/analytics', requireAuth, fastpayRoutes.analyticsHandler);
app.get('/api/warroom/fastpay/outlets',   requireAuth, fastpayRoutes.outletsHandler);
app.post('/api/warroom/farming/sync',     farmingRoutes.syncHandler);             // token auth, no JWT
app.get('/api/warroom/farming/analytics', requireAuth, farmingRoutes.analyticsHandler);
app.get('/api/warroom/farming/outlets',   requireAuth, farmingRoutes.outletsHandler);
app.post('/api/warroom/pa-produk/sync',     warroomRoutes.paProdukSyncHandler); // token auth, no JWT
app.post('/api/warroom/pa-arpu/sync',      warroomRoutes.paArpuSyncHandler);   // token auth, no JWT
app.post('/api/warroom/mgm/sync',          warroomRoutes.mgmSyncHandler);       // token auth, no JWT
app.get('/api/warroom/mgm/analytics',      requireAuth, warroomRoutes.mgmAnalyticsHandler);
app.post('/api/warroom/dm-fastpay/sync',     dmFastpayRoutes.syncHandler);      // token auth, no JWT
app.get('/api/warroom/dm-fastpay/analytics', requireAuth, dmFastpayRoutes.analyticsHandler);
app.post('/api/warroom/instaqris-trx/sync',     iqTrxRoutes.syncHandler);        // token auth, no JWT
app.get('/api/warroom/instaqris-trx/analytics', requireAuth, iqTrxRoutes.analyticsHandler);
app.get('/api/warroom/instaqris-trx/export',     requireAuth, iqTrxRoutes.exportHandler);
app.get('/api/warroom/instaqris-trx/merchants',  requireAuth, iqTrxRoutes.merchantsHandler);
app.post('/api/warroom/asdp/sync',       asdpRoutes.syncHandler);           // token auth, no JWT
app.get('/api/warroom/asdp/analytics',   requireAuth, asdpRoutes.analyticsHandler);
app.get('/api/warroom/asdp/outlets',     requireAuth, asdpRoutes.outletsHandler);
app.post('/api/warroom/bumdes/sync',     bumdesRoutes.syncHandler);          // token auth, no JWT
app.get('/api/warroom/bumdes/analytics', requireAuth, bumdesRoutes.analyticsHandler);
app.get('/api/warroom/bumdes/outlets',   requireAuth, bumdesRoutes.outletsHandler);
app.post('/api/warroom/lpd/sync',        lpdRoutes.syncHandler);             // token auth, no JWT
app.get('/api/warroom/lpd/analytics',    requireAuth, lpdRoutes.analyticsHandler);
app.get('/api/warroom/lpd/outlets',      requireAuth, lpdRoutes.outletsHandler);
app.use('/api/warroom',        requireAuth, warroomRoutes);

app.post('/api/data-raw/outlet/sync', dataRawRoutes.outletSyncHandler); // token auth, no JWT
app.use('/api/data-raw', requireAuth, dataRawRoutes);

app.use('/api/system', requireAuth, systemRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404 untuk semua route tidak dikenal
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BRIC Backend running on port ${PORT} (localhost only)`);
});

module.exports = app;
