import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import { getUsers, createUser, updateUser, deleteUser } from '../services/api';
import { getUser } from '../utils/auth';

const UNITS = [
  'Payment Agent', 'SpeedCash', 'Travel B2C', 'Pulsagram',
  'Winme', 'InstaQris', 'DOMPET DIGITAL SPEEDCASH',
  'WINME&INSTAQRIS', 'Semua Unit'
];

const ROLES = [
  { value: 'viewer', label: 'Viewer — Hanya bisa lihat' },
  { value: 'admin',  label: 'Admin — Bisa kelola user' }
];

const emptyForm = { username: '', password: '', full_name: '', unit: 'Semua Unit', role: 'viewer' };

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function UserForm({ initial, onSave, onCancel, loading, error, isEdit }) {
  const [form, setForm] = useState(initial || emptyForm);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="user-form">
      <div className="form-row">
        <div className="form-field">
          <label className="form-label">Nama Lengkap</label>
          <input className="form-input" value={form.full_name} onChange={e => set('full_name', e.target.value)} placeholder="Contoh: Budi Santoso" required />
        </div>
        <div className="form-field">
          <label className="form-label">Username</label>
          <input className="form-input" value={form.username} onChange={e => set('username', e.target.value)} placeholder="Contoh: budi.santoso" required disabled={isEdit} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-field">
          <label className="form-label">Unit</label>
          <select className="form-input" value={form.unit} onChange={e => set('unit', e.target.value)}>
            {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label className="form-label">Role</label>
          <select className="form-input" value={form.role} onChange={e => set('role', e.target.value)}>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </div>
      <div className="form-field">
        <label className="form-label">{isEdit ? 'Password Baru (kosongkan jika tidak diubah)' : 'Password'}</label>
        <input className="form-input" type="password" value={form.password} onChange={e => set('password', e.target.value)}
          placeholder={isEdit ? 'Kosongkan jika tidak ingin ubah password' : 'Minimal 6 karakter'}
          required={!isEdit} minLength={isEdit ? 0 : 6} />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>Batal</button>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Menyimpan...' : isEdit ? 'Simpan Perubahan' : 'Tambah User'}
        </button>
      </div>
    </form>
  );
}

export default function UserManagement() {
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [modal,   setModal]   = useState(null); // 'add' | 'edit' | 'delete'
  const [selected, setSelected] = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [formErr, setFormErr] = useState('');
  const [toast,   setToast]   = useState('');
  const currentUser = getUser();

  const load = () => {
    setLoading(true);
    getUsers()
      .then(d => { setUsers(d); setLoading(false); })
      .catch(e => { setError(e.response?.data?.error || e.message); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const handleAdd = async (form) => {
    setSaving(true); setFormErr('');
    try {
      await createUser(form);
      setModal(null);
      load();
      showToast(`User ${form.username} berhasil ditambahkan`);
    } catch (e) {
      setFormErr(e.response?.data?.error || 'Gagal menambahkan user');
    } finally { setSaving(false); }
  };

  const handleEdit = async (form) => {
    setSaving(true); setFormErr('');
    try {
      const payload = { ...form };
      if (!payload.password) delete payload.password;
      await updateUser(selected.id, payload);
      setModal(null);
      load();
      showToast('Data user berhasil diperbarui');
    } catch (e) {
      setFormErr(e.response?.data?.error || 'Gagal memperbarui user');
    } finally { setSaving(false); }
  };

  const handleToggleActive = async (user) => {
    try {
      await updateUser(user.id, { ...user, is_active: !user.is_active, password: undefined });
      load();
      showToast(user.is_active ? `${user.username} dinonaktifkan` : `${user.username} diaktifkan`);
    } catch (e) {
      alert(e.response?.data?.error || 'Gagal mengubah status');
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await deleteUser(selected.id);
      setModal(null);
      load();
      showToast(`User ${selected.username} dihapus`);
    } catch (e) {
      setFormErr(e.response?.data?.error || 'Gagal menghapus user');
    } finally { setSaving(false); }
  };

  if (currentUser?.role !== 'admin') {
    return (
      <Layout>
        <div className="empty-state">
          <div className="empty-icon">🔒</div>
          <div className="empty-title">Akses Ditolak</div>
          <div className="empty-sub">Hanya admin yang bisa mengakses halaman ini</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {toast && <div className="toast-success">✓ {toast}</div>}

      <div className="page-header">
        <div>
          <h1 className="page-title">Manajemen User</h1>
          <p className="page-sub">{users.length} user terdaftar</p>
        </div>
        <button className="btn-primary" onClick={() => { setModal('add'); setFormErr(''); }}>
          + Tambah User
        </button>
      </div>

      {error && <div className="alert-error">⚠ {error}</div>}

      {loading ? (
        <div className="skeleton-grid">{[...Array(4)].map((_,i) => <div key={i} className="skeleton-card" style={{height:60}} />)}</div>
      ) : (
        <div className="table-wrap">
          <table className="ranking-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Nama Lengkap</th>
                <th>Username</th>
                <th>Unit</th>
                <th>Role</th>
                <th>Status</th>
                <th>Terdaftar</th>
                <th>Login Terakhir</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={u.id} className="table-row">
                  <td style={{ color: 'var(--text-4)', fontSize: 12 }}>{i + 1}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="user-avatar-sm" style={{ background: u.role === 'admin' ? '#1D9E75' : '#6366F1' }}>
                        {u.full_name?.[0]?.toUpperCase() || u.username?.[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontWeight: 600 }}>{u.full_name || '—'}</span>
                    </div>
                  </td>
                  <td><code style={{ fontSize: 12, background: '#F3F4F6', padding: '2px 6px', borderRadius: 4 }}>{u.username}</code></td>
                  <td style={{ fontSize: 13 }}>{u.unit || '—'}</td>
                  <td>
                    <span className={`pill ${u.role === 'admin' ? 'pill-aman' : 'pill-waspada'}`} style={{ fontSize: 11 }}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${u.is_active ? 'pill-aman' : 'pill-kritis'}`} style={{ fontSize: 11 }}>
                      {u.is_active ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-4)' }}>{formatDate(u.created_at)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-4)' }}>{formatDate(u.last_login)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="action-btn action-btn--edit"
                        onClick={() => { setSelected(u); setModal('edit'); setFormErr(''); }}>
                        Edit
                      </button>
                      <button
                        className={`action-btn ${u.is_active ? 'action-btn--warn' : 'action-btn--success'}`}
                        onClick={() => handleToggleActive(u)}
                        disabled={u.username === currentUser?.username}>
                        {u.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button className="action-btn action-btn--danger"
                        onClick={() => { setSelected(u); setModal('delete'); setFormErr(''); }}
                        disabled={u.username === currentUser?.username}>
                        Hapus
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--text-4)' }}>Belum ada user</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Tambah */}
      {modal === 'add' && (
        <Modal title="Tambah User Baru" onClose={() => setModal(null)}>
          <UserForm onSave={handleAdd} onCancel={() => setModal(null)} loading={saving} error={formErr} />
        </Modal>
      )}

      {/* Modal Edit */}
      {modal === 'edit' && selected && (
        <Modal title={`Edit User — ${selected.username}`} onClose={() => setModal(null)}>
          <UserForm
            initial={{ ...selected, password: '' }}
            onSave={handleEdit}
            onCancel={() => setModal(null)}
            loading={saving} error={formErr} isEdit
          />
        </Modal>
      )}

      {/* Modal Hapus */}
      {modal === 'delete' && selected && (
        <Modal title="Hapus User" onClose={() => setModal(null)}>
          <p style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 20 }}>
            Yakin ingin menghapus user <strong>{selected.full_name || selected.username}</strong>?
            <br />Tindakan ini tidak bisa dibatalkan.
          </p>
          {formErr && <div className="form-error">{formErr}</div>}
          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setModal(null)}>Batal</button>
            <button className="btn-danger" onClick={handleDelete} disabled={saving}>
              {saving ? 'Menghapus...' : 'Ya, Hapus'}
            </button>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
