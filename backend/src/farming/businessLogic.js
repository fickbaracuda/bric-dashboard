'use strict';

/**
 * Business logic Farming Command Center — SEMUA di backend, frontend murni
 * presentasi. Dua tahap:
 *   1. `computeRowMetrics(row)` — kalkulasi per-outlet yang tidak butuh
 *      konteks batch (ARPT, growth status, anomaly flag, segment dasar).
 *   2. `finalizePriorities(rows)` — kalkulasi yang butuh konteks SELURUH
 *      batch snapshot (revenue-at-risk ranking, kontributor besar) untuk
 *      menentukan priority P0-P3 final + priority_score + reason_codes.
 *
 * Lihat docs/FARMING_COMMAND_CENTER.md §Business Logic untuk penjelasan tiap
 * threshold dan alasan urutan cascade.
 */

const { safeDiv, safePctChange } = require('./numberParser');

const HIGH_VALUE_LAYERS = new Set(['High ARPU', 'Top ARPU']);
const LOW_VALUE_LAYERS = new Set(['Low ARPU', 'Mid ARPU']);

function isHighValueLayer(layerArpu) {
  return HIGH_VALUE_LAYERS.has(String(layerArpu || '').trim());
}
function isLowValueLayer(layerArpu) {
  return LOW_VALUE_LAYERS.has(String(layerArpu || '').trim());
}

/**
 * Growth status — cascade eksplisit. `zero_activity` sengaja dicek SEBELUM
 * `stable` (bukan persis urutan teks di spec) karena outlet yang TIDAK
 * PERNAH aktif di kedua periode (0 vs 0) akan salah dikira "stable" (devPct
 * = 0 masuk band stabil) kalau zero_activity dicek belakangan — lihat
 * docs/FARMING_COMMAND_CENTER.md §8.1 catatan urutan.
 */
function computeGrowthStatus({ previousTrx, currentTrx, currentRevenue, devRevenuePct, devTrxPct, layerArpu }) {
  if (typeof previousTrx !== 'number' || typeof currentTrx !== 'number') return 'unknown';

  if (previousTrx > 0 && currentTrx === 0) return 'churned';
  if (previousTrx === 0 && currentTrx > 0) return 'new_active';
  if (previousTrx === 0 && currentTrx === 0) return 'zero_activity';

  const highValue = isHighValueLayer(layerArpu);

  if (devRevenuePct !== null && devRevenuePct <= -0.25) return 'critical_decline';
  if (highValue && devTrxPct !== null && devTrxPct <= -0.25) return 'critical_decline';

  if (devRevenuePct !== null && devRevenuePct <= -0.10) return 'declining';
  if (devTrxPct !== null && devTrxPct <= -0.10) return 'declining';

  if (devRevenuePct !== null && devRevenuePct >= 0.25 && (currentRevenue || 0) > 0) return 'rocket_growth';

  if (devRevenuePct !== null && devRevenuePct >= 0.10) return 'growing';
  if (devTrxPct !== null && devTrxPct >= 0.10) return 'growing';

  if (devRevenuePct !== null || devTrxPct !== null) return 'stable';
  return 'unknown';
}

function computeAnomalyFlags({ currentTrx, currentRevenue, devTrx, devRevenue }) {
  const flags = [];
  if ((currentTrx || 0) > 0 && (currentRevenue || 0) === 0) flags.push('volume_no_revenue');
  if (typeof devTrx === 'number' && typeof devRevenue === 'number') {
    if (devTrx > 0 && devRevenue < 0) flags.push('trx_up_revenue_down');
    if (devTrx < 0 && devRevenue > 0) flags.push('trx_down_revenue_up');
  }
  return flags;
}

const SEGMENT_RECOMMENDED_ACTION = {
  churned: 'Hubungi outlet dan identifikasi penyebab berhenti transaksi.',
  high_value_at_risk: 'Prioritaskan recovery outlet bernilai tinggi dan cek perpindahan volume transaksi.',
  volume_no_revenue: 'Periksa produk, fee, mapping revenue, atau transaksi zero margin.',
  monetization_problem: 'Evaluasi perubahan komposisi produk dan revenue per transaksi.',
  frequency_problem: 'Dorong peningkatan frekuensi transaksi melalui program aktivasi ulang.',
  upgrade_opportunity: 'Tawarkan program untuk meningkatkan volume dan ARPU outlet.',
  growth_champion: 'Pertahankan pola pertumbuhan dan identifikasi peluang replikasi.',
  stable_core: 'Jaga engagement dan lakukan monitoring rutin.',
  low_value_stable: 'Monitoring rutin, kandidat program aktivasi ringan bila kapasitas tersedia.',
  new_active: 'Pastikan onboarding berjalan baik, pantau transaksi minggu-minggu awal.',
  data_review: 'Data tidak cukup / layer ARPU tidak dikenali — cek kelengkapan data sheet.',
};

/**
 * Segmentasi — cascade eksplisit, urutan prioritas dari paling spesifik ke
 * paling umum (lihat docs untuk alasan urutan tiap segmen).
 */
function computeSegment({ status, layerArpu, anomalyFlags, devTrx, devRevenue }) {
  if (status === 'churned') return 'Churned';
  if (status === 'new_active') return 'New Active';
  if (anomalyFlags.includes('volume_no_revenue')) return 'Volume No Revenue';
  if (isHighValueLayer(layerArpu) && (status === 'critical_decline' || status === 'declining')) return 'High Value At Risk';
  if ((status === 'rocket_growth' || status === 'growing')) {
    if (isLowValueLayer(layerArpu) && typeof devTrx === 'number' && devTrx > 0) return 'Upgrade Opportunity';
    return 'Growth Champion';
  }
  if (typeof devTrx === 'number' && typeof devRevenue === 'number') {
    if (devTrx < 0 && devRevenue <= 0) return 'Frequency Problem';
    if (devTrx >= 0 && devRevenue < 0) return 'Monetization Problem';
  }
  if (isHighValueLayer(layerArpu) && status === 'stable') return 'Stable Core';
  if (isLowValueLayer(layerArpu) && status === 'stable') return 'Low Value Stable';
  return 'Data Review';
}

function segmentToActionKey(segment) {
  return String(segment || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function recommendedActionForSegment(segment) {
  return SEGMENT_RECOMMENDED_ACTION[segmentToActionKey(segment)] || SEGMENT_RECOMMENDED_ACTION.data_review;
}

/**
 * Tahap 1 — kalkulasi per-outlet (tanpa konteks batch). `row` minimal
 * berisi previousTrx/previousRevenue/currentTrx/currentRevenue/devTrx(calc)
 * /devRevenue(calc)/layerArpu.
 */
function computeRowMetrics(row) {
  const {
    previousTrx, previousRevenue, currentTrx, currentRevenue,
    calculatedDevTrx, calculatedDevRevenue, layerArpu,
  } = row;

  const previousArpt = safeDiv(previousRevenue, previousTrx);
  const currentArpt = safeDiv(currentRevenue, currentTrx);
  const arptChange = (previousArpt !== null && currentArpt !== null) ? (currentArpt - previousArpt) : null;
  const arptChangePct = safePctChange(currentArpt, previousArpt);

  const devRevenuePct = safePctChange(currentRevenue, previousRevenue);
  const devTrxPct = safePctChange(currentTrx, previousTrx);

  const status = computeGrowthStatus({
    previousTrx, currentTrx, currentRevenue, devRevenuePct, devTrxPct, layerArpu,
  });
  const anomalyFlags = computeAnomalyFlags({
    currentTrx, currentRevenue, devTrx: calculatedDevTrx, devRevenue: calculatedDevRevenue,
  });
  const segment = computeSegment({ status, layerArpu, anomalyFlags, devTrx: calculatedDevTrx, devRevenue: calculatedDevRevenue });
  const revenueAtRisk = (status === 'declining' || status === 'critical_decline' || status === 'churned')
    ? Math.max((previousRevenue || 0) - (currentRevenue || 0), 0)
    : 0;

  return {
    previous_arpt: previousArpt,
    current_arpt: currentArpt,
    arpt_change: arptChange,
    arpt_change_pct: arptChangePct,
    dev_revenue_pct: devRevenuePct,
    dev_trx_pct: devTrxPct,
    status,
    anomaly_flags: anomalyFlags,
    segment,
    revenue_at_risk: revenueAtRisk,
    recommended_action: recommendedActionForSegment(segment),
  };
}

/**
 * Tahap 2 — finalisasi priority P0-P3 + priority_score, butuh KONTEKS
 * SELURUH BATCH (percentile revenue-at-risk, kontributor revenue terbesar).
 * `rows` = array hasil computeRowMetrics + field mentah yang sudah digabung.
 * Mutates & returns rows dengan field priority/priority_score/reason_codes.
 */
function finalizePriorities(rows) {
  const revenueAtRiskSorted = rows.map(r => r.revenue_at_risk || 0).filter(v => v > 0).sort((a, b) => b - a);
  const p90RevenueAtRisk = percentile(revenueAtRiskSorted, 0.90);

  const previousRevenueSorted = rows.map(r => r.previousRevenue || 0).filter(v => v > 0).sort((a, b) => b - a);
  const bigContributorThreshold = percentile(previousRevenueSorted, 0.80); // top ~20% kontributor revenue

  for (const r of rows) {
    const reasonCodes = [];
    const highValue = isHighValueLayer(r.layerArpu);
    let priority = 'P3';

    const isBigDecliner = (r.revenue_at_risk || 0) > 0 && p90RevenueAtRisk > 0 && r.revenue_at_risk >= p90RevenueAtRisk;
    const isBigContributor = (r.previousRevenue || 0) > 0 && bigContributorThreshold > 0 && r.previousRevenue >= bigContributorThreshold;

    // ── P0 ──
    if (r.status === 'churned') { priority = 'P0'; reasonCodes.push('churned'); }
    if (highValue && r.status === 'critical_decline') { priority = 'P0'; reasonCodes.push('high_value_critical_decline'); }
    if (r.dev_revenue_pct !== null && r.dev_revenue_pct <= -0.25) { priority = 'P0'; reasonCodes.push('revenue_drop_25pct'); }
    if (highValue && r.dev_trx_pct !== null && r.dev_trx_pct <= -0.25) { priority = 'P0'; reasonCodes.push('high_value_trx_drop_25pct'); }
    if (r.anomaly_flags.includes('volume_no_revenue')) { priority = 'P0'; reasonCodes.push('volume_no_revenue'); }
    if (isBigDecliner) { priority = 'P0'; reasonCodes.push('top_revenue_loss_contributor'); }

    // ── P1 (hanya kalau belum P0) ──
    if (priority !== 'P0') {
      if (r.dev_revenue_pct !== null && r.dev_revenue_pct <= -0.10) { priority = 'P1'; reasonCodes.push('revenue_drop_10_25pct'); }
      if (r.dev_trx_pct !== null && r.dev_trx_pct <= -0.10) { priority = 'P1'; reasonCodes.push('trx_drop_10_25pct'); }
      if (highValue && r.status === 'declining') { priority = 'P1'; reasonCodes.push('high_value_declining'); }
      if (r.anomaly_flags.includes('trx_up_revenue_down')) { priority = 'P1'; reasonCodes.push('trx_up_revenue_down'); }
      if (isBigContributor && (r.dev_revenue_pct !== null && r.dev_revenue_pct < 0)) { priority = 'P1'; reasonCodes.push('big_contributor_weakening'); }
    }

    // ── P2 (hanya kalau belum P0/P1) ──
    if (priority === 'P3') {
      if (r.status === 'rocket_growth' || r.status === 'growing') { priority = 'P2'; reasonCodes.push('growth_opportunity'); }
      if (isLowValueLayer(r.layerArpu) && (r.status === 'rocket_growth' || r.status === 'growing')) { priority = 'P2'; reasonCodes.push('upgrade_candidate'); }
      // Ambang 5% sengaja dipakai (bukan 0%) supaya outlet "stable" dengan
      // selisih kecil (mis. +1% vs 0%) tidak salah ter-flag P2 — hanya
      // gap yang cukup berarti yang dianggap sinyal "ARPU membaik".
      if (r.dev_revenue_pct !== null && r.dev_trx_pct !== null && r.dev_revenue_pct >= 0.05 && (r.dev_revenue_pct - r.dev_trx_pct) >= 0.05) { priority = 'P2'; reasonCodes.push('revenue_outpacing_trx'); }
    }

    if (!reasonCodes.length) reasonCodes.push(r.status === 'unknown' ? 'insufficient_data' : 'no_urgent_signal');

    // priority_score — secondary sort dalam priority level yang sama, bukan formula presisi
    const valueWeight = { 'Top ARPU': 4, 'High ARPU': 3, 'Mid ARPU': 2, 'Low ARPU': 1 }[String(r.layerArpu || '').trim()] || 0;
    const declineSeverity = r.dev_revenue_pct !== null && r.dev_revenue_pct < 0 ? Math.abs(r.dev_revenue_pct) : 0;
    const growthOpportunity = r.dev_revenue_pct !== null && r.dev_revenue_pct > 0 ? r.dev_revenue_pct : 0;
    const revenueImpactScore = Math.min((r.revenue_at_risk || 0) / 100000, 50);
    const priorityScore =
      valueWeight * 10 +
      declineSeverity * 100 +
      (r.status === 'churned' ? 50 : 0) +
      (r.anomaly_flags.includes('volume_no_revenue') ? 30 : 0) +
      (r.anomaly_flags.length ? 15 * r.anomaly_flags.length : 0) +
      growthOpportunity * 40 +
      revenueImpactScore;

    r.priority = priority;
    r.priority_score = Math.round(priorityScore * 100) / 100;
    r.reason_codes = reasonCodes;
  }
  return rows;
}

function percentile(sortedDesc, p) {
  if (!sortedDesc.length) return 0;
  const idx = Math.floor((1 - p) * (sortedDesc.length - 1));
  return sortedDesc[Math.max(0, Math.min(sortedDesc.length - 1, idx))];
}

module.exports = {
  computeGrowthStatus,
  computeAnomalyFlags,
  computeSegment,
  computeRowMetrics,
  finalizePriorities,
  recommendedActionForSegment,
  isHighValueLayer,
  isLowValueLayer,
};
