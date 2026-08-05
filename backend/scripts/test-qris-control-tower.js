'use strict';

// Test manual pakai Node built-in `assert` — project ini belum punya test
// framework (cek package.json), jadi tidak menambah dependency baru.
// Run: node backend/scripts/test-qris-control-tower.js

const assert = require('assert');
const {
  STATUS, STAGE,
  parseIndoDateIso,
  normalizeStatus,
  dedupeLatestByOutlet,
  getCurrentStage, getStageOwner, getNextAction, getRejectCategory, getBacklogFlags,
  getLastActivityTime, calculateAgingMinutes, calculateAgingHours,
  getSLAStatus, getPriorityLevel, getPriorityScore, sortByPriority, isHighRiskMcc,
  buildMergedMerchant, joinQrisPipeline,
} = require('../src/routes/warroom-qris-control-tower');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── parseIndoDate ──────────────────────────────────────────────────────
test('parseIndoDate: format lengkap dengan jam', () => {
  const iso = parseIndoDateIso('29/06/2026 23:41');
  assert.strictEqual(iso, new Date(2026, 5, 29, 23, 41, 0).toISOString());
});
test('parseIndoDate: kosong/null tidak error', () => {
  assert.strictEqual(parseIndoDateIso(''), null);
  assert.strictEqual(parseIndoDateIso(null), null);
  assert.strictEqual(parseIndoDateIso(undefined), null);
});
test('parseIndoDate: tanggal tidak valid ditolak', () => {
  assert.strictEqual(parseIndoDateIso('31/02/2026'), null);
});

// ── normalizeStatus ────────────────────────────────────────────────────
test('normalizeStatus: alias dikenali', () => {
  assert.strictEqual(normalizeStatus('Approved'), STATUS.APPROVE);
  assert.strictEqual(normalizeStatus('ditolak'), STATUS.REJECTED);
  assert.strictEqual(normalizeStatus('Pending'), STATUS.PENDING_PTEN);
});
test('normalizeStatus: kosong -> null, tak dikenal -> UNKNOWN', () => {
  assert.strictEqual(normalizeStatus(''), null);
  assert.strictEqual(normalizeStatus(null), null);
  assert.strictEqual(normalizeStatus('xyz-random'), STATUS.UNKNOWN);
});

// ── dedupeLatestByOutlet ────────────────────────────────────────────────
test('dedupeLatestByOutlet: ambil baris terbaru per outlet', () => {
  const rows = [
    { ID_Outlet: 'A', Tanggal: '01/06/2026 08:00', Status: 'Menunggu Verifikasi' },
    { ID_Outlet: 'A', Tanggal: '05/06/2026 08:00', Status: 'Approve' },
  ];
  const map = dedupeLatestByOutlet(rows, ['ID_Outlet'], ['Tanggal']);
  assert.strictEqual(map.get('A').status, 'Approve');
});

// ── getCurrentStage — rule 1..11 ────────────────────────────────────────
test('rule 1: statusPTEN APPROVE -> QRIS Terbit', () => {
  assert.strictEqual(getCurrentStage({ statusPTEN: STATUS.APPROVE }), STAGE.QRIS_TERBIT);
});
test('rule 2: statusPTEN Pending PTEN -> Pending PTEN', () => {
  assert.strictEqual(getCurrentStage({ statusPTEN: STATUS.PENDING_PTEN }), STAGE.PENDING_PTEN);
});
test('rule 3: statusPTEN Menunggu Verifikasi -> Menunggu PTEN', () => {
  assert.strictEqual(getCurrentStage({ statusPTEN: STATUS.MENUNGGU_VERIFIKASI }), STAGE.MENUNGGU_PTEN);
});
test('rule 4a: statusPTEN REJECTED -> Perlu Perbaikan Data', () => {
  assert.strictEqual(getCurrentStage({ statusPTEN: STATUS.REJECTED }), STAGE.PERLU_PERBAIKAN);
});
test('rule 4b: statusVerifikasiOP Perbaikan Data -> Perlu Perbaikan Data', () => {
  assert.strictEqual(getCurrentStage({ statusVerifikasiOP: STATUS.PERBAIKAN_DATA }), STAGE.PERLU_PERBAIKAN);
});
test('rule 5: VerifikasiOP APPROVE, PTEN belum submit -> Siap Submit PTEN', () => {
  assert.strictEqual(getCurrentStage({ statusVerifikasiOP: STATUS.APPROVE, tanggalSubmitPTEN: null }), STAGE.SIAP_SUBMIT_PTEN);
});
test('rule 5 tidak trigger kalau PTEN sudah disubmit (fallback ke Perlu Review)', () => {
  const stage = getCurrentStage({
    statusVerifikasiOP: STATUS.APPROVE,
    tanggalSubmitPTEN:  '2026-06-20T00:00:00.000Z',
    tanggalAktivasi:    '2026-06-20T00:00:00.000Z',
    tanggalKYC:         '2026-06-20T00:00:00.000Z',
    tanggalSubmitFoto:  '2026-06-20T00:00:00.000Z',
  });
  assert.strictEqual(stage, STAGE.PERLU_REVIEW);
});
test('rule 6: statusVerifikasiOP Menunggu Verifikasi -> Menunggu Verifikasi OS', () => {
  assert.strictEqual(getCurrentStage({ statusVerifikasiOP: STATUS.MENUNGGU_VERIFIKASI }), STAGE.MENUNGGU_VERIFIKASI_OS);
});
test('rule 7a: statusVerifikasiOP Belum Lengkap -> Data Belum Lengkap', () => {
  assert.strictEqual(getCurrentStage({ statusVerifikasiOP: STATUS.BELUM_LENGKAP }), STAGE.DATA_BELUM_LENGKAP);
});
test('rule 7b: statusPTEN Belum Lengkap -> Data Belum Lengkap', () => {
  assert.strictEqual(getCurrentStage({ statusPTEN: STATUS.BELUM_LENGKAP }), STAGE.DATA_BELUM_LENGKAP);
});
test('rule 10: baru registrasi, semua kosong -> Baru Daftar', () => {
  assert.strictEqual(getCurrentStage({}), STAGE.BARU_DAFTAR);
});
test('rule 8: aktivasi ada, KYC kosong -> Belum Isi KYC', () => {
  assert.strictEqual(getCurrentStage({ tanggalAktivasi: '2026-06-20T00:00:00.000Z' }), STAGE.BELUM_ISI_KYC);
});
test('rule 9: KYC ada, foto kosong -> Belum Submit Foto', () => {
  assert.strictEqual(getCurrentStage({
    tanggalAktivasi: '2026-06-20T00:00:00.000Z',
    tanggalKYC:      '2026-06-20T01:00:00.000Z',
  }), STAGE.BELUM_SUBMIT_FOTO);
});
test('rule 11: KYC+foto ada tapi belum ada status verifikasi -> Perlu Review', () => {
  assert.strictEqual(getCurrentStage({
    tanggalAktivasi:   '2026-06-20T00:00:00.000Z',
    tanggalKYC:        '2026-06-20T01:00:00.000Z',
    tanggalSubmitFoto: '2026-06-20T02:00:00.000Z',
  }), STAGE.PERLU_REVIEW);
});

// ── getStageOwner / getNextAction ────────────────────────────────────────
const OWNER_TABLE = [
  [STAGE.QRIS_TERBIT, 'Done'],
  [STAGE.PENDING_PTEN, 'PTEN'],
  [STAGE.MENUNGGU_PTEN, 'PTEN'],
  [STAGE.PERLU_PERBAIKAN, 'Merchant'],
  [STAGE.SIAP_SUBMIT_PTEN, 'Internal'],
  [STAGE.MENUNGGU_VERIFIKASI_OS, 'Verifikator'],
  [STAGE.DATA_BELUM_LENGKAP, 'Merchant'],
  [STAGE.BARU_DAFTAR, 'Merchant'],
  [STAGE.BELUM_ISI_KYC, 'Merchant'],
  [STAGE.BELUM_SUBMIT_FOTO, 'Merchant'],
  [STAGE.PERLU_REVIEW, 'Internal'],
];
for (const [stage, owner] of OWNER_TABLE) {
  test(`getStageOwner("${stage}") -> "${owner}"`, () => {
    assert.strictEqual(getStageOwner(stage), owner);
  });
}
test('getNextAction rule 1', () => {
  assert.strictEqual(getNextAction(STAGE.QRIS_TERBIT), 'Archive / kirim notifikasi QRIS terbit');
});
test('getNextAction rule 5', () => {
  assert.strictEqual(getNextAction(STAGE.SIAP_SUBMIT_PTEN), 'Submit data ke PTEN');
});

// ── getBacklogFlags ───────────────────────────────────────────────────────
test('getBacklogFlags: Done -> isQRISIssued true, sisanya false', () => {
  assert.deepStrictEqual(getBacklogFlags('Done'), { isQRISIssued: true, isMerchantBacklog: false, isInternalBacklog: false });
});
test('getBacklogFlags: Merchant -> isMerchantBacklog true', () => {
  assert.deepStrictEqual(getBacklogFlags('Merchant'), { isQRISIssued: false, isMerchantBacklog: true, isInternalBacklog: false });
});
test('getBacklogFlags: PTEN/Verifikator/Internal -> isInternalBacklog true', () => {
  for (const owner of ['PTEN', 'Verifikator', 'Internal']) {
    assert.deepStrictEqual(getBacklogFlags(owner), { isQRISIssued: false, isMerchantBacklog: false, isInternalBacklog: true });
  }
});

// ── getRejectCategory ──────────────────────────────────────────────────────
test('rejectCategory: foto usaha tidak mencerminkan', () => {
  assert.strictEqual(getRejectCategory('Foto usaha tidak mencerminkan jenis usaha'), 'Foto Tidak Sesuai Usaha');
});
test('rejectCategory: screenshot/marketplace/online', () => {
  assert.strictEqual(getRejectCategory('Foto diambil dari screenshot'), 'Foto Dari Sumber Online');
  assert.strictEqual(getRejectCategory('Foto produk dari Marketplace'), 'Foto Dari Sumber Online');
  assert.strictEqual(getRejectCategory('Sumber gambar online'), 'Foto Dari Sumber Online');
});
test('rejectCategory: KTP / nama pemilik tidak sesuai', () => {
  assert.strictEqual(getRejectCategory('Nama pemilik tidak sesuai KTP'), 'Data KTP Tidak Sesuai');
  assert.strictEqual(getRejectCategory('Foto KTP buram'), 'Data KTP Tidak Sesuai');
});
test('rejectCategory: tidak ada foto', () => {
  assert.strictEqual(getRejectCategory('Tidak ada foto produk'), 'Foto Tidak Ada');
});
test('rejectCategory: reason kosong -> null', () => {
  assert.strictEqual(getRejectCategory(null), null);
  assert.strictEqual(getRejectCategory(''), null);
  assert.strictEqual(getRejectCategory('   '), null);
});
test('rejectCategory: reason tidak dikenal -> null', () => {
  assert.strictEqual(getRejectCategory('Alasan lain yang tidak masuk kategori'), null);
});

// ── buildMergedMerchant / joinQrisPipeline — end-to-end ─────────────────
test('buildMergedMerchant: full flow sampai QRIS Terbit', () => {
  const now = new Date('2026-06-30T00:00:00Z');
  const rec = buildMergedMerchant(
    { ID_Outlet: '999', Nama_Outlet: 'Toko Uji', MCC: 'VARIETY STORES', Tanggal_Registrasi: '20/06/2026 10:00', Tanggal_Aktivasi: '20/06/2026 10:05' },
    { Tanggal_KYC: '20/06/2026 11:00', 'Tanggal_Submit_Foto_Product dan Foto_toko': '20/06/2026 12:00', Tanggal_Last_Update: '20/06/2026 12:00' },
    { Tanggal_Verifikasi: '20/06/2026 13:00', Status: 'Approved', 'Reason Reject Data Pten': '', 'Reason Reject data KYC': '' },
    { 'Tanggal Submit PTEN': '20/06/2026 14:00', Status: 'Approve' },
    now
  );
  assert.strictEqual(rec.currentStage, STAGE.QRIS_TERBIT);
  assert.strictEqual(rec.stageOwner, 'Done');
  assert.strictEqual(rec.isQRISIssued, true);
  assert.strictEqual(rec.rejectCategory, null);
});

test('buildMergedMerchant: reject di VerifikasiOP karena foto marketplace', () => {
  const now = new Date('2026-06-30T00:00:00Z');
  const rec = buildMergedMerchant(
    { ID_Outlet: '888', Nama_Outlet: 'Toko Reject', MCC: 'VARIETY STORES', Tanggal_Registrasi: '20/06/2026 10:00', Tanggal_Aktivasi: '20/06/2026 10:05' },
    { Tanggal_KYC: '20/06/2026 11:00', 'Tanggal_Submit_Foto_Product dan Foto_toko': '20/06/2026 12:00' },
    { Tanggal_Verifikasi: '20/06/2026 13:00', Status: 'Perbaikan Data', 'Reason Reject data KYC': 'Foto produk diambil dari marketplace' },
    null,
    now
  );
  assert.strictEqual(rec.currentStage, STAGE.PERLU_PERBAIKAN);
  assert.strictEqual(rec.stageOwner, 'Merchant');
  assert.strictEqual(rec.isMerchantBacklog, true);
  assert.strictEqual(rec.rejectCategory, 'Foto Dari Sumber Online');
});

test('joinQrisPipeline: field kosong tetap null, bukan undefined', () => {
  const [rec] = joinQrisPipeline(
    [{ ID_Outlet: '1', Nama_Outlet: 'A', Tanggal_Registrasi: '01/06/2026 00:00' }],
    [], [], [],
    { now: new Date('2026-06-30T00:00:00Z') }
  );
  assert.strictEqual(rec.tanggalKYC, null);
  assert.strictEqual(rec.statusVerifikasiOP, null);
  assert.strictEqual(rec.statusPTEN, null);
  assert.strictEqual(rec.currentStage, STAGE.BARU_DAFTAR);
});

// ── getLastActivityTime — priority waterfall, bukan MAX ──────────────────
test('getLastActivityTime: field prioritas tinggi menang meski bukan tanggal terbaru', () => {
  const result = getLastActivityTime({
    tanggalKYC:        '2026-06-10T00:00:00.000Z',
    tanggalRegistrasi: '2026-06-29T00:00:00.000Z', // lebih baru, tapi prioritas lebih rendah
  });
  assert.strictEqual(result, '2026-06-10T00:00:00.000Z');
});
test('getLastActivityTime: semua kosong -> null', () => {
  assert.strictEqual(getLastActivityTime({}), null);
});
test('getLastActivityTime: fallback ke field #8 "tanggal"', () => {
  assert.strictEqual(getLastActivityTime({ tanggal: '2026-06-01T00:00:00.000Z' }), '2026-06-01T00:00:00.000Z');
});

// ── calculateAgingMinutes / calculateAgingHours ──────────────────────────
test('calculateAgingMinutes: 90 menit lalu -> 90 menit / 1.5 jam', () => {
  const now = new Date('2026-06-30T01:30:00Z');
  assert.strictEqual(calculateAgingMinutes('2026-06-30T00:00:00.000Z', now), 90);
  assert.strictEqual(calculateAgingHours(90), 1.5);
});
test('calculateAgingMinutes: lastActivityTime null -> null', () => {
  assert.strictEqual(calculateAgingMinutes(null, new Date()), null);
  assert.strictEqual(calculateAgingHours(null), null);
});

// ── getSLAStatus — boundary 70%/100% ─────────────────────────────────────
// STAGE.BELUM_ISI_KYC SLA = 60 menit -> 70% = 42 menit
test('getSLAStatus: On Track di bawah 70% SLA', () => {
  assert.strictEqual(getSLAStatus(STAGE.BELUM_ISI_KYC, 41), 'On Track');
});
test('getSLAStatus: Warning tepat di 70% SLA', () => {
  assert.strictEqual(getSLAStatus(STAGE.BELUM_ISI_KYC, 42), 'Warning');
});
test('getSLAStatus: Warning tepat di 100% SLA (belum breach)', () => {
  assert.strictEqual(getSLAStatus(STAGE.BELUM_ISI_KYC, 60), 'Warning');
});
test('getSLAStatus: Breach setelah lewat SLA', () => {
  assert.strictEqual(getSLAStatus(STAGE.BELUM_ISI_KYC, 61), 'Breach');
});
test('getSLAStatus: stage terminal (QRIS Terbit) -> null', () => {
  assert.strictEqual(getSLAStatus(STAGE.QRIS_TERBIT, 999), null);
});

// ── isHighRiskMcc ─────────────────────────────────────────────────────────
test('isHighRiskMcc: keyword match case-insensitive', () => {
  assert.strictEqual(isHighRiskMcc('MARKETPLACES'), true);
  assert.strictEqual(isHighRiskMcc('financial institutions merchandise & services'), true);
  assert.strictEqual(isHighRiskMcc('FAST FOOD RESTAURANTS'), false);
  assert.strictEqual(isHighRiskMcc(null), false);
});

// ── getPriorityLevel — P0..P3 ─────────────────────────────────────────────
test('priorityLevel P0: Menunggu Verifikasi OS selalu P0', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.MENUNGGU_VERIFIKASI_OS, slaStatus: 'On Track' }), 'P0');
});
test('priorityLevel P0: Siap Submit PTEN selalu P0', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.SIAP_SUBMIT_PTEN, slaStatus: 'On Track' }), 'P0');
});
test('priorityLevel P0: Pending PTEN sudah breach SLA', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.PENDING_PTEN, slaStatus: 'Breach' }), 'P0');
});
test('priorityLevel P0: merchant sudah revisi (tanggalLastUpdateKYC > tanggalVerifikasiOP)', () => {
  assert.strictEqual(getPriorityLevel({
    currentStage: STAGE.PERLU_PERBAIKAN,
    tanggalVerifikasiOP:  '2026-06-20T00:00:00.000Z',
    tanggalLastUpdateKYC: '2026-06-21T00:00:00.000Z',
  }), 'P0');
});
test('priorityLevel P1: Perlu Perbaikan Data (belum direvisi)', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.PERLU_PERBAIKAN }), 'P1');
});
test('priorityLevel P1: Belum Lengkap > 2 jam', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.DATA_BELUM_LENGKAP, agingHours: 3, slaStatus: 'On Track' }), 'P1');
});
test('priorityLevel P1: Pending PTEN Warning (mendekati SLA)', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.PENDING_PTEN, slaStatus: 'Warning' }), 'P1');
});
test('priorityLevel P2: Baru Daftar, belum lewat SLA', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.BARU_DAFTAR, slaStatus: 'On Track' }), 'P2');
});
test('priorityLevel P2: Belum Lengkap <= 2 jam', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.DATA_BELUM_LENGKAP, agingHours: 1, slaStatus: 'On Track' }), 'P2');
});
test('priorityLevel P3: QRIS Terbit', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.QRIS_TERBIT }), 'P3');
});
test('priorityLevel fallback: breach yang belum diklasifikasi tetap P1 (bukan turun ke P2)', () => {
  assert.strictEqual(getPriorityLevel({ currentStage: STAGE.BARU_DAFTAR, slaStatus: 'Breach' }), 'P1');
});

// ── getPriorityScore ──────────────────────────────────────────────────────
test('priorityScore: QRIS Terbit -> skor negatif (deprioritized di bawah antrian)', () => {
  const score = getPriorityScore({
    currentStage: STAGE.QRIS_TERBIT,
    tanggalKYC: '2026-06-20T00:00:00.000Z', tanggalSubmitFoto: '2026-06-20T00:00:00.000Z',
    rejectCategory: null, mcc: 'VARIETY STORES', slaStatus: null, agingMinutes: null, agingHours: null,
  });
  assert.strictEqual(score, -60); // stageWeight -100 + readinessWeight 40
});
test('priorityScore: breach + MCC high-risk + data lengkap terakumulasi', () => {
  const score = getPriorityScore({
    currentStage: STAGE.MENUNGGU_VERIFIKASI_OS,
    tanggalKYC: '2026-06-20T00:00:00.000Z', tanggalSubmitFoto: '2026-06-20T00:00:00.000Z',
    rejectCategory: null, mcc: 'MARKETPLACES', slaStatus: 'Breach', agingMinutes: 90, agingHours: 1.5,
  });
  // agingScore 30 (90/30*10) + stageWeight 35 (menunggu verifikasi internal)
  // + readinessWeight 40 (KYC+foto lengkap) + riskWeight 15 (MCC high risk) + slaBreachWeight 50
  assert.strictEqual(score, 170);
});
test('priorityScore: rejectCategory menambah riskWeight +25', () => {
  const base = { currentStage: STAGE.PERLU_PERBAIKAN, tanggalKYC: null, tanggalSubmitFoto: null, mcc: 'FAST FOOD RESTAURANTS', slaStatus: 'On Track', agingMinutes: 0, agingHours: 0 };
  const diff = getPriorityScore({ ...base, rejectCategory: 'Foto Tidak Ada' }) - getPriorityScore({ ...base, rejectCategory: null });
  assert.strictEqual(diff, 25);
});

// ── sortByPriority ────────────────────────────────────────────────────────
test('sortByPriority: urut P0..P3, dalam level sama score tertinggi dulu', () => {
  const records = [
    { id: 'a', priorityLevel: 'P2', priorityScore: 10 },
    { id: 'b', priorityLevel: 'P0', priorityScore: 5 },
    { id: 'c', priorityLevel: 'P0', priorityScore: 20 },
    { id: 'd', priorityLevel: 'P3', priorityScore: 0 },
  ];
  assert.deepStrictEqual(sortByPriority(records).map(r => r.id), ['c', 'b', 'a', 'd']);
});

// ── buildMergedMerchant — aging & SLA end-to-end ─────────────────────────
test('buildMergedMerchant: aging dihitung dari field prioritas tertinggi yang terisi, breach setelah 2 hari', () => {
  const verifikasiLocal = new Date(2026, 5, 20, 13, 0, 0); // 20/06/2026 13:00 lokal
  const nowLocal         = new Date(2026, 5, 22, 13, 0, 0); // +2 hari -> pasti Breach (SLA Perlu Perbaikan = 1440 menit)
  const rec = buildMergedMerchant(
    { ID_Outlet: '777', Nama_Outlet: 'Toko Aging', MCC: 'VARIETY STORES', Tanggal_Registrasi: '18/06/2026 08:00', Tanggal_Aktivasi: '18/06/2026 08:05' },
    { Tanggal_KYC: '18/06/2026 09:00', 'Tanggal_Submit_Foto_Product dan Foto_toko': '18/06/2026 10:00' },
    { Tanggal_Verifikasi: '20/06/2026 13:00', Status: 'Perbaikan Data', 'Reason Reject data KYC': 'Tidak ada foto produk' },
    null,
    nowLocal
  );
  assert.strictEqual(rec.lastActivityTime, verifikasiLocal.toISOString());
  assert.strictEqual(rec.agingMinutes, 2 * 24 * 60);
  assert.strictEqual(rec.slaStatus, 'Breach');
  assert.strictEqual(rec.priorityLevel, 'P1'); // Perlu Perbaikan Data, belum ada tanda revisi
  assert.ok(rec.priorityScore > 0);
});

// ── Runner ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (${tests.length} total)`);
process.exit(fail ? 1 : 0);
