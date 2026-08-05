import { GRAY } from './qrisConstants';

const SLA_CLASS = {
  Breach:      'wrqris-sla-breach',
  Warning:     'wrqris-sla-warning',
  'On Track':  'wrqris-sla-ontrack',
};

export default function QrisSlaBadge({ status }) {
  if (!status) return <span style={{ fontSize: 11, color: GRAY }}>—</span>;
  return (
    <span className={`wrqris-badge ${SLA_CLASS[status] || ''}`}>
      {status}
    </span>
  );
}
