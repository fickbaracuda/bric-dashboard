import { useState } from 'react';
import QrisPriorityBadge from './QrisPriorityBadge';
import QrisSlaBadge from './QrisSlaBadge';
import QrisStatusBadge from './QrisStatusBadge';
import { QrisActionMenuButton } from './QrisActionButtons';
import { fmtNum, fmtAging } from './qrisHelpers';

/**
 * Tabel queue reusable — dipakai Smart Queue, SLA & Aging, Merchant
 * Follow-Up, Verifikasi & PTEN, Reject Analysis. Terima `records` yang
 * SUDAH difilter oleh tab pemanggil (component ini tidak filter apa pun
 * sendiri, cuma render + paginasi + trigger onSelectRow/onAction).
 */
export default function QrisWorkQueueTable({ records, onSelectRow, onAction, emptyMessage = 'Tidak ada outlet untuk filter ini', pageSize = 150 }) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const visible = records.slice(0, visibleCount);

  return (
    <div className="wr-table-wrap">
      <table className="wr-table wrqris-table">
        <thead>
          <tr>
            <th>Priority</th><th>ID Outlet</th><th>Nama Outlet</th><th>MCC</th>
            <th>Current Stage</th><th>Aging</th><th>SLA</th>
            <th>Status OP</th><th>Status PTEN</th><th>Owner</th>
            <th>Next Action</th><th>Reason Reject</th><th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(r => (
            <tr key={r.idOutlet} className="wr-tr-clickable" onClick={() => onSelectRow(r)}>
              <td><QrisPriorityBadge level={r.priorityLevel} /></td>
              <td style={{ fontWeight: 600 }}>{r.idOutlet}</td>
              <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.namaOutlet}>{r.namaOutlet || '—'}</td>
              <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.mcc}>{r.mcc || '—'}</td>
              <td>{r.currentStage}</td>
              <td>{fmtAging(r.agingMinutes)}</td>
              <td><QrisSlaBadge status={r.slaStatus} /></td>
              <td style={{ fontSize: 11 }}>{r.statusVerifikasiOP || '—'}</td>
              <td style={{ fontSize: 11 }}>{r.statusPTEN || '—'}</td>
              <td><QrisStatusBadge owner={r.stageOwner} /></td>
              <td style={{ fontSize: 11, maxWidth: 220 }}>{r.nextAction}</td>
              <td style={{ fontSize: 11, color: r.rejectCategory ? '#EF4444' : 'var(--text-4)' }}>{r.rejectCategory || '—'}</td>
              <td><QrisActionMenuButton record={r} onAction={onAction} /></td>
            </tr>
          ))}
          {!visible.length && (
            <tr><td colSpan={13} style={{ textAlign: 'center', padding: 24, color: 'var(--text-4)' }}>{emptyMessage}</td></tr>
          )}
        </tbody>
      </table>

      {records.length > visibleCount && (
        <div style={{ textAlign: 'center', padding: 12 }}>
          <button className="wr-btn-retry" onClick={() => setVisibleCount(v => v + pageSize)}>
            Tampilkan lagi ({visibleCount} / {fmtNum(records.length)})
          </button>
        </div>
      )}
    </div>
  );
}
