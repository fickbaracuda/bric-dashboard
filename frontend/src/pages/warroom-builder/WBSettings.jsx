import Layout from '../../components/Layout';
import { WARROOM_TYPE_REGISTRY, PLUGIN_REGISTRY } from '../../services/wbRegistry';

export default function WBSettings() {
  return (
    <Layout>
      <div className="wb-page">
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-settings" style={{ color: '#6B7280' }} />
              Settings
            </h1>
            <p className="wb-page-sub">Konfigurasi Warroom Builder</p>
          </div>
        </div>

        <div className="wb-card">
          <h2 className="wb-section-title">Warroom Type Registry</h2>
          <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 12 }}>
            Daftar tipe warroom yang tersedia. Registry ini digunakan oleh wizard "Buat Warroom" untuk auto-suggest.
          </p>
          <table className="wb-table wb-table-sm">
            <thead>
              <tr>
                <th>Code</th>
                <th>Nama</th>
                <th>Business Unit</th>
                <th>Model</th>
                <th>Entity</th>
                <th>Default Plugins</th>
              </tr>
            </thead>
            <tbody>
              {WARROOM_TYPE_REGISTRY.map(r => (
                <tr key={r.code}>
                  <td><code className="wb-col-code">{r.code}</code></td>
                  <td>{r.name}</td>
                  <td>
                    <span className="wb-bu-badge" style={{ background: (r.color||'#6B7280') + '20', color: r.color||'#6B7280' }}>
                      {r.business_unit}
                    </span>
                  </td>
                  <td><span className="wb-model-badge">{r.business_model}</span></td>
                  <td><span className="wb-entity-badge">{r.entity_type}</span></td>
                  <td style={{ fontSize: 12, color: '#6B7280' }}>{r.default_plugins.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="wb-card" style={{ marginTop: 16 }}>
          <h2 className="wb-section-title">Plugin Registry</h2>
          <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 12 }}>
            Daftar plugin yang tersedia untuk membangun dashboard warroom.
          </p>
          <div className="wb-plugin-grid">
            {PLUGIN_REGISTRY.map(p => (
              <div key={p.code} className="wb-plugin-info">
                <div className="wb-plugin-name">{p.name}</div>
                <div className="wb-plugin-desc">{p.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="wb-card" style={{ marginTop: 16 }}>
          <h2 className="wb-section-title">Standard Field Mapping</h2>
          <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 12 }}>
            Field standar yang digunakan untuk memetakan kolom dari Google Sheet.
          </p>
          <div className="wb-info-box">
            <i className="ti ti-info-circle" />
            <div>
              Auto-detection menggunakan pattern matching pada nama kolom.
              Confidence &gt;80% akan otomatis dipetakan. Di bawah 80% perlu review manual di wizard.
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
