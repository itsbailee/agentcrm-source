import React, { useState, useRef, useCallback } from 'react';

export default function ResizableSplit({ left, right, defaultLeftWidth = 220, minLeft = 140, minRight = 200, storageKey }) {
  const [leftWidth, setLeftWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(`split:${storageKey}`);
      if (saved) return Number(saved);
    }
    return defaultLeftWidth;
  });
  const containerRef = useRef(null);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      if (!containerRef.current) return;
      const maxLeft = containerRef.current.offsetWidth - minRight - 10;
      const newW = Math.max(minLeft, Math.min(startW + (e.clientX - startX), maxLeft));
      setLeftWidth(newW);
      if (storageKey) localStorage.setItem(`split:${storageKey}`, String(Math.round(newW)));
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftWidth, minLeft, minRight, storageKey]);

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', padding: 4 }}>
      {/* Left panel */}
      <div style={{ width: leftWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {left}
      </div>

      {/* Draggable sash */}
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize"
        style={{
          width: 6,
          flexShrink: 0,
          cursor: 'col-resize',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          background: 'var(--win-gray)',
          borderLeft: '1px solid var(--border-sh)',
          borderRight: '1px solid var(--border-hi)',
          margin: '0 2px',
        }}
      >
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} style={{ width: 2, height: 2, background: 'var(--border-sh)' }} />
        ))}
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}
