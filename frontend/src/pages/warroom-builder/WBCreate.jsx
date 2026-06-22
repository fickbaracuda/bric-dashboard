import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import {
  wbCreateWarroom, wbUpdateWarroom, wbSheetPreview, wbSheetSave,
  wbGenerate,
} from '../../services/wbApi';
import {
  WARROOM_TYPE_REGISTRY, PLUGIN_REGISTRY, BUSINESS_UNITS,
  BUSINESS_MODELS, ENTITY_TYPES, STANDARD_FIELDS, BU_COLORS,
  SCORE_STATUS_COLORS, getWarroomTypesByBU,
} from '../../services/wbRegistry';

const TOTAL_STEPS = 13;

const STEP_LABELS = [
  'Google Sheet URL',
  'Preview Data',
  'Header Detection',
  'Column Mapping',
  'Business Unit',
  'Business Model',
  'Entity Type',
  'Warroom Type',
  'Plugin Selection',
  'Period Config',
  'Target (opsional)',
  'Konfirmasi',
  'Selesai',
];

function StepBar({ current }) {
  return (
    <div className="wb-wizard-bar">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <div key={n} className={`wb-wizard-step ${done ? 'wb-wizard-step--done' : ''} ${active ? 'wb-wizard-step--active' : ''}`}>
            <div className="wb-wizard-dot">{done ? <i className="ti ti-check" /> : n}</div>
            <div className="wb-wizard-label">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function WBCreate() {
  const navigate = useNavigate();

  const [step,      setStep]      = useState(1);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  // Step 1: Sheet URL
  const [sheetUrl, setSheetUrl] = useState('');

  // Step 2-3: Preview result
  const [preview,   setPreview]   = useState(null); // result of wbSheetPreview
  const [warroom,   setWarroom]   = useState(null); // created warroom

  // Step 4: Column Mapping
  const [mappings,  setMappings]  = useState([]);

  // Step 5-9: Config
  const [buName,       setBuName]       = useState('');
  const [bizModel,     setBizModel]     = useState('');
  const [entityType,   setEntityType]   = useState('');
  const [wrTypeCode,   setWrTypeCode]   = useState('');
  const [pluginCodes,  setPluginCodes]  = useState([]);
  const [entityLabel,  setEntityLabel]  = useState('Entity');
  const [wrColor,      setWrColor]      = useState('#1D9E75');
  const [wrName,       setWrName]       = useState('');

  // Step 10: Period
  const [periodType, setPeriodType] = useState('auto');

  // Step 12: generate result
  const [genResult, setGenResult] = useState(null);

  const clearError = () => setError('');

  /* ── Step navigation ── */
  const goNext = () => { clearError(); setStep(s => s + 1); };
  const goPrev = () => { clearError(); setStep(s => s - 1); };

  /* ── Step 1: Create warroom + fetch preview ── */
  const handleStep1 = async () => {
    if (!sheetUrl.trim()) { setError('URL Google Sheet wajib diisi'); return; }
    if (!sheetUrl.includes('docs.google.com/spreadsheets')) {
      setError('URL harus berupa URL Google Sheet (docs.google.com/spreadsheets/...)');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // Buat warroom draft dulu
      const wr = await wbCreateWarroom({
        name: 'Draft Warroom', business_unit: 'Custom', business_model: 'Custom',
        entity_type: 'Custom', entity_label: 'Entity', color: '#1D9E75',
      });
      setWarroom(wr);

      // Fetch preview
      const prev = await wbSheetPreview(wr.id, sheetUrl);
      setPreview(prev);
      setMappings(prev.auto_mappings || []);
      goNext();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── Step 4: Save mappings → go to step 5 ── */
  const handleSaveMappings = async () => {
    setLoading(true);
    try {
      await wbSheetSave(warroom.id, mappings);
      goNext();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  /* ── Step 8: Auto-fill from registry ── */
  const handleSelectWRType = (code) => {
    setWrTypeCode(code);
    const reg = WARROOM_TYPE_REGISTRY.find(r => r.code === code);
    if (reg) {
      setPluginCodes(reg.default_plugins || []);
      setEntityLabel(reg.entity_label || 'Entity');
      setWrColor(reg.color || '#1D9E75');
      if (!wrName) setWrName(reg.name);
    }
  };

  /* ── Step 12: Save final + generate ── */
  const handleGenerate = async () => {
    setLoading(true);
    setError('');
    try {
      // Update warroom dengan config final
      await wbUpdateWarroom(warroom.id, {
        name: wrName || `${buName} ${entityType} Warroom`,
        business_unit: buName,
        business_model: bizModel,
        entity_type: entityType,
        entity_label: entityLabel,
        warroom_type_code: wrTypeCode,
        plugin_codes: pluginCodes,
        color: wrColor,
      });

      // Generate
      const result = await wbGenerate(warroom.id);
      setGenResult(result);
      goNext();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const updateMapping = (idx, field, value) => {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  const togglePlugin = (code) => {
    setPluginCodes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    );
  };

  const suggestedTypes = getWarroomTypesByBU(buName, entityType);

  /* ── Render ── */
  return (
    <Layout>
      <div className="wb-page">
        <div className="wb-page-header">
          <div>
            <h1 className="wb-page-title">
              <i className="ti ti-plus" style={{ color: '#1D9E75' }} />
              Buat Warroom Baru
            </h1>
            <p className="wb-page-sub">
              Step {step} dari {TOTAL_STEPS}: {STEP_LABELS[step - 1]}
            </p>
          </div>
          <button className="wb-btn-ghost" onClick={() => navigate('/warroom-builder')}>
            <i className="ti ti-x" /> Batal
          </button>
        </div>

        <StepBar current={step} />

        {error && (
          <div className="wb-error-banner">
            <i className="ti ti-alert-circle" /> {error}
          </div>
        )}

        <div className="wb-wizard-body">

          {/* ── STEP 1: Sheet URL ── */}
          {step === 1 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Paste Google Sheet URL</h2>
              <p className="wb-wizard-step-desc">
                Tempelkan URL Google Sheet yang berisi data warroom Anda.
                Sheet harus dapat diakses secara publik (share → Anyone with the link → Viewer).
              </p>
              <div className="wb-field-group">
                <label className="wb-label">Google Sheet URL <span className="wb-required">*</span></label>
                <input
                  className="wb-input"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={sheetUrl}
                  onChange={e => setSheetUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleStep1()}
                />
                <div className="wb-field-hint">
                  Format: https://docs.google.com/spreadsheets/d/<b>[ID]</b>/edit#gid=<b>[GID]</b>
                </div>
              </div>
              <div className="wb-wizard-actions">
                <button
                  className="wb-btn-primary"
                  onClick={handleStep1}
                  disabled={loading}
                >
                  {loading ? <><i className="ti ti-loader wb-spin" /> Mengambil data...</> : <>Ambil Data <i className="ti ti-arrow-right" /></>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 2: Preview Data ── */}
          {step === 2 && preview && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Preview Data</h2>
              <div className="wb-preview-meta">
                <span className="wb-meta-chip"><i className="ti ti-table" /> {preview.total_rows?.toLocaleString()} baris data</span>
                <span className="wb-meta-chip"><i className="ti ti-columns" /> {preview.columns?.length} kolom</span>
                <span className="wb-meta-chip"><i className="ti ti-calendar" />
                  {preview.period_info?.period_type === 'mtd'
                    ? `MTD · Day ${preview.period_info?.cutoff_day}`
                    : 'Full Month'}
                </span>
                {preview.period_info?.has_same_period && (
                  <span className="wb-meta-chip wb-meta-chip--green"><i className="ti ti-arrows-left-right" /> Same Period Data</span>
                )}
              </div>
              <div className="wb-preview-table-wrap">
                <table className="wb-table wb-table-sm">
                  <thead>
                    <tr>
                      {preview.columns?.map(col => <th key={col}>{col}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.preview || []).map((row, i) => (
                      <tr key={i}>
                        {preview.columns?.map(col => <td key={col}>{row[col] ?? ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext}>
                  Lanjut ke Header Detection <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Header Detection ── */}
          {step === 3 && preview && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Header Detection</h2>
              <div className="wb-info-box">
                <i className="ti ti-info-circle" />
                <div>
                  <b>Baris header terdeteksi: {preview.header_rows}</b>
                  {preview.header_rows === 2
                    ? ' — Multi-row header terdeteksi dan berhasil di-flatten.'
                    : ' — Single row header.'}
                  <br />
                  Sistem menghasilkan {preview.columns?.length} kolom setelah flattening.
                </div>
              </div>
              <div className="wb-chip-list">
                {preview.columns?.map((col, i) => (
                  <span key={i} className="wb-col-chip">{col}</span>
                ))}
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext}>
                  Lanjut ke Column Mapping <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 4: Column Mapping ── */}
          {step === 4 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Column Mapping</h2>
              <p className="wb-wizard-step-desc">
                Petakan kolom original dari sheet ke field standar.
                Sistem sudah mendeteksi otomatis — Anda bisa mengoverride.
              </p>
              <div className="wb-mapping-table-wrap">
                <table className="wb-table wb-table-sm">
                  <thead>
                    <tr>
                      <th>Kolom Original</th>
                      <th>Standard Field</th>
                      <th>Data Type</th>
                      <th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m, i) => (
                      <tr key={i}>
                        <td><code className="wb-col-code">{m.original_col}</code></td>
                        <td>
                          <select
                            className="wb-select wb-select-sm"
                            value={m.standard_field || ''}
                            onChange={e => updateMapping(i, 'standard_field', e.target.value)}
                          >
                            <option value="">— abaikan —</option>
                            {STANDARD_FIELDS.map(sf => (
                              <option key={sf.value} value={sf.value}>{sf.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="wb-select wb-select-sm"
                            value={m.data_type || 'text'}
                            onChange={e => updateMapping(i, 'data_type', e.target.value)}
                          >
                            <option value="text">Text</option>
                            <option value="number">Number</option>
                            <option value="date">Date</option>
                          </select>
                        </td>
                        <td>
                          <div className="wb-confidence-bar">
                            <div
                              className="wb-confidence-fill"
                              style={{
                                width: `${((m.confidence || 0) * 100).toFixed(0)}%`,
                                background: m.confidence >= 0.6 ? '#1D9E75' : m.confidence >= 0.3 ? '#F59E0B' : '#EF4444',
                              }}
                            />
                            <span className="wb-confidence-val">{((m.confidence||0)*100).toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={handleSaveMappings} disabled={loading}>
                  {loading ? <><i className="ti ti-loader wb-spin" /> Menyimpan...</> : <>Simpan Mapping <i className="ti ti-arrow-right" /></>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 5: Business Unit ── */}
          {step === 5 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Pilih Business Unit</h2>
              <div className="wb-bu-grid">
                {BUSINESS_UNITS.map(bu => {
                  const color = BU_COLORS[bu] || '#6B7280';
                  return (
                    <button
                      key={bu}
                      className={`wb-bu-btn ${buName === bu ? 'wb-bu-btn--active' : ''}`}
                      style={{ '--bu-color': color }}
                      onClick={() => {
                        setBuName(bu);
                        setBizModel(WARROOM_TYPE_REGISTRY.find(r => r.business_unit === bu)?.business_model || '');
                        setWrTypeCode('');
                        setWrName('');
                      }}
                    >
                      <div className="wb-bu-dot" style={{ background: color }} />
                      {bu}
                    </button>
                  );
                })}
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext} disabled={!buName}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 6: Business Model ── */}
          {step === 6 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Business Model</h2>
              <div className="wb-option-list">
                {BUSINESS_MODELS.map(bm => (
                  <button
                    key={bm}
                    className={`wb-option-btn ${bizModel === bm ? 'wb-option-btn--active' : ''}`}
                    onClick={() => setBizModel(bm)}
                  >
                    <div className="wb-option-code">{bm}</div>
                    <div className="wb-option-desc">
                      {bm === 'B2B' && 'Business to Business — melayani merchant/agent/partner'}
                      {bm === 'B2C' && 'Business to Consumer — melayani outlet/user langsung'}
                      {bm === 'B2B2C' && 'Business to Business to Consumer — melalui reseller/seller'}
                      {bm === 'HOST_TO_HOST' && 'Host-to-Host — integrasi sistem antar partner'}
                      {bm === 'Custom' && 'Custom model — tentukan sendiri'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext} disabled={!bizModel}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 7: Entity Type ── */}
          {step === 7 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Entity Type</h2>
              <p className="wb-wizard-step-desc">Siapa yang dianalisis dalam warroom ini?</p>
              <div className="wb-bu-grid">
                {ENTITY_TYPES.map(et => (
                  <button
                    key={et}
                    className={`wb-bu-btn ${entityType === et ? 'wb-bu-btn--active' : ''}`}
                    onClick={() => {
                      setEntityType(et);
                      setEntityLabel(et);
                      setWrTypeCode('');
                    }}
                  >
                    {et}
                  </button>
                ))}
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext} disabled={!entityType}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 8: Warroom Type ── */}
          {step === 8 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Warroom Type</h2>
              {suggestedTypes.length > 0 && (
                <p className="wb-wizard-step-desc">
                  <i className="ti ti-sparkles" /> Sistem merekomendasikan tipe berikut berdasarkan pilihan Anda:
                </p>
              )}
              <div className="wb-type-list">
                {(suggestedTypes.length > 0 ? suggestedTypes : WARROOM_TYPE_REGISTRY).map(reg => {
                  const color = reg.color || '#6B7280';
                  return (
                    <button
                      key={reg.code}
                      className={`wb-type-btn ${wrTypeCode === reg.code ? 'wb-type-btn--active' : ''}`}
                      style={{ '--type-color': color }}
                      onClick={() => handleSelectWRType(reg.code)}
                    >
                      <div className="wb-type-dot" style={{ background: color }} />
                      <div className="wb-type-body">
                        <div className="wb-type-name">{reg.name}</div>
                        <div className="wb-type-meta">
                          {reg.business_unit} · {reg.business_model} · {reg.entity_type}
                        </div>
                        <div className="wb-type-plugins">
                          Plugins: {reg.default_plugins.join(', ')}
                        </div>
                      </div>
                      {wrTypeCode === reg.code && <i className="ti ti-circle-check" style={{ color }} />}
                    </button>
                  );
                })}
              </div>
              <div className="wb-field-group" style={{ marginTop: 16 }}>
                <label className="wb-label">Nama Warroom <span className="wb-required">*</span></label>
                <input
                  className="wb-input"
                  value={wrName}
                  onChange={e => setWrName(e.target.value)}
                  placeholder={`${buName} ${entityType} Warroom`}
                />
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 9: Plugin Selection ── */}
          {step === 9 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Plugin Selection</h2>
              <p className="wb-wizard-step-desc">
                Pilih plugin yang akan digunakan. Plugin sudah dipilihkan berdasarkan warroom type.
              </p>
              <div className="wb-plugin-grid">
                {PLUGIN_REGISTRY.map(p => (
                  <button
                    key={p.code}
                    className={`wb-plugin-btn ${pluginCodes.includes(p.code) ? 'wb-plugin-btn--active' : ''}`}
                    onClick={() => togglePlugin(p.code)}
                  >
                    <div className="wb-plugin-check">
                      {pluginCodes.includes(p.code) ? <i className="ti ti-check" /> : null}
                    </div>
                    <div>
                      <div className="wb-plugin-name">{p.name}</div>
                      <div className="wb-plugin-desc">{p.description}</div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext} disabled={pluginCodes.length === 0}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 10: Period Config ── */}
          {step === 10 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Period Config</h2>
              <div className="wb-info-box">
                <i className="ti ti-info-circle" />
                <div>
                  <b>Terdeteksi otomatis:</b>{' '}
                  {preview?.period_info?.period_type === 'mtd'
                    ? `MTD · Day ${preview?.period_info?.cutoff_day}`
                    : 'Full Month Comparison'}
                  {preview?.period_info?.has_same_period && ' · Same Period Available'}
                </div>
              </div>
              <div className="wb-option-list">
                <button
                  className={`wb-option-btn ${periodType === 'auto' ? 'wb-option-btn--active' : ''}`}
                  onClick={() => setPeriodType('auto')}
                >
                  <div className="wb-option-code">Auto Detect</div>
                  <div className="wb-option-desc">
                    Sistem mendeteksi otomatis dari data sheet (disarankan)
                  </div>
                </button>
                <button
                  className={`wb-option-btn ${periodType === 'mtd' ? 'wb-option-btn--active' : ''}`}
                  onClick={() => setPeriodType('mtd')}
                >
                  <div className="wb-option-code">MTD — Month-to-Date</div>
                  <div className="wb-option-desc">Data berjalan dari awal bulan sampai hari ini</div>
                </button>
                <button
                  className={`wb-option-btn ${periodType === 'full' ? 'wb-option-btn--active' : ''}`}
                  onClick={() => setPeriodType('full')}
                >
                  <div className="wb-option-code">Full Month Comparison</div>
                  <div className="wb-option-desc">Perbandingan bulan penuh (misal: Mei vs Juni)</div>
                </button>
                <button
                  className={`wb-option-btn ${periodType === 'same_period' ? 'wb-option-btn--active' : ''}`}
                  onClick={() => setPeriodType('same_period')}
                >
                  <div className="wb-option-code">Same Period Comparison</div>
                  <div className="wb-option-desc">
                    Perbandingan periode yang sama (misal: 1-9 Mei vs 1-9 Juni)
                  </div>
                </button>
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext}>
                  Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 11: Target (opsional) ── */}
          {step === 11 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Target (Opsional)</h2>
              <p className="wb-wizard-step-desc">
                Target tidak wajib diisi. Anda bisa menambahkannya nanti dari dashboard warroom.
              </p>
              <div className="wb-info-box">
                <i className="ti ti-target" />
                <div>
                  Target management bisa diatur setelah warroom dibuat.
                  Sistem akan menghitung achievement %, gap, dan required run rate secara otomatis.
                </div>
              </div>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button className="wb-btn-primary" onClick={goNext}>
                  Skip / Lanjut <i className="ti ti-arrow-right" />
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 12: Konfirmasi + Generate ── */}
          {step === 12 && (
            <div className="wb-wizard-step-content">
              <h2 className="wb-wizard-step-title">Konfirmasi & Generate</h2>
              <div className="wb-confirm-summary">
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Nama Warroom</span>
                  <span className="wb-confirm-val">{wrName || `${buName} ${entityType} Warroom`}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Business Unit</span>
                  <span className="wb-confirm-val">{buName}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Business Model</span>
                  <span className="wb-confirm-val">{bizModel}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Entity Type</span>
                  <span className="wb-confirm-val">{entityType}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Warroom Type</span>
                  <span className="wb-confirm-val">{wrTypeCode || 'Custom'}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Plugins</span>
                  <span className="wb-confirm-val">{pluginCodes.join(', ') || '—'}</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Data Sheet</span>
                  <span className="wb-confirm-val wb-confirm-url">{sheetUrl.slice(0, 60)}...</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Total Data</span>
                  <span className="wb-confirm-val">{preview?.total_rows?.toLocaleString()} baris</span>
                </div>
                <div className="wb-confirm-row">
                  <span className="wb-confirm-label">Kolom Terpetakan</span>
                  <span className="wb-confirm-val">{mappings.filter(m => m.standard_field).length} dari {mappings.length}</span>
                </div>
              </div>
              <p style={{ color: '#6B7280', fontSize: 13, marginTop: 16 }}>
                Klik "Generate Warroom" untuk memproses data, menghitung metrics, menghasilkan insight dan alert otomatis.
                Proses ini membutuhkan beberapa detik.
              </p>
              <div className="wb-wizard-actions">
                <button className="wb-btn-ghost" onClick={goPrev}>← Kembali</button>
                <button
                  className="wb-btn-primary wb-btn-generate"
                  onClick={handleGenerate}
                  disabled={loading}
                >
                  {loading
                    ? <><i className="ti ti-loader wb-spin" /> Generating... (proses data {preview?.total_rows?.toLocaleString()} baris)</>
                    : <><i className="ti ti-bolt" /> Generate Warroom</>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 13: Done ── */}
          {step === 13 && genResult && (
            <div className="wb-wizard-step-content wb-wizard-done">
              <div className="wb-done-icon"><i className="ti ti-circle-check" style={{ color: '#1D9E75' }} /></div>
              <h2 className="wb-wizard-step-title" style={{ color: '#1D9E75' }}>Warroom Berhasil Dibuat!</h2>
              <div className="wb-done-stats">
                <div className="wb-done-stat">
                  <div className="wb-done-stat-val">{genResult.rows_processed?.toLocaleString()}</div>
                  <div className="wb-done-stat-label">Entity Diproses</div>
                </div>
                <div className="wb-done-stat">
                  <div className="wb-done-stat-val" style={{ color: SCORE_STATUS_COLORS[genResult.score_status] }}>
                    {genResult.score}
                  </div>
                  <div className="wb-done-stat-label">Warroom Score</div>
                </div>
                <div className="wb-done-stat">
                  <div className="wb-done-stat-val">{genResult.alert_count}</div>
                  <div className="wb-done-stat-label">Alert Dibuat</div>
                </div>
                <div className="wb-done-stat">
                  <div className="wb-done-stat-val">{genResult.action_count}</div>
                  <div className="wb-done-stat-label">Action Dibuat</div>
                </div>
              </div>
              <div className="wb-wizard-actions wb-done-actions">
                <button className="wb-btn-ghost" onClick={() => navigate('/warroom-builder')}>
                  Ke Overview
                </button>
                <button
                  className="wb-btn-primary"
                  onClick={() => navigate(`/warroom-builder/${warroom.id}`)}
                >
                  <i className="ti ti-layout-dashboard" /> Buka Dashboard Warroom
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

