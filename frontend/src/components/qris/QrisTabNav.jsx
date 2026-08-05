import { QRIS_TABS } from './qrisConstants';
import { fmtNum } from './qrisHelpers';

/**
 * Navigasi 7 tab + badge count. Scroll horizontal otomatis di layar kecil
 * (lihat .wrqris-tabs di index.css — overflow-x: auto).
 */
export default function QrisTabNav({ activeTab, onChange, badges }) {
  return (
    <div className="wrqris-tabs" role="tablist">
      {QRIS_TABS.map(tab => {
        const count = tab.badgeKey ? badges?.[tab.badgeKey] : null;
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            className={`wrqris-tab${isActive ? ' wrqris-tab-active' : ''}`}
            onClick={() => onChange(tab.key)}
          >
            <i className={`ti ${tab.icon}`} aria-hidden="true" />
            <span>{tab.label}</span>
            {count != null && count > 0 && (
              <span className="wrqris-tab-badge">{fmtNum(count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
