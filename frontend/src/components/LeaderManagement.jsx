import { useState, useEffect } from 'react';
import {
  getMembers, createMember, updateMember, deleteMember,
  addMemberTarget, deleteMemberTarget, updatePencapaian
} from '../services/api';

const WARNA_OPTIONS = [
  '#7F77DD','#1D9E75','#EF4444','#F59E0B','#378ADD',
  '#D85A30','#6D28D9','#0891B2','#059669','#DC2626',
];

function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2
    ? (w[0][0] + w[1][0]).toUpperCase()
    : nama.substring(0, 2).toUpperCase();
}

function getAvgPct(member) {
  const valid = (member.targets || []).filter(t =>
    t.pencapaian_terakhir?.pct_revenue > 0
  );
  if (!valid.length) return null;
  return valid.reduce((s, t) =>
    s + parseFloat(t.pencapaian_terakhir.pct_revenue), 0) / valid.length;
}

function StatusBadge({ avg }) {
  if (avg === null) return <span className="lm-badge lm-badge-grey">Belum ada data</span>;
  if (avg >= 100)   return <span className="lm-badge lm-badge-green">{avg.toFixed(1)}%</span>;
  if (avg >= 80)    return <span className="lm-badge lm-badge-amber">{avg.toFixed(1)}%</span>;
  return <span className="lm-badge lm-badge-red">{avg.toFixed(1)}%</span>;
}

/* ─────── Modals ─────── */
function ModalMember({ initial, onSave, onClose }) {
  const [form, setForm] = useState({
    nama: '', posisi: 'tim', fungsi: '',
    avatar_warna: '#7F77DD', unit: 'winme_instaqris',
    ...initial,
  });
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState('');

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSave() {
    if (!form.nama.trim()) { setErr('Nama wajib diisi.'); return; }
    setBusy(true); setErr('');
    try { await onSave(form); onClose(); }
    catch (e) { setErr(e.response?.data?.error || 'Gagal menyimpan.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="lm-overlay" onClick={onClose}>
      <div className="lm-modal" onClick={e => e.stopPropagation()}>
        <div className="lm-modal-header">
          <span>{initial?.id ? 'Edit Anggota' : 'Tambah Anggota'}</span>
          <button className="lm-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="lm-modal-body">
          {err && <div className="lm-err">{err}</div>}

          <div className="lm-field">
            <label>Nama</label>
            <input className="lm-input" value={form.nama} onChange={set('nama')}
              placeholder="Nama lengkap" />
          </div>
          <div className="lm-field">
            <label>Posisi</label>
            <select className="lm-input" value={form.posisi} onChange={set('posisi')}>
              <option value="leader">Leader</option>
              <option value="tim">Tim</option>
            </select>
          </div>
          <div className="lm-field">
            <label>Fungsi / Jabatan</label>
            <input className="lm-input" value={form.fungsi} onChange={set('fungsi')}
              placeholder="cth: Account Manager, Sales, dll." />
          </div>
          <div className="lm-field">
            <label>Warna Avatar</label>
            <div className="lm-color-grid">
              {WARNA_OPTIONS.map(c => (
                <div
                  key={c}
                  className={'lm-color-box' + (form.avatar_warna === c ? ' lm-color-selected' : '')}
                  style={{ background: c }}
                  onClick={() => setForm(f => ({ ...f, avatar_warna: c }))}
                />
              ))}
              <input
                type="color" className="lm-color-picker"
                value={form.avatar_warna}
                onChange={e => setForm(f => ({ ...f, avatar_warna: e.target.value }))}
                title="Pilih warna custom"
              />
            </div>
            <div className="lm-color-preview">
              <div className="lm-avatar-md" style={{ background: form.avatar_warna }}>
                {form.nama ? getInisial(form.nama) : 'AB'}
              </div>
              <span style={{ fontSize: 12, color: '#6B7280' }}>Preview avatar</span>
            </div>
          </div>
        </div>
        <div className="lm-modal-footer">
          <button className="lm-btn-ghost" onClick={onClose}>Batal</button>
          <button className="lm-btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Menyimpan...' : 'Simpan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalTarget({ memberId, onSave, onClose }) {
  const [form, setForm] = useState({
    nama_target: '', key_result: '',
    target_revenue: '', periode: 'JUN_2026',
  });
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState('');
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSave() {
    if (!form.nama_target.trim()) { setErr('Nama target wajib diisi.'); return; }
    setBusy(true); setErr('');
    try {
      await onSave(memberId, {
        ...form,
        target_revenue: parseFloat(form.target_revenue) || 0,
      });
      onClose();
    } catch (e) { setErr(e.response?.data?.error || 'Gagal menyimpan.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="lm-overlay" onClick={onClose}>
      <div className="lm-modal" onClick={e => e.stopPropagation()}>
        <div className="lm-modal-header">
          <span>Tambah Target</span>
          <button className="lm-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="lm-modal-body">
          {err && <div className="lm-err">{err}</div>}
          <div className="lm-field">
            <label>Nama Target</label>
            <input className="lm-input" value={form.nama_target} onChange={set('nama_target')}
              placeholder="cth: Revenue Winme, Aktivasi Nasabah" />
          </div>
          <div className="lm-field">
            <label>Key Result / KPI</label>
            <input className="lm-input" value={form.key_result} onChange={set('key_result')}
              placeholder="cth: Fee base transaksi, jumlah nasabah aktif" />
          </div>
          <div className="lm-field">
            <label>Target Revenue (Rp)</label>
            <input className="lm-input" type="number" value={form.target_revenue}
              onChange={set('target_revenue')} placeholder="0" />
          </div>
          <div className="lm-field">
            <label>Periode</label>
            <select className="lm-input" value={form.periode} onChange={set('periode')}>
              {['JAN_2026','FEB_2026','MAR_2026','APR_2026','MEI_2026','JUN_2026',
                'JUL_2026','AGU_2026','SEP_2026','OKT_2026','NOV_2026','DES_2026'
              ].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="lm-modal-footer">
          <button className="lm-btn-ghost" onClick={onClose}>Batal</button>
          <button className="lm-btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Menyimpan...' : 'Tambah Target'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalPencapaian({ target, onSave, onClose }) {
  const today = new Date().toISOString().split('T')[0];
  const [form, setForm] = useState({
    pencapaian_kr: '',
    pencapaian_revenue: '',
    catatan: '',
    tanggal: today,
  });
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState('');
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const revAmt   = parseFloat(form.pencapaian_revenue) || 0;
  const targetRv = parseFloat(target.target_revenue) || 0;
  const pctPreview = targetRv > 0 ? ((revAmt / targetRv) * 100).toFixed(1) : null;

  async function handleSave() {
    setBusy(true); setErr('');
    try {
      await onSave(target.id, {
        pencapaian_kr: form.pencapaian_kr || null,
        pencapaian_revenue: revAmt,
        pct_kr: 0,
        pct_revenue: 0,
        catatan: form.catatan || null,
        tanggal: form.tanggal,
        member_id: target.member_id,
      });
      onClose();
    } catch (e) { setErr(e.response?.data?.error || 'Gagal menyimpan.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="lm-overlay" onClick={onClose}>
      <div className="lm-modal" onClick={e => e.stopPropagation()}>
        <div className="lm-modal-header">
          <span>Input Pencapaian</span>
          <button className="lm-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="lm-modal-body">
          {err && <div className="lm-err">{err}</div>}
          <div className="lm-target-info">
            <div className="lm-target-info-name">{target.nama_target}</div>
            <div className="lm-target-info-sub">
              Target: {fmtRev(targetRv)} &bull; {target.key_result || '—'}
            </div>
          </div>
          <div className="lm-field">
            <label>Tanggal</label>
            <input className="lm-input" type="date" value={form.tanggal} onChange={set('tanggal')} />
          </div>
          <div className="lm-field">
            <label>Pencapaian Revenue (Rp)</label>
            <input className="lm-input" type="number" value={form.pencapaian_revenue}
              onChange={set('pencapaian_revenue')} placeholder="0" />
            {pctPreview !== null && (
              <div className="lm-pct-preview">{pctPreview}% dari target</div>
            )}
          </div>
          <div className="lm-field">
            <label>Pencapaian KR</label>
            <input className="lm-input" value={form.pencapaian_kr} onChange={set('pencapaian_kr')}
              placeholder="cth: 125 transaksi" />
          </div>
          <div className="lm-field">
            <label>Catatan</label>
            <textarea className="lm-input lm-textarea" value={form.catatan}
              onChange={set('catatan')} placeholder="Catatan opsional..." />
          </div>
        </div>
        <div className="lm-modal-footer">
          <button className="lm-btn-ghost" onClick={onClose}>Batal</button>
          <button className="lm-btn-primary" onClick={handleSave} disabled={busy}>
            {busy ? 'Menyimpan...' : 'Simpan Pencapaian'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────── MemberCard ─────── */
function MemberCard({ member, onEdit, onDelete, onAddTarget, onDeleteTarget, onInputPencapaian, onViewDetail }) {
  const [expanded, setExpanded] = useState(false);
  const avg = getAvgPct(member);

  return (
    <div className="lm-member-card">
      <div className="lm-member-header">
        <div className="lm-avatar" style={{ background: member.avatar_warna }}>
          {getInisial(member.nama)}
        </div>
        <div className="lm-member-info">
          <div className="lm-member-name">{member.nama}</div>
          <div className="lm-member-meta">
            <span className={'lm-posisi-badge lm-posisi-' + member.posisi}>{member.posisi}</span>
            {member.fungsi && <span className="lm-fungsi">{member.fungsi}</span>}
          </div>
        </div>
        <div className="lm-member-right">
          <StatusBadge avg={avg} />
        </div>
      </div>

      <div className="lm-member-actions">
        <button className="lm-action-btn" onClick={() => onViewDetail(member.id)}
          title="Lihat Detail">
          <i className="ti ti-chart-bar" /> Detail
        </button>
        <button className="lm-action-btn" onClick={() => onEdit(member)}
          title="Edit">
          <i className="ti ti-pencil" /> Edit
        </button>
        <button className="lm-action-btn" onClick={() => onAddTarget(member)}
          title="Tambah Target">
          <i className="ti ti-target" /> Target
        </button>
        <button className="lm-action-btn" onClick={() => setExpanded(x => !x)}
          title="Lihat Targets">
          <i className={'ti ' + (expanded ? 'ti-chevron-up' : 'ti-chevron-down')} />
          {(member.targets || []).length} target
        </button>
        <button className="lm-action-btn lm-action-danger" onClick={() => onDelete(member)}
          title="Hapus">
          <i className="ti ti-trash" />
        </button>
      </div>

      {expanded && (
        <div className="lm-targets-list">
          {(member.targets || []).length === 0 ? (
            <div className="lm-empty-targets">Belum ada target. Klik "Target" untuk menambah.</div>
          ) : (
            member.targets.map(t => {
              const p = t.pencapaian_terakhir;
              const pct = p?.pct_revenue ? parseFloat(p.pct_revenue) : null;
              return (
                <div key={t.id} className="lm-target-item">
                  <div className="lm-target-top">
                    <div className="lm-target-name">{t.nama_target}</div>
                    <div className="lm-target-actions">
                      <button className="lm-action-sm lm-action-sm-primary"
                        onClick={() => onInputPencapaian(t)}>
                        <i className="ti ti-plus" /> Input
                      </button>
                      <button className="lm-action-sm lm-action-sm-danger"
                        onClick={() => onDeleteTarget(t.id, member.id)}>
                        <i className="ti ti-trash" />
                      </button>
                    </div>
                  </div>
                  <div className="lm-target-meta">
                    {t.key_result && <span>{t.key_result}</span>}
                    <span>Target: {fmtRev(t.target_revenue)}</span>
                    {p && (
                      <span>
                        Terakhir: {fmtRev(p.pencapaian_revenue)}
                        {pct !== null && (
                          <strong style={{ color: pct >= 100 ? '#1D9E75' : pct >= 80 ? '#F59E0B' : '#EF4444' }}>
                            {' '}({pct.toFixed(1)}%)
                          </strong>
                        )}
                      </span>
                    )}
                  </div>
                  {pct !== null && (
                    <div className="lm-progress-bar">
                      <div
                        className="lm-progress-fill"
                        style={{
                          width: Math.min(pct, 100) + '%',
                          background: pct >= 100 ? '#1D9E75' : pct >= 80 ? '#F59E0B' : '#EF4444',
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ─────── Main export ─────── */
export default function LeaderManagement({ navigate }) {
  const [members,  setMembers]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [toast,    setToast]    = useState('');
  const [modal,    setModal]    = useState(null);

  async function load() {
    setLoading(true);
    try { setMembers(await getMembers('winme_instaqris')); }
    catch { setMembers([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  async function handleSaveMember(form) {
    if (form.id) await updateMember(form.id, form);
    else         await createMember(form);
    await load();
    window.dispatchEvent(new Event('membersUpdated'));
    showToast(form.id ? 'Anggota berhasil diperbarui.' : 'Anggota baru berhasil ditambahkan.');
  }

  async function handleDeleteMember(member) {
    if (!window.confirm(`Hapus anggota "${member.nama}"? Data tidak akan hilang, hanya dinonaktifkan.`)) return;
    await deleteMember(member.id);
    await load();
    window.dispatchEvent(new Event('membersUpdated'));
    showToast('Anggota berhasil dihapus.');
  }

  async function handleAddTarget(member, data) {
    await addMemberTarget(member.id, data);
    await load();
    showToast('Target berhasil ditambahkan.');
  }

  async function handleDeleteTarget(targetId) {
    if (!window.confirm('Hapus target ini beserta semua data pencapaiannya?')) return;
    await deleteMemberTarget(targetId);
    await load();
    showToast('Target berhasil dihapus.');
  }

  async function handleInputPencapaian(targetId, data) {
    await updatePencapaian(targetId, data);
    await load();
    showToast('Pencapaian berhasil disimpan.');
  }

  const leaders = members.filter(m => m.posisi === 'leader');
  const tim     = members.filter(m => m.posisi === 'tim');

  return (
    <div className="lm-wrap">
      <div className="lm-toolbar">
        <div>
          <div className="lm-toolbar-title">Leader &amp; Tim Winme / InstaQris</div>
          <div className="lm-toolbar-sub">{members.length} anggota aktif</div>
        </div>
        <button
          className="lm-btn-primary"
          onClick={() => setModal({ type: 'member', data: null })}
        >
          <i className="ti ti-plus" /> Tambah Anggota
        </button>
      </div>

      {loading ? (
        <div className="lm-loading">Memuat data...</div>
      ) : members.length === 0 ? (
        <div className="lm-empty">
          <i className="ti ti-users" style={{ fontSize: 32, color: '#D1D5DB' }} />
          <div>Belum ada anggota terdaftar.</div>
          <button className="lm-btn-primary"
            onClick={() => setModal({ type: 'member', data: null })}>
            Tambah Anggota Pertama
          </button>
        </div>
      ) : (
        <>
          {leaders.length > 0 && (
            <section>
              <div className="lm-section-label">
                <i className="ti ti-crown" /> LEADER ({leaders.length})
              </div>
              <div className="lm-card-grid">
                {leaders.map(m => (
                  <MemberCard
                    key={m.id} member={m}
                    onEdit={data => setModal({ type: 'member', data })}
                    onDelete={handleDeleteMember}
                    onAddTarget={data => setModal({ type: 'target', data })}
                    onDeleteTarget={(tid) => handleDeleteTarget(tid)}
                    onInputPencapaian={t => setModal({ type: 'pencapaian', data: t })}
                    onViewDetail={id => navigate(`/anggota/${id}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {tim.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <div className="lm-section-label">
                <i className="ti ti-users" /> TIM ({tim.length})
              </div>
              <div className="lm-card-grid">
                {tim.map(m => (
                  <MemberCard
                    key={m.id} member={m}
                    onEdit={data => setModal({ type: 'member', data })}
                    onDelete={handleDeleteMember}
                    onAddTarget={data => setModal({ type: 'target', data })}
                    onDeleteTarget={(tid) => handleDeleteTarget(tid)}
                    onInputPencapaian={t => setModal({ type: 'pencapaian', data: t })}
                    onViewDetail={id => navigate(`/anggota/${id}`)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {modal?.type === 'member' && (
        <ModalMember
          initial={modal.data || {}}
          onSave={handleSaveMember}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'target' && (
        <ModalTarget
          memberId={modal.data?.id}
          onSave={(id, d) => handleAddTarget(modal.data, d)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'pencapaian' && (
        <ModalPencapaian
          target={modal.data}
          onSave={handleInputPencapaian}
          onClose={() => setModal(null)}
        />
      )}

      {toast && <div className="toast-success">{toast}</div>}
    </div>
  );
}
