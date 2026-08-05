import { PRIORITY_LABEL } from './qrisConstants';

const PRIORITY_CLASS = {
  P0: 'wrqris-priority-p0',
  P1: 'wrqris-priority-p1',
  P2: 'wrqris-priority-p2',
  P3: 'wrqris-priority-p3',
};

export default function QrisPriorityBadge({ level }) {
  return (
    <span title={PRIORITY_LABEL[level] || level} className={`wrqris-badge ${PRIORITY_CLASS[level] || ''}`}>
      {level}
    </span>
  );
}
