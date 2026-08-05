import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { KPICard } from './QrisSharedUI';
import { PURPLE, AMBER, YELLOW, RED, STATUS_OP_OPTIONS, STATUS_PTEN_OPTIONS, SLA_STATUS_OPTIONS, INTERNAL_STAGE_OPTIONS, STAGE } from './qrisConstants';
import { filterInternalBacklog, matchesInternalStage, compareQueueRecords, fmtNum } from './qrisHelpers';

const EMPTY_FILTERS = { internalStage: '', slaStatus: '', statusOp: '', statusPten: '' };

/**
 * Tab 5 — Verifikasi & PTEN Control: outlet yang butuh tindakan Internal,
 * Verifikator, atau PTEN (isInternalBacklog === true, dari backend).
 */
export default function QrisVerificationPtenTab({ records, onSelectRow, onAction }) {
  const internalRecords = useMemo(() => filterInternalBacklog(records), [records]);

  const [f, setF] = useState(EMPTY_FILTERS);
  const setFilter = (key, value) => setF(prev => ({ ...prev, [key]: value }));
  const resetFilters = () => setF(EMPTY_FILTERS);

  const filtered = useMemo(() => {
    let rows = internalRecords;
    if (f.internalStage) rows = rows.filter(r => matchesInternalStage(r, f.internalStage));
    if (f.slaStatus)     rows = rows.filter(r => r.slaStatus === f.slaStatus);
    if (f.statusOp)      rows = rows.filter(r => (r.statusVerifikasiOP || 'UNKNOWN') === f.statusOp);
    if (f.statusPten)    rows = rows.filter(r => (r.statusPTEN || 'UNKNOWN') === f.statusPten);
    return [...rows].sort(compareQueueRecords);
  }, [internalRecords, f]);

  const isFiltered = Object.values(f).some(v => v !== '');

  // Mini KPI — turunan trivial dari internalRecords.
  const readyToVerify    = useMemo(() => internalRecords.filter(r => r.currentStage === STAGE.MENUNGGU_VERIFIKASI_OS).length, [internalRecords]);
  const readyToSubmitPten = useMemo(() => internalRecords.filter(r => r.currentStage === STAGE.SIAP_SUBMIT_PTEN).length, [internalRecords]);
  const pendingPten      = useMemo(() => internalRecords.filter(r => r.currentStage === STAGE.PENDING_PTEN).length, [internalRecords]);
  const internalOverSla  = useMemo(() => internalRecords.filter(r => r.slaStatus === 'Breach').length, [internalRecords]);

  return (
    <div>
      <div className="wr-summary-grid">
        <KPICard label="Ready to Verify"      value={fmtNum(readyToVerify)}     color={PURPLE} />
        <KPICard label="Ready to Submit PTEN" value={fmtNum(readyToSubmitPten)} color={AMBER} />
        <KPICard label="Pending PTEN"          value={fmtNum(pendingPten)}       color={YELLOW} />
        <KPICard label="Internal Over SLA"     value={fmtNum(internalOverSla)}   color={RED} />
      </div>

      <div style={{ marginTop: 12 }}>
        <QrisFilterBar
          fields={[
            { key: 'internalStage', type: 'select', label: 'Semua Internal Stage', options: INTERNAL_STAGE_OPTIONS },
            { key: 'slaStatus',     type: 'select', label: 'Semua SLA', options: SLA_STATUS_OPTIONS },
            { key: 'statusOp',      type: 'select', label: 'Semua Status OP', options: STATUS_OP_OPTIONS },
            { key: 'statusPten',    type: 'select', label: 'Semua Status PTEN', options: STATUS_PTEN_OPTIONS },
          ]}
          values={f}
          onChange={setFilter}
          onReset={resetFilters}
          isFiltered={isFiltered}
          resultCount={filtered.length}
        />
      </div>

      <QrisWorkQueueTable records={filtered} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada outlet internal/verifikator/PTEN backlog untuk filter ini." />
    </div>
  );
}
