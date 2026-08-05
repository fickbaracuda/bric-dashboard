import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { ALL_STAGES, OWNER_OPTIONS, STATUS_OP_OPTIONS, STATUS_PTEN_OPTIONS, SLA_STATUS_OPTIONS } from './qrisConstants';
import { compareQueueRecords, getQueueEmptyMessage } from './qrisHelpers';

const EMPTY_FILTERS = { priority: 'semua', stage: '', owner: '', statusOp: '', statusPten: '', slaStatus: '', mcc: '' };

/**
 * Tab 2 — Smart Queue: antrian kerja utama, paling actionable. Ini adalah
 * SmartWorkQueue lama dari WarRoomQrisControlTower.jsx, cuma date range &
 * search sudah dipindah ke filter global (halaman utama) jadi tidak
 * diduplikasi di sini — 7 filter sisanya persis sama.
 */
export default function QrisSmartQueueTab({ records, onSelectRow, onAction }) {
  const [f, setF] = useState(EMPTY_FILTERS);
  const setFilter = (key, value) => setF(prev => ({ ...prev, [key]: value }));
  const resetFilters = () => setF(EMPTY_FILTERS);

  const mccOptions = useMemo(() => {
    const set = new Set();
    for (const r of records) if (r.mcc) set.add(r.mcc);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [records]);

  const filtered = useMemo(() => {
    let rows = records;
    if (f.priority !== 'semua') rows = rows.filter(r => r.priorityLevel === f.priority);
    if (f.stage)      rows = rows.filter(r => r.currentStage === f.stage);
    if (f.owner)      rows = rows.filter(r => r.stageOwner === f.owner);
    if (f.statusOp)   rows = rows.filter(r => (r.statusVerifikasiOP || 'UNKNOWN') === f.statusOp);
    if (f.statusPten) rows = rows.filter(r => (r.statusPTEN || 'UNKNOWN') === f.statusPten);
    if (f.slaStatus)  rows = rows.filter(r => r.slaStatus === f.slaStatus);
    if (f.mcc)        rows = rows.filter(r => r.mcc === f.mcc);
    // Sort default: priorityLevel asc (P0→P3) -> priorityScore desc -> agingMinutes desc
    return [...rows].sort(compareQueueRecords);
  }, [records, f]);

  const isFiltered = Object.entries(f).some(([k, v]) => (k === 'priority' ? v !== 'semua' : v !== ''));

  return (
    <div>
      <QrisFilterBar
        fields={[
          { key: 'stage',      type: 'select', label: 'Semua Stage', options: ALL_STAGES },
          { key: 'owner',      type: 'select', label: 'Semua Owner', options: OWNER_OPTIONS },
          { key: 'statusOp',   type: 'select', label: 'Semua Status OP', options: STATUS_OP_OPTIONS },
          { key: 'statusPten', type: 'select', label: 'Semua Status PTEN', options: STATUS_PTEN_OPTIONS },
          { key: 'slaStatus',  type: 'select', label: 'Semua SLA', options: SLA_STATUS_OPTIONS },
          { key: 'mcc',        type: 'select', label: 'Semua MCC', options: mccOptions },
          { key: 'priority',   type: 'quicktabs', options: ['semua', 'P0', 'P1', 'P2', 'P3'] },
        ]}
        values={f}
        onChange={setFilter}
        onReset={resetFilters}
        isFiltered={isFiltered}
        resultCount={filtered.length}
      />

      <QrisWorkQueueTable records={filtered} onSelectRow={onSelectRow} onAction={onAction} emptyMessage={getQueueEmptyMessage(f)} />
    </div>
  );
}
