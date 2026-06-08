import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import LeaderManagement from '../components/LeaderManagement';
import { getMembers } from '../services/api';

/* ── Helpers ── */
function fmtRev(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9)  return sign + 'Rp ' + (abs / 1e9).toFixed(2) + 'M';
  if (abs >= 1e6)  return sign + 'Rp ' + (abs / 1e6).toFixed(1) + 'jt';
  return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
}

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : nama.substring(0, 2).toUpperCase();
}

function getAvgPct(member) {
  const valid = (member.targets || []).filter(t => t.pencapaian_terakhir?.pct_revenue > 0);
  if (!valid.length) return null;
  return valid.reduce((s, t) => s + parseFloat(t.pencapaian_terakhir.pct_revenue), 0) / valid.length;
}

function getTotalRev(member) {
  return (member.targets || []).reduce((s, t) =>
    s + parseFloat(t.pencapaian_terakhir?.pencapaian_revenue || 0), 0);
}

function getTargetRev(member) {
  return (member.targets || []).reduce((s, t) =>
    s + parseFloat(t.target_revenue || 0), 0);
}

function statusInfo(pct) {
  if (pct === null) return { label: 'Belum Ada Data', cls: 'st-nodata', color: '#9CA3AF' };
  if (pct >= 100)  return { label: 'Unggul',          cls: 'st-unggul', color: '#1D9E75' };
  if (pct >= 80)   return { label: 'On Track',         cls: 'st-ontrack', color: '#F59E0B' };
  if (pct >= 70)   return { label: 'Waspada',          cls: 'st-waspada', color: '#F97316' };
  return               { label: 'Perlu Perhatian',  cls: 'st-danger',  color: '#EF4444' };
}

function pctColor(pct) {
  if (pct === null) return '#9CA3AF';
  if (pct >= 100) return '#1D9E75';
  if (pct >= 80)  return '#F59E0B';
  if (pct >= 70)  return '#F97316';
  return '#EF4444';
}

function RankBadge({ rank }) {
  const colors = { 1: '#F59E0B', 2: '#9CA3AF', 3: '#CD7F32' };
  const bg = colors[rank] || '#E5E7EB';
  const color = rank <= 3 ? '#fff' : '#6B7280';
  return (
    <div className="st-rank" style={{ background: bg, color }}>
      {rank <= 3 ? ['🥇','🥈','🥉'][rank - 1] : rank}
    </div>
  );
}

/* ── Per-Leader group ── */
function LeaderGroup({ leader, timList, navigate }) {
  const leaderPct = getAvgPct(leader);
  const allMembers = [leader, ...timList].map(m => ({
    ...m,
    avgPct: getAvgPct(m),
    totalRev: getTotalRev(m),
    targetRev: getTargetRev(m),
  }));

  const timWithData = timList.filter(m => getAvgPct(m) !== null);
  const groupAvg = timWithData.length
    ? timWithData.reduce((s, m) => s + getAvgPct(m), 0) / timWithData.length
    : null;

  const sortedTim = [...timList]
    .map(m => ({ ...m, avgPct: getAvgPct(m) }))
    .sort((a, b) => (b.avgPct ?? -1) - (a.avgPct ?? -1));

  const si = statusInfo(leaderPct);

  return (
    <div className="st-leader-group">
      {/* Leader header */}
      <div className="st-leader-header" onClick={() => navigate(`/anggota/${leader.id}`)}>
        <div className="st-leader-left">
          <div className="st-avatar-lg" style={{ background: leader.avatar_warna }}>
            {getInisial(leader.nama)}
          </div>
          <div>
            <div className="st-leader-name">{leader.nama}</div>
            <div className="st-leader-meta">
              <span className="st-posisi-leader">Leader</span>
              {leader.fungsi && <span className="st-fungsi">{leader.fungsi}</span>}
              <span className="st-tim-count">{timList.length} anggota tim</span>
            </div>
          </div>
        </div>
        <div className="st-leader-stats">
          {leaderPct !== null && (
            <div className="st-leader-pct-box">
              <div className="st-leader-pct-val" style={{ color: pctColor(leaderPct) }}>
                {leaderPct.toFixed(1)}%
              </div>
              <div className="st-leader-pct-lbl">Pencapaian</div>
            </div>
          )}
          {groupAvg !== null && (
            <div className="st-leader-pct-box">
              <div className="st-leader-pct-val" style={{ color: pctColor(groupAvg) }}>
                {groupAvg.toFixed(1)}%
              </div>
              <div className="st-leader-pct-lbl">Avg Tim</div>
            </div>
          )}
          <span className={`st-status-badge ${si.cls}`}>{si.label}</span>
          <i className="ti ti-chevron-right" style={{ color: '#9CA3AF', fontSize: 14 }} />
        </div>
      </div>

      {/* Tim rows */}
      {sortedTim.length > 0 && (
        <div className="st-tim-table">
          <div className="st-tim-table-header">
            <span>Anggota Tim</span>
            <span>Target</span>
            <span>Pencapaian</span>
            <span>%</span>
            <span>Status</span>
          </div>
          {sortedTim.map((tim, idx) => {
            const pct = tim.avgPct ?? null;
            const si2 = statusInfo(pct);
            const totalRev = getTotalRev(tim);
            const targetRev = getTargetRev(tim);
            return (
              <div key={tim.id} className="st-tim-row" onClick={() => navigate(`/anggota/${tim.id}`)}>
                <div className="st-tim-member">
                  <RankBadge rank={idx + 1} />
                  <div className="st-avatar-sm2" style={{ background: tim.avatar_warna }}>
                    {getInisial(tim.nama)}
                  </div>
                  <div>
                    <div className="st-tim-name">{tim.nama}</div>
                    {tim.fungsi && <div className="st-tim-fungsi">{tim.fungsi}</div>}
                  </div>
                </div>
                <div className="st-tim-cell">{targetRev > 0 ? fmtRev(targetRev) : '—'}</div>
                <div className="st-tim-cell">{totalRev > 0 ? fmtRev(totalRev) : '—'}</div>
                <div className="st-tim-cell">
                  <div className="st-pct-wrap">
                    <div className="st-pct-bar-bg">
                      <div className="st-pct-bar-fill"
                        style={{ width: Math.min(pct ?? 0, 100) + '%', background: pctColor(pct) }} />
                    </div>
                    <span className="st-pct-num" style={{ color: pctColor(pct) }}>
                      {pct !== null ? pct.toFixed(1) + '%' : '—'}
                    </span>
                  </div>
                </div>
                <div className="st-tim-cell">
                  <span className={`st-status-badge ${si2.cls}`}>{si2.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sortedTim.length === 0 && (
        <div className="st-no-tim">Belum ada anggota tim di bawah leader ini.</div>
      )}
    </div>
  );
}

/* ── Main Page ── */
export default function ScoreboardTim({
  unit      = 'winme_instaqris',
  unitLabel = 'WINME&INSTAQRIS',
  unitColor = '#7F77DD',
}) {
  const navigate = useNavigate();
  const [members,  setMembers]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showKelola, setShowKelola] = useState(false);

  async function load() {
    setLoading(true);
    try { setMembers(await getMembers(unit)); }
    catch { setMembers([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const handleMembersUpdated = () => {
    load();
    window.dispatchEvent(new Event('membersUpdated'));
  };

  const leaders = members.filter(m => m.posisi === 'leader');
  const allTim  = members.filter(m => m.posisi === 'tim');

  /* Summary stats */
  const allWithData = members.filter(m => getAvgPct(m) !== null);
  const grupAvg = allWithData.length
    ? allWithData.reduce((s, m) => s + getAvgPct(m), 0) / allWithData.length : 0;
  const onTrack = allWithData.filter(m => getAvgPct(m) >= 80).length;
  const atRisk  = allWithData.filter(m => getAvgPct(m) < 80).length;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <i className="ti ti-podium" style={{ color: unitColor }} />
            Scoreboard Tim
            <span className="pill pill-aman" style={{ fontSize: 11, background: unitColor + '22', color: unitColor, border: `0.5px solid ${unitColor}55` }}>{unitLabel}</span>
          </div>
          <div className="page-sub">
            Ranking &amp; pencapaian tim · {leaders.length} leader · {allTim.length} anggota tim
          </div>
        </div>
        <button
          className="lm-btn-primary"
          onClick={() => setShowKelola(true)}
        >
          <i className="ti ti-settings" /> Kelola Tim
        </button>
      </div>

      {loading ? (
        <div className="loading-wrap">
          <div className="loading-spinner" />
          <div className="loading-text">Memuat scoreboard...</div>
        </div>
      ) : members.length === 0 ? (
        <div className="st-empty">
          <i className="ti ti-users" style={{ fontSize: 40, color: '#D1D5DB' }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>Belum ada anggota tim</div>
          <div style={{ fontSize: 13, color: '#9CA3AF' }}>Klik "Kelola Tim" untuk menambahkan leader dan anggota tim.</div>
          <button className="lm-btn-primary" onClick={() => setShowKelola(true)}>
            <i className="ti ti-plus" /> Tambah Anggota
          </button>
        </div>
      ) : (
        <>
          {/* ── Summary Stats ── */}
          <div className="st-stats-row">
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#EDE9FE', color: '#7F77DD' }}>
                <i className="ti ti-users" />
              </div>
              <div>
                <div className="st-stat-val">{members.length}</div>
                <div className="st-stat-lbl">Total Anggota</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-chart-line" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: pctColor(grupAvg) }}>
                  {grupAvg > 0 ? grupAvg.toFixed(1) + '%' : '—'}
                </div>
                <div className="st-stat-lbl">Avg Pencapaian Grup</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#F0FBF7', color: '#1D9E75' }}>
                <i className="ti ti-circle-check" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: '#1D9E75' }}>{onTrack}</div>
                <div className="st-stat-lbl">On Track (≥80%)</div>
              </div>
            </div>
            <div className="st-stat-card">
              <div className="st-stat-icon" style={{ background: '#FEF2F2', color: '#EF4444' }}>
                <i className="ti ti-alert-triangle" />
              </div>
              <div>
                <div className="st-stat-val" style={{ color: '#EF4444' }}>{atRisk}</div>
                <div className="st-stat-lbl">Perlu Perhatian</div>
              </div>
            </div>
          </div>

          {/* ── Legend ── */}
          <div className="st-legend">
            {[
              { cls: 'st-unggul',  label: 'Unggul ≥100%' },
              { cls: 'st-ontrack', label: 'On Track ≥80%' },
              { cls: 'st-waspada', label: 'Waspada ≥70%' },
              { cls: 'st-danger',  label: 'Perlu Perhatian <70%' },
              { cls: 'st-nodata', label: 'Belum Ada Data' },
            ].map(s => (
              <span key={s.cls} className={`st-status-badge ${s.cls}`}>{s.label}</span>
            ))}
          </div>

          {/* ── Per-leader groups ── */}
          <div className="st-groups">
            {leaders.map(leader => (
              <LeaderGroup
                key={leader.id}
                leader={leader}
                timList={allTim.filter(m => String(m.leader_id) === String(leader.id))}
                navigate={navigate}
              />
            ))}
            {/* Tim tanpa leader */}
            {allTim.filter(m => !m.leader_id).length > 0 && (
              <div className="st-leader-group">
                <div className="st-leader-header st-leader-header--orphan">
                  <span style={{ fontSize: 13, color: '#9CA3AF', fontStyle: 'italic' }}>
                    Tim tanpa leader
                  </span>
                </div>
                <div className="st-tim-table">
                  {allTim.filter(m => !m.leader_id).map((tim, idx) => {
                    const pct = getAvgPct(tim);
                    const si2 = statusInfo(pct);
                    return (
                      <div key={tim.id} className="st-tim-row" onClick={() => navigate(`/anggota/${tim.id}`)}>
                        <div className="st-tim-member">
                          <RankBadge rank={idx + 1} />
                          <div className="st-avatar-sm2" style={{ background: tim.avatar_warna }}>
                            {getInisial(tim.nama)}
                          </div>
                          <div>
                            <div className="st-tim-name">{tim.nama}</div>
                          </div>
                        </div>
                        <div className="st-tim-cell">—</div>
                        <div className="st-tim-cell">—</div>
                        <div className="st-tim-cell">
                          <span className="st-pct-num" style={{ color: pctColor(pct) }}>
                            {pct !== null ? pct.toFixed(1) + '%' : '—'}
                          </span>
                        </div>
                        <div className="st-tim-cell">
                          <span className={`st-status-badge ${si2.cls}`}>{si2.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Modal Kelola Tim ── */}
      {showKelola && (
        <div className="lm-overlay" onClick={() => setShowKelola(false)}>
          <div className="st-kelola-panel" onClick={e => e.stopPropagation()}>
            <div className="lm-modal-header">
              <span>Kelola Tim</span>
              <button className="lm-modal-close" onClick={() => { setShowKelola(false); handleMembersUpdated(); }}>✕</button>
            </div>
            <div className="st-kelola-body">
              <LeaderManagement navigate={navigate} unit={unit} onUpdate={handleMembersUpdated} />
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
