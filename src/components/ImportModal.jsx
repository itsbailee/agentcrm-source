import React, { useState } from 'react';
import { play } from '../sounds.js';

const FIELD_OPTIONS = ['', 'firstName', 'lastName', 'name', 'phone', 'brokerage', 'city', 'state'];
const FIELD_LABELS = {
  '':          '— skip —',
  firstName:   'First Name',
  lastName:    'Last Name',
  name:        'Full Name',
  phone:       'Phone Number',
  brokerage:   'Brokerage',
  city:        'City',
  state:       'State',
};

export default function ImportModal({ onClose, onDone }) {
  const [step, setStep] = useState('pick'); // pick | map | importing | done
  const [fileData, setFileData] = useState(null);
  const [listName, setListName] = useState('');
  const [columnMap, setColumnMap] = useState({});
  const [error, setError] = useState('');
  const [importResult, setImportResult] = useState(null);

  const handlePickFile = async () => {
    setError('');
    try {
      const data = await window.api.openFile();
      if (!data) return;
      setFileData(data);
      setColumnMap(data.columnMap || {});
      // Auto-generate list name from filename
      const filename = data.filePath.split('/').pop().replace('.csv', '');
      setListName(filename);
      setStep('map');
    } catch (e) {
      setError(e.message || 'Failed to open file');
    }
  };

  const updateMap = (field, csvCol) => {
    setColumnMap(prev => {
      const next = { ...prev };
      // Remove this csv col from other fields
      Object.keys(next).forEach(k => { if (next[k] === csvCol && csvCol !== '') delete next[k]; });
      if (csvCol) next[field] = csvCol;
      else delete next[field];
      return next;
    });
  };

  const handleImport = async () => {
    if (!listName.trim()) { setError('Please enter a list name.'); return; }
    if (!columnMap.phone && !Object.values(columnMap).some(v => v)) {
      setError('Please map at least the phone number column.'); return;
    }
    if (!columnMap.phone) { setError('Phone number column is required to send SMS.'); return; }

    setStep('importing');
    setError('');
    try {
      const result = await window.api.importCSV({
        filePath: fileData.filePath,
        listName: listName.trim(),
        columnMap,
      });
      setImportResult(result);
      play('filedone');
      setStep('done');
    } catch (e) {
      setError(e.message || 'Import failed');
      setStep('map');
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">
            {step === 'pick' && 'IMPORT CSV'}
            {step === 'map' && 'MAP COLUMNS'}
            {step === 'importing' && 'IMPORTING...'}
            {step === 'done' && 'IMPORT COMPLETE'}
          </span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

          {step === 'pick' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📂</div>
              <div style={{ color: 'var(--text1)', marginBottom: 8, fontSize: 14 }}>
                Select a CSV file of real estate agents
              </div>
              <div style={{ color: 'var(--text2)', fontSize: 12, fontFamily: 'var(--font-mono)', marginBottom: 20 }}>
                Expected columns: name, brokerage, city, state, phone
              </div>
              <button className="btn btn-primary" onClick={handlePickFile}>
                Browse for CSV
              </button>
            </div>
          )}

          {step === 'map' && fileData && (
            <>
              <div className="form-group">
                <label className="form-label">List Name</label>
                <input
                  className="form-input"
                  value={listName}
                  onChange={e => setListName(e.target.value)}
                  placeholder="e.g. Charlotte Agents Q1"
                />
              </div>

              <div className="separator" />

              <div style={{ marginBottom: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Map your CSV columns → CRM fields ({fileData.totalRows.toLocaleString()} rows detected)
              </div>

              {fileData.headers.map(header => (
                <div className="col-map-row" key={header}>
                  <div className="col-map-label" title={header}
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {header}
                  </div>
                  <span style={{ color: 'var(--text2)', fontSize: 12 }}>→</span>
                  <select
                    className="col-map-select"
                    value={Object.keys(columnMap).find(k => columnMap[k] === header) || ''}
                    onChange={e => updateMap(e.target.value, header)}
                  >
                    {FIELD_OPTIONS.map(f => (
                      <option key={f} value={f}>{FIELD_LABELS[f]}</option>
                    ))}
                  </select>
                </div>
              ))}

              {fileData.rows.length > 0 && (
                <>
                  <div className="separator" style={{ margin: '12px 0' }} />
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Preview (first {fileData.rows.length} rows)
                  </div>
                  <div className="preview-table-wrap">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          {fileData.headers.map(h => <th key={h}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {fileData.rows.map((row, i) => (
                          <tr key={i}>
                            {fileData.headers.map(h => <td key={h}>{row[h]}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {step === 'importing' && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
              <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: 12 }}>
                Importing contacts...
              </div>
            </div>
          )}

          {step === 'done' && importResult && (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
              <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 12 }}>
                {importResult.count.toLocaleString()} agents imported
              </div>
              <div style={{
                border: '2px solid', borderTopColor: 'var(--border-sh)', borderLeftColor: 'var(--border-sh)',
                borderRightColor: 'var(--border-hi)', borderBottomColor: 'var(--border-hi)',
                background: 'var(--win-white)', padding: '8px 12px', textAlign: 'left', fontSize: 11,
              }}>
                <div style={{ marginBottom: 4 }}>
                  ✅ <strong>{importResult.count - (importResult.alreadyKnown || 0) - (importResult.optedOut || 0) - (importResult.alreadyBlasted || 0)}</strong> new contacts — ready to blast
                </div>
                {importResult.alreadyBlasted > 0 && (
                  <div style={{ marginBottom: 4, color: '#884400' }}>
                    🔄 <strong>{importResult.alreadyBlasted}</strong> already texted in a prior campaign — skipped
                  </div>
                )}
                {importResult.alreadyKnown > 0 && (
                  <div style={{ marginBottom: 4, color: '#884400' }}>
                    🤝 <strong>{importResult.alreadyKnown}</strong> already in your network — skipped from blasts automatically
                  </div>
                )}
                {importResult.optedOut > 0 && (
                  <div style={{ marginBottom: 4, color: '#880000' }}>
                    🚫 <strong>{importResult.optedOut}</strong> previously opted out (STOP) — permanently excluded
                  </div>
                )}
                {importResult.extensionFiltered > 0 && (
                  <div style={{ color: '#884400' }}>
                    🏢 <strong>{importResult.extensionFiltered}</strong> brokerage/office numbers removed (had extension)
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === 'pick' && (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}
          {step === 'map' && (
            <>
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleImport}>
                Import {fileData?.totalRows?.toLocaleString()} Contacts →
              </button>
            </>
          )}
          {step === 'done' && (
            <button className="btn btn-primary" onClick={() => onDone(importResult.listId)}>
              View List
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
