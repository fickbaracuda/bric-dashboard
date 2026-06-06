import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Chart from 'chart.js/auto';
import Layout from '../components/Layout';
import { getMemberDetail, updatePencapaian, addMemberTarget, deleteMemberTarget } from '../services/api';

function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + 'Rp ' + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function fmtTgl(tgl) {
  const d = new Date(tgl);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2
    ? (w[0][0] + w[1][0]).toUpperCase()
    : nama.substring(0, 2).toUpperCase();
}

function pctColor(p) {
  if (p >= 100) return '#1D9E75';
  if (p >= 80)  return '#F59E0B';
  if (p >= 70)  return '#EF4444';
  return '#DC2626';
}

function trendIcon(trend) {
  if (trend === 'naik')  return <i className="ti ti-trending-up"  style={{ color: '#1D9E75' }} />;
  if (trend === 'turun') return <i className="ti ti-trending-down" style={{ color: '#EF4444' }} />;
  return <i className="ti ti-minus" style={{ color: '#9CA3AF' }} />;
}

/* ── Chart: Riwayat per target ── */
function TargetChart({ target }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !target.riwayat?.length) return;
    if (chartRef.current) chartRef.current.destroy();

    const sorted = [...target.riwayat].sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
    const labels = sorted.map(r => fmtTgl(r.tanggal));
    const vals   = sorted.map(r => parseFloat(r.pct_revenue) || 0);

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '% Pencapaian',
          data: vals,
          backgroundColor: vals.map(v => pctColor(v) + 'CC'),
          borderColor:     vals.map(v => pctColor(v)),
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = sorted[ctx.dataIndex];
                return [
                  `Pencapaian: ${ctx.parsed.y.toFixed(1)}%`,
                  `Revenue: ${fmtRev(r.pencapaian_revenue)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: '#888780' },
          },
          y: {
            min: 0,
            grid: { color: 'rgba(0,0,0,.05)' },
            ticks: {
              font: { size: 10 }, color: '#888780',
              callback: v => v + '%',
            },
          },
        },
      },
    });

    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [target]);

  if (!target.riwayat?.length) {
    return <div className="ad-chart-empty">Belum ada data riwayat</div>;
  }

  return (
    <div className="ad-chart-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── Modal Input Pencapaian ── */
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
  const targetRv = parseFloat(target.target_revenue)   || 0;
  const pctPrev  = targetRv > 0 ? ((revAmt / targetRv) * 100).toFixed(1) : null;

  async function handleSave() {
    setBusy(true); setErr('');
    try {
      await onSave(target.id, {
        pencapaian_kr: form.pencapaian_kr || null,
        pencapaian_revenue: revAmt,
        pct_kr: 0, pct_revenue: 0,
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
            {pctPrev !== null && (
              <div className="lm-pct-preview">{pctPrev}% dari target</div>
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
            {busy ? 'Menyimpan...' : 'Simpan'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Modal Tambah Target ── */
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
      await onSave(memberId, { ...form, target_revenue: parseFloat(form.target_revenue) || 0 });
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
              placeholder="cth: Revenue Winme" />
          </div>
          <div className="lm-field">
            <label>Key Result / KPI</label>
            <input className="lm-input" value={form.key_result} onChange={set('key_result')}
              placeholder="cth: Fee base transaksi" />
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
            {busy ? 'Menyimpan...' : 'Tambah'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Main Page ─────────── */
export default function AnggotaDetail() {
  const { id }    = useParams();
  const navigate  = useNavigate();
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [modal,   setModal]   = useState(null);
  const [toast,   setToast]   = useState('');

  async function load() {
    setLoading(true); setError('');
    try { setData(await getMemberDetail(id)); }
    catch (e) { setError(e.response?.data?.error || 'Gagal memuat data.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [id]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  async function handleInputPencapaian(targetId, form) {
    await updatePencapaian(targetId, form);
    showToast('Pencapaian berhasil disimpan.');
    load();
  }

  async function handleAddTarget(memberId, form) {
    await addMemberTarget(memberId, form);
    showToast('Target berhasil ditambahkan.');
    load();
  }

  async function handleDeleteTarget(targetId) {
    if (!window.confirm('Hapus target ini beserta semua data pencapaiannya?')) return;
    await deleteMemberTarget(targetId);
    showToast('Target dihapus.');
    load();
  }

  if (loading) return (
    <Layout>
      <div className="loading-wrap">
        <div className="loading-spinner" />
        <div className="loading-text">Memuat profil anggota...</div>
      </div>
    </Layout>
  );

  if (error) return (
    <Layout>
      <div className="error-wrap">
        <div className="error-icon"><i className="ti ti-alert-circle" /></div>
        <div className="error-msg">{error}</div>
        <button className="lm-btn-primary" onClick={() => navigate('/winme')}>
          Kembali ke Winme
        </button>
      </div>
    </Layout>
  );

  if (!data) return null;

  const { member, targets, analisis } = data;
  const { avg_pencapaian, trend, target_terbaik, target_terlemah, rekomendasi } = analisis;

  return (
    <Layout>
      <div className="ad-page">

        {/* ── Back ── */}
        <button className="ad-back" onClick={() => navigate('/winme')}>
          <i className="ti ti-arrow-left" /> Kembali ke Winme &amp; InstaQris
        </button>

        {/* ── Profile Header ── */}
        <div className="ad-profile-card">
          <div className="ad-avatar-lg" style={{ background: member.avatar_warna }}>
            {getInisial(member.nama)}
          </div>
          <div className="ad-profile-info">
            <div className="ad-profile-name">{member.nama}</div>
            <div className="ad-profile-meta">
              <span className={'lm-posisi-badge lm-posisi-' + member.posisi}>
                {member.posisi}
              </span>
              {member.fungsi && <span className="ad-fungsi">{member.fungsi}</span>}
            </div>
          </div>
          <div className="ad-profile-stats">
            <div className="ad-stat-box">
              <div className="ad-stat-label">Avg Pencapaian</div>
              <div className="ad-stat-val" style={{ color: pctColor(avg_pencapaian) }}>
                {avg_pencapaian.toFixed(1)}%
              </div>
            </div>
            <div className="ad-stat-box">
              <div className="ad-stat-label">Tren 3 Hari</div>
              <div className="ad-stat-val" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {trendIcon(trend)}
                <span style={{ fontSize: 14, textTransform: 'capitalize', color: '#374151' }}>
                  {trend}
                </span>
              </div>
            </div>
            <div className="ad-stat-box">
              <div className="ad-stat-label">Jumlah Target</div>
              <div className="ad-stat-val">{targets.length}</div>
            </div>
          </div>
          <button className="lm-btn-primary ad-add-target-btn"
            onClick={() => setModal({ type: 'addtarget' })}>
            <i className="ti ti-plus" /> Tambah Target
          </button>
        </div>

        {/* ── Analisis Quick Box ── */}
        <div className="ad-analisis-row">
          <div className="ad-analisis-box">
            <div className="ad-analisis-label">Target Terbaik</div>
            <div className="ad-analisis-val">
              <i className="ti ti-trophy" style={{ color: '#F59E0B' }} /> {target_terbaik}
            </div>
          </div>
          <div className="ad-analisis-box">
            <div className="ad-analisis-label">Perlu Perhatian</div>
            <div className="ad-analisis-val">
              <i className="ti ti-alert-triangle" style={{ color: '#EF4444' }} /> {target_terlemah}
            </div>
          </div>
          <div className="ad-analisis-box ad-analisis-wide">
            <div className="ad-analisis-label">Rekomendasi</div>
            <div className="ad-analisis-text">{rekomendasi}</div>
          </div>
        </div>

        {/* ── Target Cards ── */}
        {targets.length === 0 ? (
          <div className="ad-empty">
            <i className="ti ti-target" style={{ fontSize: 32, color: '#D1D5DB' }} />
            <div>Belum ada target terdaftar.</div>
            <button className="lm-btn-primary"
              onClick={() => setModal({ type: 'addtarget' })}>
              Tambah Target Pertama
            </button>
          </div>
        ) : (
          <div className="ad-targets-grid">
            {targets.map(t => {
              const valid  = (t.riwayat || []).filter(r => r.pct_revenue > 0);
              const avg    = valid.length
                ? valid.reduce((s, r) => s + parseFloat(r.pct_revenue), 0) / valid.length
                : 0;
              const latest = t.riwayat?.[0];

              return (
                <div key={t.id} className="ad-target-card">
                  <div className="ad-target-card-header">
                    <div>
                      <div className="ad-target-card-name">{t.nama_target}</div>
                      {t.key_result && (
                        <div className="ad-target-card-kr">{t.key_result}</div>
                      )}
                    </div>
                    <div className="ad-target-card-actions">
                      <button className="lm-action-sm lm-action-sm-primary"
                        onClick={() => setModal({ type: 'pencapaian', data: t })}
                        title="Input pencapaian">
                        <i className="ti ti-plus" /> Input
                      </button>
                      <button className="lm-action-sm lm-action-sm-danger"
                        onClick={() => handleDeleteTarget(t.id)}
                        title="Hapus target">
                        <i className="ti ti-trash" />
                      </button>
                    </div>
                  </div>

                  <div className="ad-target-kpi-row">
                    <div className="ad-kpi-box">
                      <div className="ad-kpi-lbl">Target</div>
                      <div className="ad-kpi-val">{fmtRev(t.target_revenue)}</div>
                    </div>
                    <div className="ad-kpi-box">
                      <div className="ad-kpi-lbl">Terakhir Input</div>
                      <div className="ad-kpi-val">
                        {latest ? fmtRev(latest.pencapaian_revenue) : '—'}
                      </div>
                    </div>
                    <div className="ad-kpi-box">
                      <div className="ad-kpi-lbl">Avg %</div>
                      <div className="ad-kpi-val" style={{ color: pctColor(avg) }}>
                        {avg > 0 ? avg.toFixed(1) + '%' : '—'}
                      </div>
                    </div>
                  </div>

                  {avg > 0 && (
                    <div className="ad-progress-wrap">
                      <div className="ad-progress-bar">
                        <div
                          className="ad-progress-fill"
                          style={{
                            width: Math.min(avg, 100) + '%',
                            background: pctColor(avg),
                          }}
                        />
                      </div>
                      <div className="ad-progress-label"
                        style={{ color: pctColor(avg) }}>
                        {avg.toFixed(1)}%
                      </div>
                    </div>
                  )}

                  <TargetChart target={t} />

                  {t.riwayat?.length > 0 && (
                    <div className="ad-riwayat-mini">
                      <div className="ad-riwayat-title">5 Pencapaian Terakhir</div>
                      {t.riwayat.slice(0, 5).map(r => (
                        <div key={r.id} className="ad-riwayat-row">
                          <span className="ad-riwayat-tgl">
                            {new Date(r.tanggal).toLocaleDateString('id-ID', {
                              day: '2-digit', month: 'short'
                            })}
                          </span>
                          <span className="ad-riwayat-rev">{fmtRev(r.pencapaian_revenue)}</span>
                          <span className="ad-riwayat-pct"
                            style={{ color: pctColor(parseFloat(r.pct_revenue)) }}>
                            {parseFloat(r.pct_revenue).toFixed(1)}%
                          </span>
                          {r.catatan && (
                            <span className="ad-riwayat-note" title={r.catatan}>
                              <i className="ti ti-note" />
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {modal?.type === 'pencapaian' && (
        <ModalPencapaian
          target={modal.data}
          onSave={handleInputPencapaian}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'addtarget' && (
        <ModalTarget
          memberId={member.id}
          onSave={handleAddTarget}
          onClose={() => setModal(null)}
        />
      )}

      {toast && <div className="toast-success">{toast}</div>}
    </Layout>
  );
}
