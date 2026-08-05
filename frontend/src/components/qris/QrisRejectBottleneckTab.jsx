import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { KPICard, InsightBanner, DonutChart, HBarChart, ChartOrEmpty } from './QrisSharedUI';
import { RED, BLUE, PURPLE, CHART_COLORS, ALL_STAGES, STATUS_OP_OPTIONS, STATUS_PTEN_OPTIONS } from './qrisConstants';
import {
  filterRejected, buildRejectByMcc, buildRejectByStage, buildBottleneckInsights,
  groupBy, compareQueueRecords, aggregateMetrics, fmtNum,
} from './qrisHelpers';

const EMPTY_FILTERS = { rejectCategory: '', mcc: '', stage: '', status: '' };

/**
 * Tab 6 — Reject Analysis: menganalisis penyebab QRIS tidak cepat terbit.
 * Berbasis records yang sudah melewati filter global.
 */
export default function QrisRejectBottleneckTab({ records, onSelectRow, onAction }) {
  const rejectedRecords = useMemo(() => filterRejected(records), [records]);
  const metrics = useMemo(() => aggregateMetrics(records), [records]);

  const [f, setF] = useState(EMPTY_FILTERS);
  const setFilter = (key, value) => setF(prev => ({ ...prev, [key]: value }));
  const resetFilters = () => setF(EMPTY_FILTERS);

  const rejectCategoryOptions = useMemo(() => {
    const set = new Set();
    for (const r of rejectedRecords) if (r.rejectCategory) set.add(r.rejectCategory);
    return [...set];
  }, [rejectedRecords]);
  const mccOptions = useMemo(() => {
    const set = new Set();
    for (const r of rejectedRecords) if (r.mcc) set.add(r.mcc);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rejectedRecords]);

  const filtered = useMemo(() => {
    let rows = rejectedRecords;
    if (f.rejectCategory) rows = rows.filter(r => r.rejectCategory === f.rejectCategory);
    if (f.mcc)             rows = rows.filter(r => r.mcc === f.mcc);
    if (f.stage)           rows = rows.filter(r => r.currentStage === f.stage);
    if (f.status)          rows = rows.filter(r => r.statusVerifikasiOP === f.status || r.statusPTEN === f.status);
    return [...rows].sort(compareQueueRecords);
  }, [rejectedRecords, f]);

  const isFiltered = Object.values(f).some(v => v !== '');

  const rejectReasonDist = useMemo(() => groupBy(rejectedRecords.filter(r => r.rejectCategory), r => r.rejectCategory, { topN: 10 }), [rejectedRecords]);
  const rejectByMcc       = useMemo(() => buildRejectByMcc(records), [records]);
  const rejectByStage     = useMemo(() => buildRejectByStage(records), [records]);
  const insights          = useMemo(() => buildBottleneckInsights(records), [records]);

  return (
    <div>
      <div className="wr-summary-grid">
        <KPICard label="Total Reject / Perbaikan Data" value={fmtNum(rejectedRecords.length)} color={RED} />
        <KPICard label="Merchant Backlog" value={fmtNum(metrics.totalMerchantBacklog)} color={BLUE} />
        <KPICard label="Internal Backlog" value={fmtNum(metrics.totalInternalBacklog)} color={PURPLE} />
      </div>

      <div style={{ marginTop: 12 }}>
        <InsightBanner insights={insights} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginTop: 12 }}>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Top Reject Reason / Reject Category Distribution</div>
          <ChartOrEmpty entries={rejectReasonDist} emptyText="Belum ada reject dengan kategori jelas">
            <div style={{ position: 'relative', height: 220 }}>
              <DonutChart id="qris-reject-category" data={rejectReasonDist} colors={CHART_COLORS} />
            </div>
          </ChartOrEmpty>
        </div>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Reject by MCC</div>
          <ChartOrEmpty entries={rejectByMcc}>
            <div style={{ position: 'relative', height: Math.max(220, rejectByMcc.length * 22) }}>
              <HBarChart id="qris-reject-mcc" data={rejectByMcc} color={PURPLE} />
            </div>
          </ChartOrEmpty>
        </div>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Reject by Current Stage</div>
          <ChartOrEmpty entries={rejectByStage}>
            <div style={{ position: 'relative', height: Math.max(180, rejectByStage.length * 26) }}>
              <HBarChart id="qris-reject-stage" data={rejectByStage} color={RED} />
            </div>
          </ChartOrEmpty>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <QrisFilterBar
          fields={[
            { key: 'rejectCategory', type: 'select', label: 'Semua Reject Category', options: rejectCategoryOptions },
            { key: 'mcc',            type: 'select', label: 'Semua MCC', options: mccOptions },
            { key: 'stage',          type: 'select', label: 'Semua Stage', options: ALL_STAGES },
            { key: 'status',         type: 'select', label: 'Semua Status OP/PTEN', options: [...new Set([...STATUS_OP_OPTIONS, ...STATUS_PTEN_OPTIONS])] },
          ]}
          values={f}
          onChange={setFilter}
          onReset={resetFilters}
          isFiltered={isFiltered}
          resultCount={filtered.length}
        />
      </div>

      <div className="wri-chart-title" style={{ fontSize: 15, margin: '8px 0' }}>Outlet Rejected / Perbaikan Data</div>
      <QrisWorkQueueTable records={filtered} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada outlet reject/perbaikan data untuk filter ini." />
    </div>
  );
}
