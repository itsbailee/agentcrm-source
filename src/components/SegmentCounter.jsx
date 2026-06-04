import React from 'react';
import { analyzeMessage } from '../utils/segments.js';

export default function SegmentCounter({ text, style }) {
  const { chars, encodedLen, segments, isGsm, limit, hasExtended } = analyzeMessage(text);

  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginTop: 4, lineHeight: 1.7, ...style }}>
      <span style={{ color: 'var(--win-dark)', fontWeight: 'bold' }}>
        {chars}/{limit} chars · {segments} segment{segments !== 1 ? 's' : ''}
        {hasExtended && ` (${encodedLen} encoded)`}
      </span>
      {!isGsm && (
        <span style={{ color: '#886600', marginLeft: 8 }}>
          ⚠ Non-GSM chars detected (emoji, smart quotes, etc.) — UCS-2 encoding, 70-char limit
        </span>
      )}
      {hasExtended && (
        <span style={{ color: '#886600', marginLeft: 8 }}>
          Some chars (€ [ ] {'{'} {'}'} \ ^ ~ |) count as 2
        </span>
      )}
    </div>
  );
}
