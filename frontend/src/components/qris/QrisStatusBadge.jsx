import { OWNER_COLOR, OWNER_LABEL, GRAY } from './qrisConstants';

// Badge generik untuk stageOwner (Merchant/Internal/Verifikator/PTEN/Done).
// Dulu bernama OwnerBadge di WarRoomQrisControlTower.jsx — logic warnanya
// sama persis, cuma dipindah + diberi nama sesuai daftar komponen yang
// diminta ("QrisStatusBadge").
export default function QrisStatusBadge({ owner }) {
  const color = OWNER_COLOR[owner] || GRAY;
  return (
    <span
      title={OWNER_LABEL[owner] || owner}
      className="wrqris-badge"
      style={{ background: color + '18', color, border: `1px solid ${color}40`, cursor: 'help' }}
    >
      {owner}
    </span>
  );
}
