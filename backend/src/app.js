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
const ekspedisiProdukRoutes = require('./routes/warroom-ekspedisi-produk');
const fastpayRoutes       = require('./routes/warroom-fastpay');
const farmingRoutes       = require('./routes/warroom-farming');
const dmFastpayRoutes     = require('./routes/warroom-dm-fastpay');
const iqTrxRoutes         = require('./routes/warroom-instaqris-trx');
const asdpRoutes          = require('./routes/warroom-asdp');
const paAsdpRoutes        = require('./routes/warroom-pa-asdp');
const paLpdRoutes         = require('./routes/warroom-pa-lpd');
const bumdesRoutes        = require('./routes/warroom-bumdes');
const lpdRoutes           = require('./routes/warroom-lpd');
const dataRawRoutes       = require('./routes/data-raw');
const hunterRoutes        = require('./routes/warroom-hunter');
const qrisCtrlRoutes      = require('./routes/warroom-qris-control-tower');
const dmCtRoutes          = require('./routes/warroom-dm-control-tower');
const iqCcRoutes          = require('./routes/warroom-instaqris-command-center');
const quickWinQ3Routes    = require('./routes/warroom-quick-win-q3');
const reconciliationRoutes = require('./routes/warroom-reconciliation');
const reconciliationMandiriRoutes = require('./routes/warroom-reconciliation-mandiri');
const reconciliationBriRoutes = require('./routes/warroom-reconciliation-bri');
const reconciliationBriBifastRoutes = require('./routes/warroom-reconciliation-bri-bifast');
const reconciliationBniRoutes = require('./routes/warroom-reconciliation-bni');
const financeBalanceRequestsRoutes = require('./routes/finance-balance-requests');
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
app.use('/api/finance/balance-requests', requireAuth, financeBalanceRequestsRoutes);
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
app.get('/api/warroom/ekspedisi/outlet-status',  requireAuth, ekspedisiRoutes.outletStatusHandler);
app.post('/api/warroom/ekspedisi/outlet-status', requireAuth, ekspedisiRoutes.updateOutletStatusHandler);
app.get('/api/warroom/ekspedisi/notes',  requireAuth, ekspedisiRoutes.notesHandler);
app.post('/api/warroom/ekspedisi/notes', requireAuth, ekspedisiRoutes.addNoteHandler);
app.post('/api/warroom/ekspedisi-produk/sync', ekspedisiProdukRoutes.syncHandler);   // token auth, no JWT
app.get('/api/warroom/ekspedisi-produk/months',    requireAuth, ekspedisiProdukRoutes.monthsHandler);
app.get('/api/warroom/ekspedisi-produk/analytics', requireAuth, ekspedisiProdukRoutes.analyticsHandler);
app.get('/api/warroom/ekspedisi-produk/outlets',   requireAuth, ekspedisiProdukRoutes.outletsHandler);
app.get('/api/warroom/ekspedisi-produk/product-detail', requireAuth, ekspedisiProdukRoutes.productDetailHandler);
app.get('/api/warroom/ekspedisi-produk/outlet-detail',   requireAuth, ekspedisiProdukRoutes.outletDetailHandler);
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
app.post('/api/warroom/pa-asdp/sync',    paAsdpRoutes.syncHandler);          // token auth, no JWT
app.get('/api/warroom/pa-asdp/analytics',requireAuth, paAsdpRoutes.analyticsHandler);
app.get('/api/warroom/pa-asdp/outlets',  requireAuth, paAsdpRoutes.outletsHandler);
app.post('/api/warroom/pa-lpd/sync',     paLpdRoutes.syncHandler);            // token auth, no JWT
app.get('/api/warroom/pa-lpd/analytics', requireAuth, paLpdRoutes.analyticsHandler);
app.get('/api/warroom/pa-lpd/outlets',   requireAuth, paLpdRoutes.outletsHandler);
app.post('/api/warroom/bumdes/sync',     bumdesRoutes.syncHandler);          // token auth, no JWT
app.get('/api/warroom/bumdes/analytics', requireAuth, bumdesRoutes.analyticsHandler);
app.get('/api/warroom/bumdes/outlets',   requireAuth, bumdesRoutes.outletsHandler);
app.post('/api/warroom/lpd/sync',        lpdRoutes.syncHandler);             // token auth, no JWT
app.get('/api/warroom/lpd/analytics',    requireAuth, lpdRoutes.analyticsHandler);
app.get('/api/warroom/lpd/outlets',      requireAuth, lpdRoutes.outletsHandler);
app.post('/api/warroom/hunter/sync',     hunterRoutes.syncHandler);           // token auth, no JWT
app.get('/api/warroom/hunter/analytics', requireAuth, hunterRoutes.analyticsHandler);
app.post('/api/warroom/qris-ctrl/merchant/sync',      qrisCtrlRoutes.syncMerchantHandler);     // token auth, no JWT
app.post('/api/warroom/qris-ctrl/kyckym/sync',        qrisCtrlRoutes.syncKycHandler);          // token auth, no JWT
app.post('/api/warroom/qris-ctrl/verifikasi-op/sync', qrisCtrlRoutes.syncVerifikasiOpHandler); // token auth, no JWT
app.post('/api/warroom/qris-ctrl/pten/sync',          qrisCtrlRoutes.syncPtenHandler);         // token auth, no JWT
app.get('/api/warroom/qris-ctrl/analytics',           requireAuth, qrisCtrlRoutes.analyticsHandler);
app.post('/api/warroom/dm-control-tower/register/sync',  dmCtRoutes.registerSyncHandler);  // token auth, no JWT
app.post('/api/warroom/dm-control-tower/aktivasi/sync',  dmCtRoutes.aktivasiSyncHandler);  // token auth, no JWT
app.post('/api/warroom/dm-control-tower/trx/sync',       dmCtRoutes.trxSyncHandler);       // token auth, no JWT
app.get('/api/warroom/dm-control-tower/months',        requireAuth, dmCtRoutes.monthsHandler);
app.get('/api/warroom/dm-control-tower/analytics',     requireAuth, dmCtRoutes.analyticsHandler);
app.get('/api/warroom/dm-control-tower/data-quality',  requireAuth, dmCtRoutes.dataQualityHandler);
app.get('/api/warroom/dm-control-tower/outlets',       requireAuth, dmCtRoutes.outletsHandler);
app.get('/api/warroom/instaqris-command-center/months',    requireAuth, iqCcRoutes.monthsHandler);
app.get('/api/warroom/instaqris-command-center/analytics', requireAuth, iqCcRoutes.analyticsHandler);
app.post('/api/warroom/quick-win-q3/sync',      quickWinQ3Routes.syncHandler);   // token auth, no JWT
app.get('/api/warroom/quick-win-q3/periods',    requireAuth, quickWinQ3Routes.periodsHandler);
app.get('/api/warroom/quick-win-q3/analytics',  requireAuth, quickWinQ3Routes.analyticsHandler);
app.post('/api/warroom/reconciliation/sync',        reconciliationRoutes.syncHandler); // token auth (APPS_SCRIPT_TOKEN), no JWT
app.get('/api/warroom/reconciliation/sync-request-status', reconciliationRoutes.syncRequestStatusHandler); // token auth, no JWT — dipanggil Apps Script (OCBC & Mandiri)
app.get('/api/warroom/reconciliation/analytics',    requireAuth, reconciliationRoutes.analyticsHandler);
app.get('/api/warroom/reconciliation/daily-report', requireAuth, reconciliationRoutes.dailyReportHandler);
app.get('/api/warroom/reconciliation/ocbc/balance-needs-periodic', requireAuth, reconciliationRoutes.balanceNeedsPeriodicHandler); // tab "Kebutuhan Saldo" — kebutuhan saldo per periode, READ-ONLY
app.get('/api/warroom/reconciliation/transactions', requireAuth, reconciliationRoutes.transactionsHandler);
app.get('/api/warroom/reconciliation/export',       requireAuth, reconciliationRoutes.exportHandler);
app.post('/api/warroom/reconciliation/request-sync', requireAuth, reconciliationRoutes.requestSyncHandler); // tombol "Sync Now" — generik utk OCBC & Mandiri (bank_code di body)
app.post('/api/warroom/reconciliation/:id/resolve', requireAuth, reconciliationRoutes.resolveHandler);
app.get('/api/warroom/reconciliation/:id/logs',     requireAuth, reconciliationRoutes.actionLogsHandler);
app.post('/api/warroom/reconciliation/mandiri/sync',        reconciliationMandiriRoutes.syncHandler); // token auth (APPS_SCRIPT_TOKEN), no JWT
app.get('/api/warroom/reconciliation/mandiri/analytics',    requireAuth, reconciliationMandiriRoutes.analyticsHandler);
app.get('/api/warroom/reconciliation/mandiri/daily-report', requireAuth, reconciliationMandiriRoutes.dailyReportHandler);
app.get('/api/warroom/reconciliation/mandiri/transactions', requireAuth, reconciliationMandiriRoutes.transactionsHandler);
app.get('/api/warroom/reconciliation/mandiri/raw-bank',     requireAuth, reconciliationMandiriRoutes.rawBankHandler);
app.get('/api/warroom/reconciliation/mandiri/raw-fp',       requireAuth, reconciliationMandiriRoutes.rawFpHandler);
app.get('/api/warroom/reconciliation/mandiri/resolution-history', requireAuth, reconciliationMandiriRoutes.resolutionHistoryHandler);
app.get('/api/warroom/reconciliation/mandiri/export',       requireAuth, reconciliationMandiriRoutes.exportHandler);
app.post('/api/warroom/reconciliation/mandiri/:id/resolve', requireAuth, reconciliationMandiriRoutes.resolveHandler);
app.get('/api/warroom/reconciliation/mandiri/:id/logs',     requireAuth, reconciliationMandiriRoutes.actionLogsHandler);
app.post('/api/warroom/reconciliation/bri/sync',        reconciliationBriRoutes.syncHandler); // token auth (APPS_SCRIPT_TOKEN), no JWT
app.get('/api/warroom/reconciliation/bri/analytics',    requireAuth, reconciliationBriRoutes.analyticsHandler);
app.get('/api/warroom/reconciliation/bri/daily-report', requireAuth, reconciliationBriRoutes.dailyReportHandler);
app.get('/api/warroom/reconciliation/bri/transactions', requireAuth, reconciliationBriRoutes.transactionsHandler);
app.get('/api/warroom/reconciliation/bri/raw-bank',     requireAuth, reconciliationBriRoutes.rawBankHandler);
app.get('/api/warroom/reconciliation/bri/raw-fp',       requireAuth, reconciliationBriRoutes.rawFpHandler);
app.get('/api/warroom/reconciliation/bri/resolution-history', requireAuth, reconciliationBriRoutes.resolutionHistoryHandler);
app.get('/api/warroom/reconciliation/bri/export',       requireAuth, reconciliationBriRoutes.exportHandler);
app.post('/api/warroom/reconciliation/bri/:id/resolve', requireAuth, reconciliationBriRoutes.resolveHandler);
app.get('/api/warroom/reconciliation/bri/:id/logs',     requireAuth, reconciliationBriRoutes.actionLogsHandler);
app.post('/api/warroom/reconciliation/bri-bifast/sync',        reconciliationBriBifastRoutes.syncHandler); // token auth (APPS_SCRIPT_TOKEN), no JWT
app.get('/api/warroom/reconciliation/bri-bifast/analytics',    requireAuth, reconciliationBriBifastRoutes.analyticsHandler);
app.get('/api/warroom/reconciliation/bri-bifast/daily-report', requireAuth, reconciliationBriBifastRoutes.dailyReportHandler);
app.get('/api/warroom/reconciliation/bri-bifast/transactions', requireAuth, reconciliationBriBifastRoutes.transactionsHandler);
app.get('/api/warroom/reconciliation/bri-bifast/raw-bank',     requireAuth, reconciliationBriBifastRoutes.rawBankHandler);
app.get('/api/warroom/reconciliation/bri-bifast/raw-fp',       requireAuth, reconciliationBriBifastRoutes.rawFpHandler);
app.get('/api/warroom/reconciliation/bri-bifast/resolution-history', requireAuth, reconciliationBriBifastRoutes.resolutionHistoryHandler);
app.get('/api/warroom/reconciliation/bri-bifast/export',       requireAuth, reconciliationBriBifastRoutes.exportHandler);
app.post('/api/warroom/reconciliation/bri-bifast/:id/resolve', requireAuth, reconciliationBriBifastRoutes.resolveHandler);
app.get('/api/warroom/reconciliation/bri-bifast/:id/logs',     requireAuth, reconciliationBriBifastRoutes.actionLogsHandler);
app.post('/api/warroom/reconciliation/bni/sync',        reconciliationBniRoutes.syncHandler); // token auth (APPS_SCRIPT_TOKEN), no JWT
app.get('/api/warroom/reconciliation/bni/analytics',    requireAuth, reconciliationBniRoutes.analyticsHandler);
app.get('/api/warroom/reconciliation/bni/daily-report', requireAuth, reconciliationBniRoutes.dailyReportHandler);
app.get('/api/warroom/reconciliation/bni/transactions', requireAuth, reconciliationBniRoutes.transactionsHandler);
app.get('/api/warroom/reconciliation/bni/raw-bank',     requireAuth, reconciliationBniRoutes.rawBankHandler);
app.get('/api/warroom/reconciliation/bni/raw-fp',       requireAuth, reconciliationBniRoutes.rawFpHandler);
app.get('/api/warroom/reconciliation/bni/resolution-history', requireAuth, reconciliationBniRoutes.resolutionHistoryHandler);
app.get('/api/warroom/reconciliation/bni/export',       requireAuth, reconciliationBniRoutes.exportHandler);
app.post('/api/warroom/reconciliation/bni/:id/resolve', requireAuth, reconciliationBniRoutes.resolveHandler);
app.get('/api/warroom/reconciliation/bni/:id/logs',     requireAuth, reconciliationBniRoutes.actionLogsHandler);
app.use('/api/warroom',        requireAuth, warroomRoutes);

app.post('/api/data-raw/outlet/sync',    dataRawRoutes.outletSyncHandler);    // token auth, no JWT
app.post('/api/data-raw/affiliate/sync', dataRawRoutes.affiliateSyncHandler); // token auth, no JWT
app.post('/api/data-raw/qris/sync',      dataRawRoutes.qrisSyncHandler);      // token auth, no JWT
app.post('/api/data-raw/trx/sync',       dataRawRoutes.trxSyncHandler);       // token auth, no JWT
app.use('/api/data-raw', requireAuth, dataRawRoutes);

app.use('/api/system', requireAuth, systemRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404 untuk semua route tidak dikenal
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BRIC Backend running on port ${PORT} (localhost only)`);
});

module.exports = app;
