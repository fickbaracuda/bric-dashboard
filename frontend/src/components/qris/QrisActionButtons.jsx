import { useState, useEffect, useRef, useCallback } from 'react';
import { ACTIONS, RED, GREEN } from './qrisConstants';
import { getReminderTemplate, buildRejectReasonText, copyToClipboard } from './qrisHelpers';

/* ─ Toast — feedback Action Center, placeholder (belum terhubung backend) ─ */
export function useQrisToast() {
  const [toast, setToast] = useState(null);
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, showToast];
}

export function QrisToast({ toast }) {
  if (!toast) return null;
  const color = toast.type === 'error' ? RED : GREEN;
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 2000, maxWidth: 340,
      background: '#111827', color: '#fff', padding: '10px 14px', borderRadius: 8,
      fontSize: 13, boxShadow: '0 8px 24px rgba(0,0,0,.25)', display: 'flex', alignItems: 'flex-start', gap: 8,
      borderLeft: `4px solid ${color}`,
    }}>
      <i className={`ti ti-${toast.type === 'error' ? 'alert-circle' : 'circle-check'}`} style={{ color, marginTop: 1 }} />
      <span>{toast.message}</span>
    </div>
  );
}

/**
 * Factory handler Action Center — dipakai semua tab lewat 1 sumber yang
 * sama. Placeholder murni: console.log + toast, copy-to-clipboard untuk
 * reminder/reject reason. TIDAK ada panggilan backend baru di sini.
 */
export function createQrisActionHandler(showToast) {
  return async function handleQrisAction(actionId, record) {
    const action = ACTIONS.find(a => a.id === actionId);
    const label = action?.label || actionId;

    if (actionId === 'copy_reminder') {
      const text = getReminderTemplate(record);
      const ok = await copyToClipboard(text);
      showToast(ok ? `Template reminder (${record.idOutlet}) disalin ke clipboard` : 'Gagal menyalin ke clipboard', ok ? 'success' : 'error');
      console.log(`[QRIS] ${label}`, record.idOutlet, text);
      return;
    }
    if (actionId === 'copy_reject_reason') {
      const text = buildRejectReasonText(record);
      const ok = await copyToClipboard(text);
      showToast(ok ? `Alasan reject (${record.idOutlet}) disalin ke clipboard` : 'Gagal menyalin ke clipboard', ok ? 'success' : 'error');
      console.log(`[QRIS] ${label}`, record.idOutlet, text);
      return;
    }

    // Verify Now, Assign to Me, Mark Followed Up, Escalate PTEN, Recheck
    // Status, Done/Archive — belum ada backend, placeholder saja.
    console.log(`[QRIS] ${label}`, record.idOutlet, record);
    showToast(`"${label}" untuk ${record.idOutlet} dicatat (belum terhubung ke backend)`);
  };
}

/* ─ Dropdown menu per-row (dipakai di QrisWorkQueueTable) ─ */
export function QrisActionMenuButton({ record, onAction }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }} onClick={e => e.stopPropagation()}>
      <button className="wr-btn-retry" style={{ padding: '3px 9px', fontSize: 14, lineHeight: 1 }} onClick={() => setOpen(o => !o)} title="Aksi">
        ⋮
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,.15)', minWidth: 190, padding: 4,
        }}>
          {ACTIONS.map(a => (
            <button
              key={a.id}
              onClick={() => { onAction(a.id, record); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '7px 10px', fontSize: 12, background: 'none', border: 'none', borderRadius: 6,
                cursor: 'pointer', color: 'var(--text-1)', whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-page)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <i className={`ti ti-${a.icon}`} style={{ fontSize: 14, color: 'var(--text-3)', width: 16 }} />
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─ Baris tombol penuh (dipakai di QrisOutletDetailDrawer) ─ */
export function QrisActionButtonRow({ record, onAction, accent = '#0891B2' }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {ACTIONS.map(a => (
        <button
          key={a.id}
          onClick={() => onAction(a.id, record)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12,
            background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6,
            cursor: 'pointer', color: 'var(--text-1)',
          }}
        >
          <i className={`ti ti-${a.icon}`} style={{ fontSize: 13, color: accent }} />
          {a.label}
        </button>
      ))}
    </div>
  );
}
