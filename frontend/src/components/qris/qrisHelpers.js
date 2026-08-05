// Logic murni — QRIS Issuance Control Tower multi-tab dashboard.
//
// PENTING: aggregateMetrics, buildFunnelMetrics, buildChartData,
// buildAgingBuckets, compareQueueRecords, buildInsights, getReminderTemplate
// (bagian rejectCategory), buildRejectReasonText, copyToClipboard, groupBy,
// round2, computeAvgTAT, fmtNum/fmtDateTime/fmtAging, getQueueEmptyMessage
// dipindah APA ADANYA dari WarRoomQrisControlTower.jsx sebelum refactor —
// tidak ada satu baris pun logic currentStage/stageOwner/SLA/aging/priority
// yang diubah. Backend (warroom-qris-control-tower.js) yang menghitung
// semua field itu tidak disentuh sama sekali.
//
// Fungsi baru (ditandai "BARU" di komentar) murni komposisi/filter di atas
// field yang sudah ada di unified merchant record — tidak menambah rule
// bisnis baru, cuma menyusun ulang record yang sama untuk kebutuhan tab.

import { STAGE, ALL_STAGES, REMINDER_TEMPLATES, REJECT_CATEGORY_TO_TEMPLATE, AGING_BUCKETS } from './qrisConstants';

/* ─ Formatter ─ */
export const fmtNum = (v) => (Number(v) || 0).toLocaleString('id-ID');

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAging(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes}m`;
  const totalHours = Math.floor(minutes / 60);
  if (totalHours < 24) return `${totalHours}j ${minutes % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `${days}h ${totalHours % 24}j`;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ─ Group-by generik — dipakai buildChartData & agregasi tab lain ─ */
export function groupBy(records, keyFn, { emptyLabel = 'Belum Ada', topN = null, otherLabel = 'Lainnya' } = {}) {
  const counts = new Map();
  for (const r of records) {
    const raw = keyFn(r);
    const key = (raw == null || raw === '') ? emptyLabel : String(raw);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let entries = [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  if (topN && entries.length > topN) {
    const top = entries.slice(0, topN);
    const otherCount = entries.slice(topN).reduce((s, e) => s + e.count, 0);
    entries = otherCount > 0 ? [...top, { label: otherLabel, count: otherCount }] : top;
  }
  return entries;
}

/* ─ Sort default queue: priorityLevel asc (P0→P3) → priorityScore desc → agingMinutes desc ─ */
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function compareQueueRecords(a, b) {
  const pDiff = (PRIORITY_ORDER[a.priorityLevel] ?? 9) - (PRIORITY_ORDER[b.priorityLevel] ?? 9);
  if (pDiff !== 0) return pDiff;
  const scoreDiff = (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  return (b.agingMinutes ?? -1) - (a.agingMinutes ?? -1);
}

/* ─ avgTATRegistrationToIssued — proxy tanggalSubmitPTEN, selalu estimasi ─ */
export function computeAvgTAT(records) {
  const diffs = [];
  for (const r of records) {
    if (r.statusPTEN !== 'APPROVE' || !r.tanggalRegistrasi) continue;
    const endIso = r.tanggalSubmitPTEN || r.lastActivityTime;
    if (!endIso) continue;
    const days = (new Date(endIso).getTime() - new Date(r.tanggalRegistrasi).getTime()) / 86400000;
    if (Number.isFinite(days) && days >= 0) diffs.push(days);
  }
  if (!diffs.length) return { avgDays: null, sampleSize: 0, isEstimate: true };
  return { avgDays: round2(diffs.reduce((a, b) => a + b, 0) / diffs.length), sampleSize: diffs.length, isEstimate: true };
}

/** 12 metric KPI — angka mentah, 2 rate, 1 TAT estimasi. */
export function aggregateMetrics(records) {
  const total = records.length;
  const c = (pred) => records.filter(pred).length;

  const totalRegistrasi   = total;
  const totalQRISTerbit   = c(r => r.statusPTEN === 'APPROVE');
  const totalBelumLengkap = c(r => r.currentStage === STAGE.DATA_BELUM_LENGKAP || r.statusVerifikasiOP === 'Belum Lengkap' || r.statusPTEN === 'Belum Lengkap');
  const totalRejected     = c(r => r.statusPTEN === 'REJECTED' || r.statusVerifikasiOP === 'Perbaikan Data');
  const totalMenungguVerifikasi = c(r => r.statusVerifikasiOP === 'Menunggu Verifikasi' || r.statusPTEN === 'Menunggu Verifikasi');
  const totalPendingPTEN  = c(r => r.statusPTEN === 'Pending PTEN');
  const totalOverSLA      = c(r => r.slaStatus === 'Breach');
  const totalMerchantBacklog = c(r => r.isMerchantBacklog === true);
  const totalInternalBacklog = c(r => r.isInternalBacklog === true);

  return {
    totalRegistrasi, totalQRISTerbit, totalBelumLengkap, totalRejected,
    totalMenungguVerifikasi, totalPendingPTEN, totalOverSLA,
    totalMerchantBacklog, totalInternalBacklog,
    issuanceRate: total > 0 ? round2((totalQRISTerbit / total) * 100) : 0,
    backlogRate:  total > 0 ? round2(((total - totalQRISTerbit) / total) * 100) : 0,
    avgTATRegistrationToIssued: computeAvgTAT(records),
  };
}

/** Funnel 7-step: Registrasi (semua outlet) → Aktivasi → KYC → Foto → OS Verify → PTEN Submit → Terbit. */
export function buildFunnelMetrics(records) {
  const total = records.length;
  const steps = [
    { key: 'registrasi', label: 'Registrasi',  count: total },
    { key: 'aktivasi',   label: 'Aktivasi',    count: records.filter(r => r.tanggalAktivasi != null).length },
    { key: 'kyc',        label: 'KYC',         count: records.filter(r => r.tanggalKYC != null).length },
    { key: 'foto',       label: 'Foto',        count: records.filter(r => r.tanggalSubmitFoto != null).length },
    { key: 'osverify',   label: 'OS Verify',   count: records.filter(r => r.tanggalVerifikasiOP != null).length },
    { key: 'ptensubmit', label: 'PTEN Submit', count: records.filter(r => r.tanggalSubmitPTEN != null).length },
    { key: 'terbit',     label: 'Terbit',      count: records.filter(r => r.statusPTEN === 'APPROVE').length },
  ];
  return steps.map((s, i) => {
    const prevCount = i === 0 ? total : steps[i - 1].count;
    const dropOff = Math.max(0, prevCount - s.count);
    return {
      ...s,
      conversionRate: prevCount > 0 ? round2((s.count / prevCount) * 100) : 0,
      dropOff,
      dropOffRate: prevCount > 0 ? round2((dropOff / prevCount) * 100) : 0,
    };
  });
}

export function buildAgingBuckets(records) {
  const buckets = AGING_BUCKETS.map(b => ({ key: b.key, bucket: b.label, count: 0 }));
  for (const r of records) {
    if (r.currentStage === STAGE.QRIS_TERBIT || r.agingMinutes == null) continue;
    const idx = AGING_BUCKETS.findIndex(b => r.agingMinutes <= b.max);
    buckets[idx === -1 ? buckets.length - 1 : idx].count++;
  }
  return buckets;
}

/** 7 chart Bottleneck — semua { label, count }[], sudah sort desc. */
export function buildChartData(records) {
  return {
    statusPtenDistribution:  groupBy(records, r => r.statusPTEN, { emptyLabel: 'Belum Ada Status' }),
    statusOpDistribution:    groupBy(records, r => r.statusVerifikasiOP, { emptyLabel: 'Belum Ada Status' }),
    stageDistribution:       ALL_STAGES.map(stage => ({ label: stage, count: records.filter(r => r.currentStage === stage).length })),
    stageOwnerDistribution:  groupBy(records, r => r.stageOwner, { emptyLabel: 'Tidak Diketahui' }),
    agingBucketDistribution: buildAgingBuckets(records).map(b => ({ label: b.bucket, count: b.count })),
    rejectReasonDistribution: groupBy(records.filter(r => r.rejectCategory), r => r.rejectCategory, { topN: 10 }),
    mccBacklogDistribution:  groupBy(records.filter(r => r.currentStage !== STAGE.QRIS_TERBIT), r => r.mcc, { emptyLabel: 'Tidak Diketahui', topN: 15 }),
  };
}

/* ─ Action helpers — reminder template & reject reason (untuk Copy Reminder / Copy Reject Reason) ─ */
export function getReminderTemplate(record) {
  if (record?.rejectCategory && REJECT_CATEGORY_TO_TEMPLATE[record.rejectCategory]) {
    return REMINDER_TEMPLATES[REJECT_CATEGORY_TO_TEMPLATE[record.rejectCategory]];
  }
  // BARU: 2 stage yang sebelumnya tidak punya template (rejectCategory
  // memang selalu null di stage ini, reject cuma terjadi di VerifikasiOP/PTEN)
  if (record?.currentStage === STAGE.BELUM_ISI_KYC)     return REMINDER_TEMPLATES.BELUM_KYC;
  if (record?.currentStage === STAGE.BELUM_SUBMIT_FOTO) return REMINDER_TEMPLATES.BELUM_FOTO;
  return REMINDER_TEMPLATES.BELUM_LENGKAP;
}

export function buildRejectReasonText(record) {
  const parts = [];
  if (record?.rejectCategory) parts.push(`Kategori: ${record.rejectCategory}`);
  if (record?.reasonRejectDataKYC) parts.push(`KYC: ${record.reasonRejectDataKYC}`);
  if (record?.reasonRejectDataPTEN) parts.push(`PTEN: ${record.reasonRejectDataPTEN}`);
  return parts.length ? parts.join('\n') : 'Tidak ada alasan reject tercatat';
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ─ Empty-state Smart Queue / tabel lain — kontekstual sesuai filter aktif ─ */
export function getQueueEmptyMessage(f) {
  if (f.search?.trim())         return 'Tidak ada outlet yang cocok dengan pencarian ini.';
  if (f.priority === 'P0')      return 'Tidak ada antrean urgent. Semua proses kritikal aman.';
  if (f.slaStatus === 'Breach') return 'Tidak ada data yang melewati SLA.';
  return 'Tidak ada data pendaftaran pada periode ini.';
}

/* ─ Insight otomatis Command Center — dihitung dari SELURUH data (setelah filter global) ─ */
const REJECTED_RATE_ALERT_THRESHOLD = 0.15;

export function buildInsights(metrics, records) {
  const insights = [];
  const p0Count = records.filter(r => r.priorityLevel === 'P0').length;

  if (p0Count > 0) {
    insights.push({ color: 'merah', title: '🚨 Prioritas Urgent', message: `Ada ${fmtNum(p0Count)} outlet prioritas P0 yang perlu segera diproses.` });
  }

  const bottlenecks = [
    ['Data Belum Lengkap', metrics.totalBelumLengkap],
    ['Rejected', metrics.totalRejected],
    ['Menunggu Verifikasi', metrics.totalMenungguVerifikasi],
    ['Pending PTEN', metrics.totalPendingPTEN],
  ];
  const [topLabel, topCount] = [...bottlenecks].sort((a, b) => b[1] - a[1])[0];
  if (topLabel === 'Data Belum Lengkap' && topCount > 0) {
    insights.push({ color: 'kuning', title: '⚠️ Bottleneck Data Belum Lengkap', message: 'Bottleneck terbesar saat ini adalah data belum lengkap. Fokus follow-up merchant.' });
  }

  const rejectedRate = metrics.totalRegistrasi > 0 ? metrics.totalRejected / metrics.totalRegistrasi : 0;
  if (rejectedRate >= REJECTED_RATE_ALERT_THRESHOLD) {
    insights.push({ color: 'kuning', title: '📋 Reject Rate Tinggi', message: 'Reject/perbaikan data cukup tinggi. Cek reason reject dominan untuk perbaikan onboarding.' });
  }

  if (metrics.totalPendingPTEN > 0) {
    insights.push({ color: 'kuning', title: '⏳ Menunggu PTEN', message: 'Ada outlet yang menunggu proses PTEN. Perlu follow-up agar QRIS cepat terbit.' });
  }

  // BARU: backlog merchant vs internal (diminta eksplisit di Tab 1) — angka
  // dari metrics yang sudah ada, cuma dijadikan kalimat insight.
  if (metrics.totalMerchantBacklog > 0 || metrics.totalInternalBacklog > 0) {
    const dominant = metrics.totalMerchantBacklog >= metrics.totalInternalBacklog ? 'merchant' : 'internal';
    insights.push({
      color: 'kuning', title: '⚖️ Backlog Merchant vs Internal',
      message: `Backlog merchant: ${fmtNum(metrics.totalMerchantBacklog)} outlet, backlog internal: ${fmtNum(metrics.totalInternalBacklog)} outlet. Mayoritas backlog ada di sisi ${dominant}.`,
    });
  }

  // BARU: jumlah over SLA sebagai insight (sebelumnya cuma KPI card, sekarang diminta juga muncul sebagai insight)
  if (metrics.totalOverSLA > 0) {
    insights.push({ color: 'merah', title: '⏱️ Outlet Over SLA', message: `${fmtNum(metrics.totalOverSLA)} outlet sudah melewati batas waktu ideal pada stage saat ini.` });
  }

  return insights;
}

/**
 * Export CSV — pola sama persis dengan exportCSV() di WarRoomSpeedcash.jsx
 * (Blob + BOM UTF-8 supaya Excel baca karakter Indonesia dengan benar).
 * Dipakai Tab 7 (Raw Data & Audit).
 */
export function exportQrisCsv(records, filename = 'qris-raw-data.csv') {
  if (!records?.length) return;
  const rows = records.map(r => ({
    'ID Outlet': r.idOutlet,
    'Nama Outlet': r.namaOutlet || '',
    'MCC': r.mcc || '',
    'Tanggal Registrasi': fmtDateTime(r.tanggalRegistrasi),
    'Tanggal Aktivasi': fmtDateTime(r.tanggalAktivasi),
    'Tanggal KYC': fmtDateTime(r.tanggalKYC),
    'Tanggal Submit Foto': fmtDateTime(r.tanggalSubmitFoto),
    'Tanggal Verifikasi OP': fmtDateTime(r.tanggalVerifikasiOP),
    'Status OP': r.statusVerifikasiOP || '',
    'Reason Reject KYC': r.reasonRejectDataKYC || '',
    'Reason Reject PTEN': r.reasonRejectDataPTEN || '',
    'Tanggal Submit PTEN': fmtDateTime(r.tanggalSubmitPTEN),
    'Status PTEN': r.statusPTEN || '',
    'Current Stage': r.currentStage,
    'Stage Owner': r.stageOwner,
    'Aging (menit)': r.agingMinutes ?? '',
    'SLA Status': r.slaStatus || '',
    'Priority': r.priorityLevel,
    'Priority Score': r.priorityScore,
  }));
  const keys = Object.keys(rows[0]);
  const bom = '﻿';
  const csv = [
    keys.join(','),
    ...rows.map(r => keys.map(k => {
      const v = r[k] == null ? '' : String(r[k]);
      return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','))
  ].join('\n');
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════════════════════
 * Helper BARU — komposisi trivial di atas field unified record yang sudah
 * ada, untuk kebutuhan tab baru (Top Urgent, SLA breakdown, reject by MCC/
 * stage, filter predicate per tab, badge count tab). Tidak ada rule bisnis
 * baru — semua cuma filter/group ulang record yang sama.
 * ══════════════════════════════════════════════════════════════════════ */

/** Tab 1 — Top Urgent Today: max N outlet P0, urutan sama seperti Smart Queue. */
export function getTopUrgent(records, n = 10) {
  return [...records].filter(r => r.priorityLevel === 'P0').sort(compareQueueRecords).slice(0, n);
}

export function countByPriorities(records, levels) {
  return records.filter(r => levels.includes(r.priorityLevel)).length;
}

/** Tab 4 — hanya outlet yang butuh aksi merchant. */
export function filterMerchantBacklog(records) {
  return records.filter(r => r.isMerchantBacklog === true);
}

/** Tab 5 — hanya outlet yang butuh aksi internal/verifikator/PTEN. */
export function filterInternalBacklog(records) {
  return records.filter(r => r.isInternalBacklog === true);
}

/** Tab 6 — outlet reject/perbaikan data (sama persis dgn totalRejected di aggregateMetrics). */
export function filterRejected(records) {
  return records.filter(r => r.statusPTEN === 'REJECTED' || r.statusVerifikasiOP === 'Perbaikan Data');
}

/** Tab 4 — 5 tipe follow-up. "Perbaikan Data" vs "Rejected" bisa overlap
 * (1 outlet bisa masuk keduanya kalau statusVerifikasiOP DAN statusPTEN
 * sama-sama menunjukkan reject) — sengaja tidak dieksklusifkan karena
 * datanya memang bisa begitu (dikonfirmasi lewat QA data produksi). */
export function matchesFollowupType(record, type) {
  switch (type) {
    case 'Belum KYC':      return record.currentStage === STAGE.BELUM_ISI_KYC;
    case 'Belum Foto':     return record.currentStage === STAGE.BELUM_SUBMIT_FOTO;
    case 'Belum Lengkap':  return record.currentStage === STAGE.DATA_BELUM_LENGKAP;
    case 'Perbaikan Data': return record.currentStage === STAGE.PERLU_PERBAIKAN && record.statusVerifikasiOP === 'Perbaikan Data';
    case 'Rejected':       return record.currentStage === STAGE.PERLU_PERBAIKAN && record.statusPTEN === 'REJECTED';
    default: return true;
  }
}

/** Tab 5 — 5 tipe internal stage. "Siap Verifikasi" vs "Menunggu Verifikasi"
 * TIDAK punya stage terpisah di backend (cuma ada 1: Menunggu Verifikasi
 * OS) — dibedakan lewat slaStatus (On Track = baru masuk antrean = "siap",
 * Warning/Breach = sudah lama nunggu = "menunggu"). Asumsi tampilan, bukan
 * business logic baru. */
export function matchesInternalStage(record, type) {
  switch (type) {
    case 'Siap Verifikasi':     return record.currentStage === STAGE.MENUNGGU_VERIFIKASI_OS && record.slaStatus === 'On Track';
    case 'Menunggu Verifikasi': return record.currentStage === STAGE.MENUNGGU_VERIFIKASI_OS && record.slaStatus !== 'On Track';
    case 'Siap Submit PTEN':    return record.currentStage === STAGE.SIAP_SUBMIT_PTEN;
    case 'Pending PTEN':        return record.currentStage === STAGE.PENDING_PTEN;
    case 'Menunggu PTEN':       return record.currentStage === STAGE.MENUNGGU_PTEN;
    default: return true;
  }
}

/** Tab 7 — 4 tipe data completeness. */
export function matchesCompleteness(record, type) {
  switch (type) {
    case 'Missing KYC':  return !record.tanggalKYC;
    case 'Missing Foto': return !record.tanggalSubmitFoto;
    case 'Missing OP':   return !record.tanggalVerifikasiOP;
    case 'Missing PTEN': return !record.tanggalSubmitPTEN;
    default: return true;
  }
}

/** Tab 1 — quick filter (Semua/Hari ini/Over SLA/Belum Terbit). */
export function matchesCommandQuickFilter(record, filter, now = new Date()) {
  switch (filter) {
    case 'Hari ini':     return !!record.tanggalRegistrasi && record.tanggalRegistrasi.slice(0, 10) === now.toISOString().slice(0, 10);
    case 'Over SLA':     return record.slaStatus === 'Breach';
    case 'Belum Terbit': return record.currentStage !== STAGE.QRIS_TERBIT;
    default: return true;
  }
}

/** Tab 3 — breakdown over-SLA per currentStage / per stageOwner. */
export function buildSlaBreachByStage(records) {
  const breach = records.filter(r => r.slaStatus === 'Breach');
  return ALL_STAGES.map(stage => ({ label: stage, count: breach.filter(r => r.currentStage === stage).length })).filter(x => x.count > 0);
}
export function buildSlaBreachByOwner(records) {
  const breach = records.filter(r => r.slaStatus === 'Breach');
  return groupBy(breach, r => r.stageOwner, { emptyLabel: 'Tidak Diketahui' });
}

/** Tab 3 — filter by aging bucket label (mis. "0–30 menit"). */
export function matchesAgingBucket(record, bucketLabel) {
  if (record.agingMinutes == null) return false;
  const idx = AGING_BUCKETS.findIndex(b => record.agingMinutes <= b.max);
  const actual = AGING_BUCKETS[idx === -1 ? AGING_BUCKETS.length - 1 : idx];
  return actual.label === bucketLabel;
}

/** Tab 3 — list "Stuck Too Long": outlet aktif (belum terbit) diurutkan aging terlama. */
export function getStuckTooLong(records, n = 50) {
  return [...records]
    .filter(r => r.currentStage !== STAGE.QRIS_TERBIT && r.agingMinutes != null)
    .sort((a, b) => (b.agingMinutes ?? 0) - (a.agingMinutes ?? 0))
    .slice(0, n);
}

/** Tab 6 — reject by MCC / by currentStage (di antara outlet yang reject-nya jelas / Perlu Perbaikan Data). */
export function buildRejectByMcc(records) {
  return groupBy(records.filter(r => r.rejectCategory), r => r.mcc, { emptyLabel: 'Tidak Diketahui', topN: 15 });
}
export function buildRejectByStage(records) {
  const rejected = filterRejected(records);
  return groupBy(rejected, r => r.currentStage, { emptyLabel: 'Tidak Diketahui' });
}

/** Tab 6 — insight otomatis reject (pola sama seperti buildInsights). */
export function buildBottleneckInsights(records) {
  const insights = [];
  const rejected = filterRejected(records);
  if (!rejected.length) return insights;

  const reasonDist = groupBy(rejected.filter(r => r.rejectCategory), r => r.rejectCategory);
  if (reasonDist.length) {
    insights.push({
      color: 'kuning', title: '📋 Reason Reject Dominan',
      message: `Alasan reject paling sering: "${reasonDist[0].label}" (${fmtNum(reasonDist[0].count)} outlet dari ${fmtNum(rejected.length)} reject/perbaikan data).`,
    });
  }

  const mccDist = buildRejectByMcc(records);
  if (mccDist.length && mccDist[0].label !== 'Tidak Diketahui') {
    insights.push({
      color: 'kuning', title: '🏷️ MCC Paling Sering Bermasalah',
      message: `Kategori usaha "${mccDist[0].label}" paling banyak reject (${fmtNum(mccDist[0].count)} outlet). Pertimbangkan edukasi onboarding khusus kategori ini.`,
    });
  }

  if (reasonDist.length && (reasonDist[0].label === 'Foto Dari Sumber Online' || reasonDist[0].label === 'Foto Tidak Sesuai Usaha')) {
    insights.push({
      color: 'merah', title: '💡 Rekomendasi Perbaikan Onboarding',
      message: 'Mayoritas reject terkait foto. Pertimbangkan tambahkan contoh foto yang benar di form pendaftaran / panduan sebelum submit, supaya merchant tidak perlu revisi berkali-kali.',
    });
  }

  return insights;
}
