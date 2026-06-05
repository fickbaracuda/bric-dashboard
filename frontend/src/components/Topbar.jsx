export default function Topbar({ syncedAt, bulan }) {
  const formatSync = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  const syncStr = formatSync(syncedAt);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo">BRIC</span>
        <span className="topbar-title">Retail Dashboard · Bimasaki Business Intelligence</span>
      </div>
      <div className="topbar-chips">
        {syncStr && <span className="chip chip-sync">Sync: {syncStr}</span>}
        {bulan && <span className="chip chip-bulan">{bulan.replace('_', ' ')}</span>}
      </div>
    </header>
  );
}
