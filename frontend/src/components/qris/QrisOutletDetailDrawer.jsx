import QrisPriorityBadge from './QrisPriorityBadge';
import QrisSlaBadge from './QrisSlaBadge';
import QrisStatusBadge from './QrisStatusBadge';
import { QrisActionButtonRow } from './QrisActionButtons';
import { PRIORITY_LABEL, OWNER_LABEL, ACCENT } from './qrisConstants';
import { fmtDateTime, fmtAging } from './qrisHelpers';

// Dulu bernama DetailModal di WarRoomQrisControlTower.jsx — isi & logic
// sama persis, cuma dipindah + rename sesuai daftar komponen yang diminta.
export default function QrisOutletDetailDrawer({ record, onClose, onAction }) {
  if (!record) return null;
  const timeline = [
    { label: 'Registrasi',                tanggal: record.tanggalRegistrasi },
    { label: 'Aktivasi',                  tanggal: record.tanggalAktivasi },
    { label: 'Isi KYC/KYM',               tanggal: record.tanggalKYC },
    { label: 'Submit Foto Produk & Toko', tanggal: record.tanggalSubmitFoto },
    { label: 'Verifikasi OP',             tanggal: record.tanggalVerifikasiOP },
    { label: 'Submit PTEN',               tanggal: record.tanggalSubmitPTEN },
  ];

  return (
    <div className="wr-modal-overlay" onClick={onClose}>
      <div className="wr-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="wr-modal-header">
          <div>
            <div className="wr-modal-title">{record.namaOutlet || '(Tanpa nama)'}</div>
            <div className="wr-modal-sub">ID Outlet {record.idOutlet} · {record.mcc || '-'}</div>
          </div>
          <button className="wr-modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <QrisPriorityBadge level={record.priorityLevel} />
          <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 600 }}>{PRIORITY_LABEL[record.priorityLevel]}</span>
          <QrisSlaBadge status={record.slaStatus} />
          <QrisStatusBadge owner={record.stageOwner} />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{OWNER_LABEL[record.stageOwner]}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10 }}>Priority score: <strong>{record.priorityScore}</strong></div>

        <div style={{ background: 'var(--bg-page)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{record.currentStage}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{record.nextAction}</div>
          <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 4 }}>
            Aktivitas terakhir: {fmtDateTime(record.lastActivityTime)} · Aging: {fmtAging(record.agingMinutes)}
          </div>
        </div>

        <div className="wri-chart-title" style={{ marginBottom: 8 }}>Timeline Proses</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {timeline.map(t => (
            <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '6px 10px', background: t.tanggal ? '#F0FDF4' : 'var(--bg-page)', borderRadius: 6 }}>
              <span style={{ color: t.tanggal ? '#166534' : 'var(--text-4)' }}>{t.tanggal ? '✓' : '○'} {t.label}</span>
              <span style={{ color: 'var(--text-3)' }}>{fmtDateTime(t.tanggal)}</span>
            </div>
          ))}
        </div>

        <table className="wr-modal-table">
          <thead><tr><th></th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Status Verifikasi OP</td><td>{record.statusVerifikasiOP || '—'}</td></tr>
            <tr><td>Status PTEN</td><td>{record.statusPTEN || '—'}</td></tr>
          </tbody>
        </table>

        {(record.reasonRejectDataKYC || record.reasonRejectDataPTEN) && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#991B1B', marginBottom: 4 }}>
              ⚠ Alasan Reject{record.rejectCategory ? ` — ${record.rejectCategory}` : ''}
            </div>
            {record.reasonRejectDataKYC  && <div style={{ fontSize: 12, color: '#7F1D1D' }}>KYC: {record.reasonRejectDataKYC}</div>}
            {record.reasonRejectDataPTEN && <div style={{ fontSize: 12, color: '#7F1D1D' }}>PTEN: {record.reasonRejectDataPTEN}</div>}
          </div>
        )}

        <div className="wri-chart-title" style={{ marginTop: 14, marginBottom: 8 }}>Action Center</div>
        <QrisActionButtonRow record={record} onAction={onAction} accent={ACCENT} />
      </div>
    </div>
  );
}
