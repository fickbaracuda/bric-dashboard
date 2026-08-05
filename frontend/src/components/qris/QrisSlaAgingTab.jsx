import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { AgingBucketChart, HBarChart, ChartOrEmpty } from './QrisSharedUI';
import { ALL_STAGES, OWNER_OPTIONS, SLA_STATUS_OPTIONS, ACCENT, PURPLE, AGING_BUCKETS } from './qrisConstants';
import { buildAgingBuckets, buildSlaBreachByStage, buildSlaBreachByOwner, getStuckTooLong, matchesAgingBucket, fmtAging, fmtNum } from './qrisHelpers';

const EMPTY_FILTERS = { slaStatus: '', agingBucket: '', owner: '', stage: '' };
const AGING_BUCKET_LABELS = AGING_BUCKETS.map(b => b.label);

/**
 * Tab 3 — SLA & Aging Control: mengontrol outlet yang terlalu lama tidak
 * bergerak. Semua data turunan dari field `slaStatus`/`agingMinutes` yang
 * SUDAH dihitung backend — tab ini cuma filter & agregasi ulang.
 */
export default function QrisSlaAgingTab({ records, onSelectRow, onAction }) {
  const [f, setF] = useState(EMPTY_FILTERS);
  const setFilter = (key, value) => setF(prev => ({ ...prev, [key]: value }));
  const resetFilters = () => setF(EMPTY_FILTERS);

  const filtered = useMemo(() => {
    let rows = records;
    if (f.slaStatus)    rows = rows.filter(r => r.slaStatus === f.slaStatus);
    if (f.agingBucket)  rows = rows.filter(r => matchesAgingBucket(r, f.agingBucket));
    if (f.owner)        rows = rows.filter(r => r.stageOwner === f.owner);
    if (f.stage)        rows = rows.filter(r => r.currentStage === f.stage);
    return rows;
  }, [records, f]);

  const isFiltered = Object.values(f).some(v => v !== '');

  const agingChartData   = useMemo(() => buildAgingBuckets(filtered).map(b => ({ label: b.bucket, count: b.count })), [filtered]);
  const breachByStage    = useMemo(() => buildSlaBreachByStage(filtered), [filtered]);
  const breachByOwner    = useMemo(() => buildSlaBreachByOwner(filtered), [filtered]);
  const breachRecords    = useMemo(() => filtered.filter(r => r.slaStatus === 'Breach'), [filtered]);
  const stuckTooLong     = useMemo(() => getStuckTooLong(filtered, 50), [filtered]);

  return (
    <div>
      <QrisFilterBar
        fields={[
          { key: 'slaStatus',   type: 'select', label: 'Semua SLA', options: SLA_STATUS_OPTIONS },
          { key: 'agingBucket', type: 'select', label: 'Semua Aging Bucket', options: AGING_BUCKET_LABELS },
          { key: 'owner',       type: 'select', label: 'Semua Owner', options: OWNER_OPTIONS },
          { key: 'stage',       type: 'select', label: 'Semua Stage', options: ALL_STAGES },
        ]}
        values={f}
        onChange={setFilter}
        onReset={resetFilters}
        isFiltered={isFiltered}
        resultCount={filtered.length}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginTop: 12 }}>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Aging Distribution</div>
          <div style={{ position: 'relative', height: 220 }}>
            <AgingBucketChart id="qris-sla-aging" data={agingChartData} />
          </div>
        </div>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Over SLA per Current Stage</div>
          <ChartOrEmpty entries={breachByStage} emptyText="Tidak ada data yang melewati SLA.">
            <div style={{ position: 'relative', height: Math.max(180, breachByStage.length * 26) }}>
              <HBarChart id="qris-sla-by-stage" data={breachByStage} color={ACCENT} />
            </div>
          </ChartOrEmpty>
        </div>
        <div className="wri-chart-card">
          <div className="wri-chart-title">Over SLA per Owner</div>
          <ChartOrEmpty entries={breachByOwner} emptyText="Tidak ada data yang melewati SLA.">
            <div style={{ position: 'relative', height: 200 }}>
              <HBarChart id="qris-sla-by-owner" data={breachByOwner} color={PURPLE} />
            </div>
          </ChartOrEmpty>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="wri-chart-title" style={{ fontSize: 15, marginBottom: 8 }}>
          SLA Breach Table <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 12 }}>— {fmtNum(breachRecords.length)} outlet</span>
        </div>
        <QrisWorkQueueTable records={breachRecords} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada data yang melewati SLA." />
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="wri-chart-title" style={{ fontSize: 15, marginBottom: 8 }}>
          Stuck Too Long <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 12 }}>— diurutkan aging terlama, maks 50 outlet ({stuckTooLong[0] ? `terlama: ${fmtAging(stuckTooLong[0].agingMinutes)}` : '—'})</span>
        </div>
        <QrisWorkQueueTable records={stuckTooLong} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada outlet yang stuck." />
      </div>
    </div>
  );
}
