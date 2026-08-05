import { fmtNum } from './qrisHelpers';

/**
 * Filter bar konfigurable — dipakai semua tab dengan field berbeda-beda.
 * Reuse class CSS existing (wr-select, wri-tbl-search, wri-date-range,
 * wr-filter-tabs) supaya tidak bikin style baru untuk hal yang sudah ada.
 *
 * fields: [{ key, type: 'select'|'quicktabs'|'search'|'daterange', label, options }]
 * values: { [key]: value } (untuk daterange, value key-nya `${key}From`/`${key}To`)
 */
export default function QrisFilterBar({ fields, values, onChange, onReset, isFiltered, resultCount, resultLabel = 'outlet' }) {
  const quickFields  = fields.filter(f => f.type === 'quicktabs');
  const normalFields = fields.filter(f => f.type !== 'quicktabs');

  return (
    <div className="wr-table-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
      <div className="wr-table-left" style={{ flexWrap: 'wrap', gap: 6 }}>
        {normalFields.map(field => {
          if (field.type === 'search') {
            return (
              <input
                key={field.key}
                className="wri-tbl-search"
                placeholder={field.placeholder || '🔍 Cari...'}
                value={values[field.key] || ''}
                onChange={e => onChange(field.key, e.target.value)}
              />
            );
          }
          if (field.type === 'daterange') {
            const fromKey = `${field.key}From`;
            const toKey   = `${field.key}To`;
            return (
              <div className="wri-date-range" key={field.key}>
                <span className="wri-dr-label">{field.label}</span>
                <input type="date" className="wr-select wri-date-input" value={values[fromKey] || ''} onChange={e => onChange(fromKey, e.target.value)} />
                <span className="wri-dr-label">–</span>
                <input type="date" className="wr-select wri-date-input" value={values[toKey] || ''} onChange={e => onChange(toKey, e.target.value)} />
              </div>
            );
          }
          // select
          return (
            <select key={field.key} className="wr-select" value={values[field.key] || ''} onChange={e => onChange(field.key, e.target.value)}>
              <option value="">{field.label}</option>
              {field.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          );
        })}
        {onReset && isFiltered && <button className="wri-dr-reset" onClick={onReset}>Reset Filter</button>}
        {resultCount != null && (
          <span className="wr-count">{fmtNum(resultCount)} {resultLabel}{isFiltered ? ' (terfilter)' : ''}</span>
        )}
      </div>

      {quickFields.map(field => (
        <div className="wr-filter-tabs" key={field.key}>
          {field.options.map(opt => (
            <button
              key={opt}
              className={`wr-filter-tab${values[field.key] === opt ? ' active' : ''}`}
              onClick={() => onChange(field.key, opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
