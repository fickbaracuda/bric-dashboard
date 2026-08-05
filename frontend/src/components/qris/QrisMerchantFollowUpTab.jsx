import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { KPICard } from './QrisSharedUI';
import { BLUE, RED, AMBER, PURPLE, FOLLOWUP_TYPE_OPTIONS, AGING_BUCKETS } from './qrisConstants';
import { filterMerchantBacklog, matchesFollowupType, matchesAgingBucket, groupBy, compareQueueRecords, fmtNum } from './qrisHelpers';

const EMPTY_FILTERS = { followupType: '', rejectCategory: '', agingBucket: '', mcc: '' };
const AGING_BUCKET_LABELS = AGING_BUCKETS.map(b => b.label);

/**
 * Tab 4 — Merchant Follow-Up: outlet yang butuh tindakan MERCHANT
 * (isMerchantBacklog === true, field yang sudah dihitung backend).
 */
export default function QrisMerchantFollowUpTab({ records, onSelectRow, onAction }) {
  const merchantRecords = useMemo(() => filterMerchantBacklog(records), [records]);

  const [f, setF] = useState(EMPTY_FILTERS);
  const setFilter = (key, value) => setF(prev => ({ ...prev, [key]: value }));
  const resetFilters = () => setF(EMPTY_FILTERS);

  const rejectCategoryOptions = useMemo(() => {
    const set = new Set();
    for (const r of merchantRecords) if (r.rejectCategory) set.add(r.rejectCategory);
    return [...set];
  }, [merchantRecords]);
  const mccOptions = useMemo(() => {
    const set = new Set();
    for (const r of merchantRecords) if (r.mcc) set.add(r.mcc);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [merchantRecords]);

  const filtered = useMemo(() => {
    let rows = merchantRecords;
    if (f.followupType)   rows = rows.filter(r => matchesFollowupType(r, f.followupType));
    if (f.rejectCategory) rows = rows.filter(r => r.rejectCategory === f.rejectCategory);
    if (f.agingBucket)    rows = rows.filter(r => matchesAgingBucket(r, f.agingBucket));
    if (f.mcc)            rows = rows.filter(r => r.mcc === f.mcc);
    return [...rows].sort(compareQueueRecords);
  }, [merchantRecords, f]);

  const isFiltered = Object.values(f).some(v => v !== '');

  // Summary — turunan trivial dari merchantRecords, bukan rule baru.
  const topReason = useMemo(() => {
    const dist = groupBy(merchantRecords, r => r.rejectCategory || r.currentStage);
    return dist[0] || null;
  }, [merchantRecords]);
  const backlogOver24h = useMemo(() => merchantRecords.filter(r => (r.agingMinutes ?? 0) > 1440).length, [merchantRecords]);
  const followupP1     = useMemo(() => merchantRecords.filter(r => r.priorityLevel === 'P1').length, [merchantRecords]);

  return (
    <div>
      <div className="wr-summary-grid">
        <KPICard label="Total Merchant Backlog" value={fmtNum(merchantRecords.length)} color={BLUE} />
        <KPICard label="Top Reason Follow-Up" value={topReason ? topReason.label : '—'} color={AMBER} sub={topReason ? `${fmtNum(topReason.count)} outlet` : ''} />
        <KPICard label="Backlog > 24 Jam" value={fmtNum(backlogOver24h)} color={RED} />
        <KPICard label="Follow-up Priority P1" value={fmtNum(followupP1)} color={PURPLE} />
      </div>

      <div style={{ marginTop: 12 }}>
        <QrisFilterBar
          fields={[
            { key: 'followupType',   type: 'select', label: 'Semua Follow-up Type', options: FOLLOWUP_TYPE_OPTIONS },
            { key: 'rejectCategory', type: 'select', label: 'Semua Reject Category', options: rejectCategoryOptions },
            { key: 'agingBucket',    type: 'select', label: 'Semua Aging Bucket', options: AGING_BUCKET_LABELS },
            { key: 'mcc',            type: 'select', label: 'Semua MCC', options: mccOptions },
          ]}
          values={f}
          onChange={setFilter}
          onReset={resetFilters}
          isFiltered={isFiltered}
          resultCount={filtered.length}
        />
      </div>

      <QrisWorkQueueTable records={filtered} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada outlet merchant backlog untuk filter ini." />
    </div>
  );
}
