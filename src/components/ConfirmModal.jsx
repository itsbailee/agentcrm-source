import React from 'react';

/**
 * Classic Windows 98-style confirmation dialog.
 * Props:
 *   title      – dialog title bar text
 *   icon       – emoji icon shown in body (default ⚠️)
 *   message    – primary message (string or JSX)
 *   detail     – secondary detail text (optional)
 *   confirmLabel – OK button label (default "OK")
 *   cancelLabel  – Cancel button label (default "Cancel")
 *   dangerous  – if true, OK button gets danger styling
 *   onConfirm  – called on OK
 *   onCancel   – called on Cancel or overlay click
 */
export default function ConfirmModal({
  title = 'Confirm',
  icon = '⚠️',
  message,
  detail,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  dangerous = false,
  onConfirm,
  onCancel,
}) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel?.()}>
      <div className="modal" style={{ minWidth: 340, maxWidth: 400 }}>
        <div className="modal-header">
          <span className="modal-title">
            <span style={{ marginRight: 4 }}>⚠</span>
            {title}
          </span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="modal-body" style={{ padding: '16px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            {/* Big Windows-style warning icon */}
            <div style={{
              fontSize: 32,
              lineHeight: 1,
              flexShrink: 0,
              filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.2))',
            }}>
              {icon}
            </div>
            <div>
              <div style={{
                fontSize: 11,
                color: 'var(--win-black)',
                lineHeight: 1.6,
                fontFamily: 'var(--font-ui)',
              }}>
                {message}
              </div>
              {detail && (
                <div style={{
                  fontSize: 11,
                  color: 'var(--win-dark)',
                  marginTop: 6,
                  fontFamily: 'var(--font-ui)',
                }}>
                  {detail}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'center', gap: 8 }}>
          <button
            className={`btn btn-primary${dangerous ? ' btn-danger' : ''}`}
            onClick={onConfirm}
            style={{ minWidth: 80 }}
          >
            {confirmLabel}
          </button>
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            style={{ minWidth: 80 }}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
