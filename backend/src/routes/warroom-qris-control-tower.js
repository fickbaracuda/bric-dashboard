'use strict';

const pool = require('../db');

/**
 * QRIS Issuance Control Tower — data contract, parser, normalizer, join logic.
 *
 * Sumber: Google Sheet "Penerbitan QRIS" (4 tab, join by ID_Outlet):
 *   1. Data Merchant  — master data (Tanggal, ID_Outlet, Nama_Outlet, MCC, Tanggal_Registrasi, Tanggal_Aktivasi)
 *   2. KYCKYM         — (Tanggal, ID_Outlet, Tanggal_KYC, Tanggal_Submit_Foto_Product dan Foto_toko, Tanggal_Last_Update)
 *   3. VerifikasiOP   — (Tanggal, ID_Outlet, Tanggal_Verifikasi, Status, Reason Reject Data Pten, Reason Reject data KYC)
 *   4. PTEN           — (Tanggal, ID_Outlet, Tanggal Submit PTEN, Status)
 *
 * Express sync/analytics handlers menyusul setelah skema tabel disepakati —
 * file ini baru berisi logic murni (join + derive), tidak menyentuh DB/pool.
 */

/**
 * @typedef {Object} QrisControlTowerRecord
 * @property {string} idOutlet
 * @property {string|null} namaOutlet
 * @property {string|null} mcc
 * @property {string|null} tanggalRegistrasi      ISO 8601 — Data Merchant
 * @property {string|null} tanggalAktivasi        ISO 8601 — Data Merchant
 * @property {string|null} tanggalKYC              ISO 8601 — KYCKYM
 * @property {string|null} tanggalSubmitFoto       ISO 8601 — KYCKYM (foto produk & toko)
 * @property {string|null} tanggalLastUpdateKYC    ISO 8601 — KYCKYM
 * @property {string|null} tanggalVerifikasiOP     ISO 8601 — VerifikasiOP
 * @property {string|null} statusVerifikasiOP      salah satu STATUS.* — VerifikasiOP.Status
 * @property {string|null} reasonRejectDataPTEN    VerifikasiOP
 * @property {string|null} reasonRejectDataKYC     VerifikasiOP
 * @property {string|null} tanggalSubmitPTEN       ISO 8601 — PTEN
 * @property {string|null} statusPTEN              salah satu STATUS.* — PTEN.Status
 * @property {string|null} tanggal                 ISO 8601 — "Tanggal" (log timestamp) terbaru di antara 4 sheet, fallback #8 lastActivityTime
 * @property {string} currentStage                 salah satu STAGE.*
 * @property {'Done'|'PTEN'|'Merchant'|'Internal'|'Verifikator'} stageOwner
 * @property {string|null} lastActivityTime        ISO 8601 — lihat getLastActivityTime (priority waterfall, bukan MAX)
 * @property {number|null} agingMinutes            menit sejak lastActivityTime
 * @property {number|null} agingHours              jam sejak lastActivityTime (1 desimal)
 * @property {'On Track'|'Warning'|'Breach'|null} slaStatus   null jika currentStage QRIS_TERBIT (tidak ada SLA)
 * @property {'P0'|'P1'|'P2'|'P3'} priorityLevel
 * @property {number} priorityScore                dipakai untuk sort queue, makin besar makin urgent
 * @property {string} nextAction
 * @property {string|null} rejectCategory          hasil getRejectCategory() — lihat REJECT_REASON_RULES
 * @property {boolean} isQRISIssued
 * @property {boolean} isInternalBacklog           butuh aksi tim internal (OP/PTEN)
 * @property {boolean} isMerchantBacklog           butuh aksi/data dari merchant
 */

// ── Canonical enums ──────────────────────────────────────────────────────
const STATUS = Object.freeze({
  APPROVE:             'APPROVE',
  REJECTED:            'REJECTED',
  BELUM_LENGKAP:       'Belum Lengkap',
  PERBAIKAN_DATA:      'Perbaikan Data',
  MENUNGGU_VERIFIKASI: 'Menunggu Verifikasi',
  PENDING_PTEN:        'Pending PTEN',
  UNKNOWN:             'UNKNOWN',
});

// Label currentStage — string literal (bukan SNAKE_CASE) karena ini yang
// tampil langsung di dashboard/Action Center sesuai spesifikasi bisnis.
const STAGE = Object.freeze({
  QRIS_TERBIT:            'QRIS Terbit',
  PENDING_PTEN:           'Pending PTEN',
  MENUNGGU_PTEN:          'Menunggu PTEN',
  PERLU_PERBAIKAN:        'Perlu Perbaikan Data',
  SIAP_SUBMIT_PTEN:       'Siap Submit PTEN',
  MENUNGGU_VERIFIKASI_OS: 'Menunggu Verifikasi OS',
  DATA_BELUM_LENGKAP:     'Data Belum Lengkap',
  BARU_DAFTAR:            'Baru Daftar',
  BELUM_ISI_KYC:          'Belum Isi KYC',
  BELUM_SUBMIT_FOTO:      'Belum Submit Foto',
  PERLU_REVIEW:           'Perlu Review',
});

// stageOwner & nextAction 1:1 terhadap currentStage pada rule set ini,
// jadi cukup lookup table — tidak perlu re-evaluasi kondisi.
const STAGE_OWNER_MAP = Object.freeze({
  [STAGE.QRIS_TERBIT]:            'Done',
  [STAGE.PENDING_PTEN]:           'PTEN',
  [STAGE.MENUNGGU_PTEN]:          'PTEN',
  [STAGE.PERLU_PERBAIKAN]:        'Merchant',
  [STAGE.SIAP_SUBMIT_PTEN]:       'Internal',
  [STAGE.MENUNGGU_VERIFIKASI_OS]: 'Verifikator',
  [STAGE.DATA_BELUM_LENGKAP]:     'Merchant',
  [STAGE.BARU_DAFTAR]:            'Merchant',
  [STAGE.BELUM_ISI_KYC]:          'Merchant',
  [STAGE.BELUM_SUBMIT_FOTO]:      'Merchant',
  [STAGE.PERLU_REVIEW]:           'Internal',
});

const STAGE_NEXT_ACTION_MAP = Object.freeze({
  [STAGE.QRIS_TERBIT]:            'Archive / kirim notifikasi QRIS terbit',
  [STAGE.PENDING_PTEN]:           'Eskalasi atau follow-up status PTEN',
  [STAGE.MENUNGGU_PTEN]:          'Cek status verifikasi PTEN',
  [STAGE.PERLU_PERBAIKAN]:        'Follow-up merchant sesuai alasan reject',
  [STAGE.SIAP_SUBMIT_PTEN]:       'Submit data ke PTEN',
  [STAGE.MENUNGGU_VERIFIKASI_OS]: 'Segera proses verifikasi OS',
  [STAGE.DATA_BELUM_LENGKAP]:     'Follow-up merchant untuk melengkapi data',
  [STAGE.BARU_DAFTAR]:            'Dorong aktivasi dan kelengkapan data',
  [STAGE.BELUM_ISI_KYC]:          'Reminder merchant untuk isi KYC/KYM',
  [STAGE.BELUM_SUBMIT_FOTO]:      'Reminder merchant upload foto produk/foto toko',
  [STAGE.PERLU_REVIEW]:           'Cek data secara manual',
});

// SLA Rules (dalam menit) — 1..7 persis dari spesifikasi bisnis; PERLU_REVIEW
// tidak ada di 8 SLA rules asli, saya set 1440 menit (24 jam) sebagai asumsi
// default. QRIS_TERBIT sengaja tidak punya entri — stage terminal, tanpa SLA.
const STAGE_SLA_MINUTES = {
  [STAGE.BARU_DAFTAR]:            30,   // rule 1: Registrasi → Aktivasi
  [STAGE.BELUM_ISI_KYC]:          60,   // rule 2: Aktivasi → Isi KYC
  [STAGE.BELUM_SUBMIT_FOTO]:      60,   // rule 3: KYC → Submit Foto
  [STAGE.MENUNGGU_VERIFIKASI_OS]: 30,   // rule 4: Foto lengkap → Verifikasi OS
  [STAGE.SIAP_SUBMIT_PTEN]:       60,   // rule 5: OS APPROVE → Submit PTEN
  [STAGE.PENDING_PTEN]:           1440, // rule 6: Submit PTEN → Terbit (H+1)
  [STAGE.MENUNGGU_PTEN]:          1440, // rule 6, bucket sama dengan Pending PTEN
  [STAGE.PERLU_PERBAIKAN]:        1440, // rule 7: Rejected/Perbaikan Data → revisi (24 jam)
  [STAGE.DATA_BELUM_LENGKAP]:     1440, // rule 8: Belum Lengkap, >24 jam = red alert
  [STAGE.PERLU_REVIEW]:           1440, // asumsi saya, tidak ada di 8 SLA rules
};

// Keyword MCC high-risk (case-insensitive substring match).
// CATATAN: sample data riil di sheet punya typo "PROFESSIONAL SEVICES" (tanpa
// huruf R) — tidak match keyword "PROFESSIONAL SERVICES" yang benar secara
// ejaan. Saya pakai keyword persis seperti yang diberikan; beri tahu kalau
// perlu ditambah varian typo supaya benar-benar menangkap data riil.
const HIGH_RISK_MCC_KEYWORDS = [
  'FINANCIAL', 'WIRE TRANSFER', 'MARKETPLACES',
  'DIGITAL GOODS', 'PROFESSIONAL SERVICES', 'COMPUTER PROGRAMMING',
];

function isHighRiskMcc(mcc) {
  if (!mcc) return false;
  const s = String(mcc).toUpperCase();
  return HIGH_RISK_MCC_KEYWORDS.some(k => s.includes(k));
}

// ── Date parser — format Indonesia "DD/MM/YYYY[ HH:mm[:ss]]" ─────────────
function parseIndoDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m;
  const d = new Date(+yyyy, +mm - 1, +dd, +hh, +mi, +ss);
  if (Number.isNaN(d.getTime())) return null;
  // Guard tanggal tidak valid (mis. 31/02/2026) — JS Date auto-rollover ke bulan berikutnya
  if (d.getDate() !== +dd || d.getMonth() !== +mm - 1) return null;
  return d;
}

function toIsoOrNull(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function parseIndoDateIso(raw) {
  return toIsoOrNull(parseIndoDate(raw));
}

// ── Status normalizer ─────────────────────────────────────────────────────
const STATUS_ALIASES = new Map([
  ['approve', STATUS.APPROVE], ['approved', STATUS.APPROVE], ['disetujui', STATUS.APPROVE],
  ['sukses', STATUS.APPROVE], ['success', STATUS.APPROVE], ['ok', STATUS.APPROVE],
  ['reject', STATUS.REJECTED], ['rejected', STATUS.REJECTED], ['ditolak', STATUS.REJECTED], ['tolak', STATUS.REJECTED],
  ['belum lengkap', STATUS.BELUM_LENGKAP], ['data belum lengkap', STATUS.BELUM_LENGKAP], ['incomplete', STATUS.BELUM_LENGKAP],
  ['perbaikan data', STATUS.PERBAIKAN_DATA], ['perlu perbaikan', STATUS.PERBAIKAN_DATA], ['revisi', STATUS.PERBAIKAN_DATA],
  ['menunggu verifikasi', STATUS.MENUNGGU_VERIFIKASI], ['pending verifikasi', STATUS.MENUNGGU_VERIFIKASI],
  ['diproses', STATUS.MENUNGGU_VERIFIKASI], ['in review', STATUS.MENUNGGU_VERIFIKASI], ['review', STATUS.MENUNGGU_VERIFIKASI],
  ['pending pten', STATUS.PENDING_PTEN], ['menunggu pten', STATUS.PENDING_PTEN],
  ['diajukan', STATUS.PENDING_PTEN], ['submitted', STATUS.PENDING_PTEN], ['pending', STATUS.PENDING_PTEN],
]);

function normalizeStatus(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hit = STATUS_ALIASES.get(s.toLowerCase());
  if (hit) return hit;
  console.warn(`[qris-control-tower] status tidak dikenali: "${s}" — fallback ke UNKNOWN`);
  return STATUS.UNKNOWN;
}

function nullIfEmpty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ── Row helpers — toleran terhadap variasi spasi/underscore/casing header ─
function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[normalizeKey(k)] = v;
  return out;
}

function pick(normalizedRow, ...candidateNames) {
  for (const name of candidateNames) {
    const v = normalizedRow[normalizeKey(name)];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

// Beberapa outlet bisa punya >1 baris log per sheet (mis. update berkali-kali)
// — ambil yang paling baru per ID_Outlet, mirip pola dedup di warroom-pa-lpd.js.
function dedupeLatestByOutlet(rows, idCandidates, dateCandidates) {
  const map = new Map();
  for (const raw of rows || []) {
    const r = normalizeRowKeys(raw);
    const idOutlet = pick(r, ...idCandidates);
    if (!idOutlet) continue;
    const id  = String(idOutlet).trim();
    const tgl = parseIndoDate(pick(r, ...dateCandidates));
    const prev = map.get(id);
    if (!prev || (tgl && (!prev.__tgl || tgl >= prev.__tgl))) {
      map.set(id, { ...r, __tgl: tgl });
    }
  }
  for (const v of map.values()) delete v.__tgl;
  return map;
}

// ── Per-sheet row mapper ──────────────────────────────────────────────────
function mapMerchantRow(raw) {
  const r = normalizeRowKeys(raw);
  return {
    idOutlet:          String(pick(r, 'ID_Outlet', 'D_Outlet') || '').trim(),
    namaOutlet:        pick(r, 'Nama_Outlet'),
    mcc:               pick(r, 'MCC'),
    tanggalRegistrasi: parseIndoDateIso(pick(r, 'Tanggal_Registrasi')),
    tanggalAktivasi:   parseIndoDateIso(pick(r, 'Tanggal_Aktivasi')),
  };
}

function mapKycRow(raw) {
  const r = normalizeRowKeys(raw);
  return {
    tanggalKYC:           parseIndoDateIso(pick(r, 'Tanggal_KYC')),
    tanggalSubmitFoto:    parseIndoDateIso(pick(r, 'Tanggal_Submit_Foto_Product dan Foto_toko', 'Tanggal_Submit_Foto')),
    tanggalLastUpdateKYC: parseIndoDateIso(pick(r, 'Tanggal_Last_Update')),
  };
}

function mapVerifikasiRow(raw) {
  const r = normalizeRowKeys(raw);
  return {
    tanggalVerifikasiOP:  parseIndoDateIso(pick(r, 'Tanggal_Verifikasi')),
    statusVerifikasiOP:   normalizeStatus(pick(r, 'Status')),
    reasonRejectDataPTEN: nullIfEmpty(pick(r, 'Reason Reject Data Pten')),
    reasonRejectDataKYC:  nullIfEmpty(pick(r, 'Reason Reject data KYC')),
  };
}

function mapPtenRow(raw) {
  const r = normalizeRowKeys(raw);
  return {
    tanggalSubmitPTEN: parseIndoDateIso(pick(r, 'Tanggal Submit PTEN')),
    statusPTEN:        normalizeStatus(pick(r, 'Status')),
  };
}

// ── Stage engine — 4 pure function sesuai Current Stage Rules ────────────
//
// Rule 8/9/10 di spec asli dievaluasi dalam urutan 8→9→10, tapi itu membuat
// rule 10 ("Baru Daftar") jadi dead branch: rule 8 ("tanggalKYC kosong") sudah
// pasti match duluan untuk merchant yang benar-benar baru daftar, karena
// merchant baru juga punya tanggalKYC kosong. Di bawah ini rule 10 dicek
// LEBIH DULU dari 8/9 dengan kondisi lebih spesifik (aktivasi/KYC/foto semua
// kosong) supaya funnel registrasi → aktivasi → KYC → foto konsisten dan
// setiap kondisi data hanya match satu rule.

/**
 * Rule 1–11 — tentukan currentStage dari field-field record yang sudah
 * di-parse/dinormalisasi (parseIndoDateIso / normalizeStatus).
 * @param {{statusPTEN:?string, statusVerifikasiOP:?string, tanggalSubmitPTEN:?string,
 *          tanggalAktivasi:?string, tanggalKYC:?string, tanggalSubmitFoto:?string}} f
 * @returns {string} salah satu STAGE.*
 */
function getCurrentStage(f) {
  const { statusPTEN, statusVerifikasiOP, tanggalSubmitPTEN, tanggalAktivasi, tanggalKYC, tanggalSubmitFoto } = f;

  if (statusPTEN === STATUS.APPROVE) return STAGE.QRIS_TERBIT;                                    // rule 1
  if (statusPTEN === STATUS.PENDING_PTEN) return STAGE.PENDING_PTEN;                              // rule 2
  if (statusPTEN === STATUS.MENUNGGU_VERIFIKASI) return STAGE.MENUNGGU_PTEN;                      // rule 3
  if (statusPTEN === STATUS.REJECTED || statusVerifikasiOP === STATUS.PERBAIKAN_DATA)
    return STAGE.PERLU_PERBAIKAN;                                                                  // rule 4
  if (statusVerifikasiOP === STATUS.APPROVE && !tanggalSubmitPTEN) return STAGE.SIAP_SUBMIT_PTEN;  // rule 5
  if (statusVerifikasiOP === STATUS.MENUNGGU_VERIFIKASI) return STAGE.MENUNGGU_VERIFIKASI_OS;      // rule 6
  if (statusVerifikasiOP === STATUS.BELUM_LENGKAP || statusPTEN === STATUS.BELUM_LENGKAP)
    return STAGE.DATA_BELUM_LENGKAP;                                                               // rule 7
  if (!tanggalAktivasi && !tanggalKYC && !tanggalSubmitFoto) return STAGE.BARU_DAFTAR;             // rule 10 (dicek sebelum 8/9, lihat catatan di atas)
  if (!tanggalKYC) return STAGE.BELUM_ISI_KYC;                                                      // rule 8
  if (!tanggalSubmitFoto) return STAGE.BELUM_SUBMIT_FOTO;                                           // rule 9
  return STAGE.PERLU_REVIEW;                                                                        // rule 11
}

/** @param {string} currentStage @returns {'Done'|'PTEN'|'Merchant'|'Internal'|'Verifikator'} */
function getStageOwner(currentStage) {
  return STAGE_OWNER_MAP[currentStage] || 'Internal';
}

/** @param {string} currentStage @returns {string} */
function getNextAction(currentStage) {
  return STAGE_NEXT_ACTION_MAP[currentStage] || 'Cek data secara manual';
}

// stageOwner menentukan siapa yang bertanggung jawab menindaklanjuti — dipakai
// untuk isQRISIssued/isMerchantBacklog/isInternalBacklog supaya konsisten
// dengan currentStage/stageOwner (bukan di-hardcode ulang per rule).
function getBacklogFlags(stageOwner) {
  return {
    isQRISIssued:      stageOwner === 'Done',
    isMerchantBacklog: stageOwner === 'Merchant',
    isInternalBacklog: stageOwner === 'PTEN' || stageOwner === 'Verifikator' || stageOwner === 'Internal',
  };
}

// ── Reject Category Rules — content-based classification dari teks reason ─
const REJECT_REASON_RULES = [
  { test: s => s.includes('foto usaha tidak mencerminkan'),                     category: 'Foto Tidak Sesuai Usaha' },
  { test: s => s.includes('screenshot') || s.includes('marketplace') || s.includes('online'), category: 'Foto Dari Sumber Online' },
  { test: s => s.includes('nama pemilik tidak sesuai') || s.includes('ktp'),    category: 'Data KTP Tidak Sesuai' },
  { test: s => s.includes('tidak ada foto'),                                    category: 'Foto Tidak Ada' },
];

/**
 * @param {string|null} reasonText - gabungan reasonRejectDataKYC + reasonRejectDataPTEN
 * @returns {string|null}
 */
function getRejectCategory(reasonText) {
  if (!reasonText) return null;
  const s = String(reasonText).trim().toLowerCase();
  if (!s) return null;
  const hit = REJECT_REASON_RULES.find(rule => rule.test(s));
  return hit ? hit.category : null;
}

// ── 1. getLastActivityTime — priority waterfall (BUKAN max semua tanggal) ─
// Field paling hilir (paling dekat ke QRIS terbit) yang terisi menang duluan;
// urutan ini persis field #1..#8 di spesifikasi bisnis.
const LAST_ACTIVITY_PRIORITY = [
  'tanggalSubmitPTEN', 'tanggalVerifikasiOP', 'tanggalLastUpdateKYC', 'tanggalSubmitFoto',
  'tanggalKYC', 'tanggalAktivasi', 'tanggalRegistrasi', 'tanggal',
];

/** @param {Object} fields - record dengan field-field tanggal ISO 8601 (nullable) @returns {string|null} */
function getLastActivityTime(fields) {
  for (const key of LAST_ACTIVITY_PRIORITY) {
    if (fields[key]) return fields[key];
  }
  return null;
}

// ── 2. Aging ───────────────────────────────────────────────────────────
/** @param {string|null} lastActivityTime @param {Date} [now] @returns {number|null} */
function calculateAgingMinutes(lastActivityTime, now = new Date()) {
  if (!lastActivityTime) return null;
  const last = new Date(lastActivityTime);
  if (Number.isNaN(last.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - last.getTime()) / 60000));
}

/** @param {number|null} agingMinutes @returns {number|null} */
function calculateAgingHours(agingMinutes) {
  return agingMinutes == null ? null : Math.round((agingMinutes / 60) * 10) / 10;
}

// ── 3. SLA status ─────────────────────────────────────────────────────
/**
 * @param {string} currentStage
 * @param {number|null} agingMinutes
 * @returns {'On Track'|'Warning'|'Breach'|null} null kalau stage terminal/tanpa SLA atau aging tidak diketahui
 */
function getSLAStatus(currentStage, agingMinutes) {
  const slaMinutes = STAGE_SLA_MINUTES[currentStage];
  if (!slaMinutes || agingMinutes == null) return null;
  const pct = agingMinutes / slaMinutes;
  if (pct > 1) return 'Breach';
  if (pct >= 0.7) return 'Warning';
  return 'On Track';
}

// Heuristik "merchant sudah revisi data dan perlu dicek ulang" (P0 rule 5):
// tidak ada kolom eksplisit "sudah direvisi" di sheet, jadi dideteksi dari
// tanggalLastUpdateKYC yang lebih baru dari tanggalVerifikasiOP (data KYC
// disentuh lagi setelah OP menolak) — flag ini kalau butuh kolom sheet yang
// lebih eksplisit.
function isRevisedAfterReject(rec) {
  if (rec.currentStage !== STAGE.PERLU_PERBAIKAN) return false;
  if (!rec.tanggalLastUpdateKYC || !rec.tanggalVerifikasiOP) return false;
  return new Date(rec.tanggalLastUpdateKYC).getTime() > new Date(rec.tanggalVerifikasiOP).getTime();
}

const PTEN_WAIT_STAGES = new Set([STAGE.PENDING_PTEN, STAGE.MENUNGGU_PTEN]);

// ── 4. Priority level (P0..P3) ────────────────────────────────────────
// Dievaluasi sebagai cascade P0 → P1 → P2 → P3, rule pertama yang match
// menang (sama seperti getCurrentStage). Beberapa kondisi P1/P2 di spec asli
// tumpang tindih pada stage yang sama (mis. "Sudah aktivasi tapi belum KYC"
// di P1 vs "KYC belum isi tapi masih baru" di P2 — sama-sama BELUM_ISI_KYC) —
// saya pisahkan pakai slaStatus: belum lewat 70% SLA ("masih baru") = P2,
// selain itu ("tidak baru lagi") = P1. Fallback terakhir: apa pun yang sudah
// Breach tapi belum diklasifikasi rule manapun tetap P1 (bukan P2/P3), supaya
// tidak ada item breach yang "tersembunyi" di prioritas rendah.
function getPriorityLevel(rec) {
  if (rec.currentStage === STAGE.QRIS_TERBIT) return 'P3';

  if (rec.currentStage === STAGE.MENUNGGU_VERIFIKASI_OS) return 'P0';
  if (rec.currentStage === STAGE.SIAP_SUBMIT_PTEN) return 'P0';
  if (PTEN_WAIT_STAGES.has(rec.currentStage) && rec.slaStatus === 'Breach') return 'P0';
  if (isRevisedAfterReject(rec)) return 'P0';

  if (rec.currentStage === STAGE.DATA_BELUM_LENGKAP && (rec.agingHours ?? 0) > 2) return 'P1';
  if (rec.currentStage === STAGE.PERLU_PERBAIKAN) return 'P1'; // termasuk 3 rejectCategory spesifik & reason lain
  if (rec.currentStage === STAGE.BELUM_ISI_KYC && rec.slaStatus !== 'On Track') return 'P1';
  if (rec.currentStage === STAGE.BELUM_SUBMIT_FOTO && rec.slaStatus !== 'On Track') return 'P1';
  if (PTEN_WAIT_STAGES.has(rec.currentStage) && rec.slaStatus === 'Warning') return 'P1';

  if (rec.currentStage === STAGE.BARU_DAFTAR && rec.slaStatus !== 'Breach') return 'P2';
  if (rec.currentStage === STAGE.BELUM_ISI_KYC) return 'P2';
  if (rec.currentStage === STAGE.BELUM_SUBMIT_FOTO) return 'P2';
  if (PTEN_WAIT_STAGES.has(rec.currentStage)) return 'P2';
  if (rec.currentStage === STAGE.DATA_BELUM_LENGKAP) return 'P2';
  if (rec.currentStage === STAGE.PERLU_REVIEW && rec.slaStatus !== 'Breach') return 'P2';

  if (rec.slaStatus === 'Breach') return 'P1';
  return 'P2';
}

// ── 5. Priority score ────────────────────────────────────────────────
// priorityScore = agingScore + stageWeight + readinessWeight + riskWeight + slaBreachWeight
// agingScore tidak diberi rumus eksplisit di spec — saya buat proporsional
// terhadap % SLA terpakai (aging/SLA × 10) supaya item yang levelnya sama
// (mis. sama-sama Breach) tetap bisa diurutkan dari yang paling telat.
function getAgingScore(agingMinutes, slaMinutes) {
  if (!agingMinutes || !slaMinutes) return 0;
  return Math.round((agingMinutes / slaMinutes) * 100) / 10;
}

function getStageScoreWeight(rec) {
  let w = 0;
  if (rec.currentStage === STAGE.MENUNGGU_VERIFIKASI_OS) w += 35;              // menunggu verifikasi internal
  if (PTEN_WAIT_STAGES.has(rec.currentStage)) w += 35;                         // pending PTEN
  if (rec.currentStage === STAGE.DATA_BELUM_LENGKAP && (rec.agingHours ?? 0) > 24) w += 30; // belum lengkap > 24 jam
  if (rec.currentStage === STAGE.QRIS_TERBIT) w -= 100;                        // PTEN APPROVE
  return w;
}

function getReadinessWeight(rec) {
  return (rec.tanggalKYC && rec.tanggalSubmitFoto) ? 40 : 0; // sudah KYC dan foto lengkap
}

function getRiskWeight(rec) {
  let w = 0;
  if (rec.rejectCategory) w += 25;        // rejected dengan reason jelas
  if (isHighRiskMcc(rec.mcc)) w += 15;    // MCC high risk
  return w;
}

function getSlaBreachWeight(rec) {
  return rec.slaStatus === 'Breach' ? 50 : 0; // sudah lewat SLA
}

/** @param {Object} rec - record dengan currentStage, slaStatus, agingMinutes/Hours, tanggalKYC/SubmitFoto, rejectCategory, mcc @returns {number} */
function getPriorityScore(rec) {
  const slaMinutes = STAGE_SLA_MINUTES[rec.currentStage];
  const total =
    getAgingScore(rec.agingMinutes, slaMinutes) +
    getStageScoreWeight(rec) +
    getReadinessWeight(rec) +
    getRiskWeight(rec) +
    getSlaBreachWeight(rec);
  return Math.round(total * 10) / 10;
}

// ── 6. Sort queue by priorityLevel lalu priorityScore ───────────────────
const PRIORITY_LEVEL_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

function compareByPriority(a, b) {
  const diff = PRIORITY_LEVEL_ORDER[a.priorityLevel] - PRIORITY_LEVEL_ORDER[b.priorityLevel];
  return diff !== 0 ? diff : b.priorityScore - a.priorityScore;
}

/** @param {QrisControlTowerRecord[]} records @returns {QrisControlTowerRecord[]} - array baru, terurut P0→P3, dalam tiap level score tertinggi dulu */
function sortByPriority(records) {
  return [...records].sort(compareByPriority);
}

// ── Join entrypoints ────────────────────────────────────────────────────
// "Tanggal" (log timestamp) tiap sheet — fallback #8 di getLastActivityTime,
// diambil terpisah dari mapXxxRow karena bukan bagian dari shape per-sheet.
function getSheetTanggal(raw) {
  return raw ? parseIndoDateIso(pick(normalizeRowKeys(raw), 'Tanggal')) : null;
}

/**
 * @returns {QrisControlTowerRecord}
 */
function buildMergedMerchant(merchantRaw, kycRaw, verifRaw, ptenRaw, now = new Date()) {
  const merchant = mapMerchantRow(merchantRaw);
  const kyc      = kycRaw   ? mapKycRow(kycRaw)         : { tanggalKYC: null, tanggalSubmitFoto: null, tanggalLastUpdateKYC: null };
  const verif    = verifRaw ? mapVerifikasiRow(verifRaw) : { tanggalVerifikasiOP: null, statusVerifikasiOP: null, reasonRejectDataPTEN: null, reasonRejectDataKYC: null };
  const pten     = ptenRaw  ? mapPtenRow(ptenRaw)        : { tanggalSubmitPTEN: null, statusPTEN: null };

  // ISO 8601 sortable secara leksikografis — cukup sort string, tak perlu parse ulang ke Date
  const tanggal = [merchantRaw, kycRaw, verifRaw, ptenRaw]
    .map(getSheetTanggal).filter(Boolean).sort().pop() || null;

  const base = { ...merchant, ...kyc, ...verif, ...pten, tanggal };

  const currentStage  = getCurrentStage(base);
  const stageOwner    = getStageOwner(currentStage);
  const nextAction    = getNextAction(currentStage);
  const rejectCategory = getRejectCategory(
    [base.reasonRejectDataKYC, base.reasonRejectDataPTEN].filter(Boolean).join(' | ') || null
  );
  const backlog = getBacklogFlags(stageOwner);

  const lastActivityTime = getLastActivityTime(base);
  const agingMinutes     = calculateAgingMinutes(lastActivityTime, now);
  const agingHours       = calculateAgingHours(agingMinutes);
  const slaStatus        = getSLAStatus(currentStage, agingMinutes);

  const withAging = {
    ...base, currentStage, stageOwner, nextAction, rejectCategory, ...backlog,
    lastActivityTime, agingMinutes, agingHours, slaStatus,
  };

  const priorityLevel = getPriorityLevel(withAging);
  const priorityScore = getPriorityScore(withAging);

  return { ...withAging, priorityLevel, priorityScore };
}

/**
 * Gabungkan 4 sheet mentah (array of row-object, key = header sheet asli)
 * menjadi array QrisControlTowerRecord, primary key ID_Outlet.
 * @returns {QrisControlTowerRecord[]}
 */
function joinQrisPipeline(merchantRows, kycRows, verifRows, ptenRows, { now = new Date() } = {}) {
  const merchantMap = dedupeLatestByOutlet(merchantRows, ['ID_Outlet', 'D_Outlet'], ['Tanggal']);
  const kycMap       = dedupeLatestByOutlet(kycRows,       ['ID_Outlet'], ['Tanggal_Last_Update', 'Tanggal']);
  const verifMap     = dedupeLatestByOutlet(verifRows,     ['ID_Outlet'], ['Tanggal_Verifikasi', 'Tanggal']);
  const ptenMap      = dedupeLatestByOutlet(ptenRows,      ['ID_Outlet'], ['Tanggal Submit PTEN', 'Tanggal']);

  const result = [];
  for (const [idOutlet, merchantRow] of merchantMap) {
    result.push(buildMergedMerchant(
      merchantRow, kycMap.get(idOutlet), verifMap.get(idOutlet), ptenMap.get(idOutlet), now
    ));
  }
  return result;
}

// ── Express handlers — sync (token auth, dipanggil Apps Script) + analytics ─
// Sheet ini bukan snapshot bulanan (beda dari WAR-ROOM lain) — 4 tab adalah
// live state seluruh outlet yang pernah masuk pipeline, jadi disimpan sebagai
// JSONB per id_outlet (upsert, bukan insert-per-bulan), mirip pola data-raw.js
// tapi dengan primary key id_outlet langsung supaya join di joinQrisPipeline()
// tidak perlu transformasi balik dari kolom DB ke nama header sheet.
const SYNC_TOKEN = 'bric2026bimasaktisecret';
const CHUNK = 500;

const CTRL_TABLES = {
  merchant:      'qris_ctrl_merchant',
  kyckym:        'qris_ctrl_kyckym',
  verifikasi_op: 'qris_ctrl_verifikasi_op',
  pten:          'qris_ctrl_pten',
};

function extractIdOutlet(row) {
  const id = row && (row.ID_Outlet ?? row.id_outlet ?? row.D_Outlet);
  return id != null ? String(id).trim() : null;
}

async function upsertRows(table, entries) {
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    await pool.query(`
      INSERT INTO ${table} (id_outlet, row_data, synced_at)
      SELECT t.id_outlet, t.row_data::jsonb, NOW()
      FROM unnest($1::text[], $2::text[]) AS t(id_outlet, row_data)
      ON CONFLICT (id_outlet) DO UPDATE SET
        row_data  = EXCLUDED.row_data,
        synced_at = EXCLUDED.synced_at
    `, [chunk.map(([id]) => id), chunk.map(([, row]) => JSON.stringify(row))]);
  }
}

function makeSyncHandler(table) {
  return async function (req, res) {
    const token = req.headers['x-sync-token'] || req.body?.token;
    if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows[] wajib ada' });
    if (!rows.length) return res.json({ ok: true, count: 0 });

    // Dedup by ID_Outlet — sheet kadang punya baris duplikat (ON CONFLICT gagal
    // kalau 2 baris id sama masuk 1 chunk unnest yang sama)
    const seen = new Map();
    for (const row of rows) {
      const id = extractIdOutlet(row);
      if (id) seen.set(id, row);
    }
    const entries = [...seen.entries()];
    if (!entries.length) return res.json({ ok: true, count: 0 });

    res.json({ ok: true, count: entries.length, chunks: Math.ceil(entries.length / CHUNK) });

    setImmediate(async () => {
      try {
        await upsertRows(table, entries);
        console.log(`[qris-ctrl ${table} sync] done: ${entries.length} rows`);
      } catch (err) {
        console.error(`[qris-ctrl ${table} sync] error:`, err.message);
      }
    });
  };
}

/** GET /api/warroom/qris-ctrl/analytics — requireAuth */
async function analyticsHandler(req, res) {
  try {
    const [merchantRes, kycRes, verifRes, ptenRes, syncRes] = await Promise.all([
      pool.query(`SELECT row_data FROM ${CTRL_TABLES.merchant}`),
      pool.query(`SELECT row_data FROM ${CTRL_TABLES.kyckym}`),
      pool.query(`SELECT row_data FROM ${CTRL_TABLES.verifikasi_op}`),
      pool.query(`SELECT row_data FROM ${CTRL_TABLES.pten}`),
      pool.query(`
        SELECT MAX(synced_at) AS last_sync FROM (
          SELECT synced_at FROM ${CTRL_TABLES.merchant}
          UNION ALL SELECT synced_at FROM ${CTRL_TABLES.kyckym}
          UNION ALL SELECT synced_at FROM ${CTRL_TABLES.verifikasi_op}
          UNION ALL SELECT synced_at FROM ${CTRL_TABLES.pten}
        ) t
      `),
    ]);

    if (!merchantRes.rows.length) return res.json({ empty: true, records: [], total: 0 });

    const records = joinQrisPipeline(
      merchantRes.rows.map(r => r.row_data),
      kycRes.rows.map(r => r.row_data),
      verifRes.rows.map(r => r.row_data),
      ptenRes.rows.map(r => r.row_data),
    );
    const sorted = sortByPriority(records);

    res.json({
      records:   sorted,
      total:     sorted.length,
      last_sync: syncRes.rows[0]?.last_sync || null,
    });
  } catch (err) {
    console.error('[qris-control-tower analytics]', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  STATUS, STAGE,
  parseIndoDate, toIsoOrNull, parseIndoDateIso,
  normalizeStatus,
  dedupeLatestByOutlet,
  getCurrentStage, getStageOwner, getNextAction, getRejectCategory, getBacklogFlags,
  getLastActivityTime, calculateAgingMinutes, calculateAgingHours,
  getSLAStatus, getPriorityLevel, getPriorityScore,
  sortByPriority, compareByPriority,
  isHighRiskMcc,
  buildMergedMerchant,
  joinQrisPipeline,
  // Express handlers
  syncMerchantHandler:     makeSyncHandler(CTRL_TABLES.merchant),
  syncKycHandler:          makeSyncHandler(CTRL_TABLES.kyckym),
  syncVerifikasiOpHandler: makeSyncHandler(CTRL_TABLES.verifikasi_op),
  syncPtenHandler:         makeSyncHandler(CTRL_TABLES.pten),
  analyticsHandler,
};
