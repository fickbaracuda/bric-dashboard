import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisPriorityBadge from './QrisPriorityBadge';
import QrisSlaBadge from './QrisSlaBadge';
import QrisStatusBadge from './QrisStatusBadge';
import { ALL_STAGES, STATUS_OP_OPTIONS, STATUS_PTEN_OPTIONS, COMPLETENESS_OPTIONS } from './qrisConstants';
import { matchesCompleteness, exportQrisCsv, fmtDateTime, fmtAging, fmtNum } from './qrisHelpers';

const EMPTY_FILTERS = { stage: '', statusOp: '', statusPten: '', completeness: '' };

/**
 * Tab 7 — Raw Data & Audit: tabel unified merchant object LENGKAP untuk
 * audit/debugging (kolom lebih banyak dari QrisWorkQueueTable), plus export
 * CSV (pola persis exportCSV() di WarRoomSpeedcash.jsx).
 * Search sudah ditangani filter global di halaman utama.
 */
export default function QrisRawAuditTab({ records, onSelectRow }) {
  const [f, setF] = useState(EMPTY_FILTERS);
  const [visibleCount, setVisibleCount] = useState(150);
  const setFilter = (key, value) => { setF(prev => ({ ...prev, [key]: value })); setVisibleCount(150); };
  const resetFilters = () => { setF(EMPTY_FILTERS); setVisibleCount(150); };

  const filtered = useMemo(() => {
    let rows = records;
    if (f.stage)        rows = rows.filter(r => r.currentStage === f.stage);
    if (f.statusOp)     rows = rows.filter(r => (r.statusVerifikasiOP || 'UNKNOWN') === f.statusOp);
    if (f.statusPten)   rows = rows.filter(r => (r.statusPTEN || 'UNKNOWN') === f.statusPten);
    if (f.completeness) rows = rows.filter(r => matchesCompleteness(r, f.completeness));
    return rows;
  }, [records, f]);

  const isFiltered = Object.values(f).some(v => v !== '');
  const visible = filtered.slice(0, visibleCount);

  return (
    <div>
      <QrisFilterBar
        fields={[
          { key: 'stage',        type: 'select', label: 'Semua Stage', options: ALL_STAGES },
          { key: 'statusOp',     type: 'select', label: 'Semua Status OP', options: STATUS_OP_OPTIONS },
          { key: 'statusPten',   type: 'select', label: 'Semua Status PTEN', options: STATUS_PTEN_OPTIONS },
          { key: 'completeness', type: 'select', label: 'Semua Data Completeness', options: COMPLETENESS_OPTIONS },
        ]}
        values={f}
        onChange={setFilter}
        onReset={resetFilters}
        isFiltered={isFiltered}
        resultCount={filtered.length}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0' }}>
        <button
          className="wr-btn-update"
          onClick={() => exportQrisCsv(filtered, `qris-raw-data-${new Date().toISOString().slice(0, 10)}.csv`)}
          disabled={!filtered.length}
        >
          <i className="ti ti-download" /> Export CSV ({fmtNum(filtered.length)} baris)
        </button>
      </div>

      <div className="wr-table-wrap">
        <table className="wr-table wrqris-table">
          <thead>
            <tr>
              <th>ID Outlet</th><th>Nama Outlet</th><th>MCC</th>
              <th>Tgl Registrasi</th><th>Tgl Aktivasi</th><th>Tgl KYC</th><th>Tgl Submit Foto</th>
              <th>Tgl Verifikasi OP</th><th>Status OP</th>
              <th>Reason Reject KYC</th><th>Reason Reject PTEN</th>
              <th>Tgl Submit PTEN</th><th>Status PTEN</th>
              <th>Current Stage</th><th>Stage Owner</th><th>Aging</th><th>SLA</th>
              <th>Priority</th><th>Priority Score</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.idOutlet} className="wr-tr-clickable" onClick={() => onSelectRow(r)}>
                <td style={{ fontWeight: 600 }}>{r.idOutlet}</td>
                <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.namaOutlet}>{r.namaOutlet || '—'}</td>
                <td style={{ fontSize: 11 }} title={r.mcc}>{r.mcc || '—'}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalRegistrasi)}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalAktivasi)}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalKYC)}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalSubmitFoto)}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalVerifikasiOP)}</td>
                <td style={{ fontSize: 11 }}>{r.statusVerifikasiOP || '—'}</td>
                <td style={{ fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.reasonRejectDataKYC}>{r.reasonRejectDataKYC || '—'}</td>
                <td style={{ fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.reasonRejectDataPTEN}>{r.reasonRejectDataPTEN || '—'}</td>
                <td style={{ fontSize: 11 }}>{fmtDateTime(r.tanggalSubmitPTEN)}</td>
                <td style={{ fontSize: 11 }}>{r.statusPTEN || '—'}</td>
                <td style={{ fontSize: 11 }}>{r.currentStage}</td>
                <td><QrisStatusBadge owner={r.stageOwner} /></td>
                <td style={{ fontSize: 11 }}>{fmtAging(r.agingMinutes)}</td>
                <td><QrisSlaBadge status={r.slaStatus} /></td>
                <td><QrisPriorityBadge level={r.priorityLevel} /></td>
                <td style={{ fontSize: 11 }}>{r.priorityScore}</td>
              </tr>
            ))}
            {!visible.length && (
              <tr><td colSpan={19} style={{ textAlign: 'center', padding: 24, color: 'var(--text-4)' }}>Tidak ada data untuk filter ini.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > visibleCount && (
        <div style={{ textAlign: 'center', padding: 12 }}>
          <button className="wr-btn-retry" onClick={() => setVisibleCount(v => v + 150)}>
            Tampilkan lagi ({visibleCount} / {fmtNum(filtered.length)})
          </button>
        </div>
      )}
    </div>
  );
}
