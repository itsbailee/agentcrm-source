import React, { useState, useEffect, useCallback, useRef } from 'react';
import ChatWindow from './ChatWindow.jsx';
import ResizableSplit from './ResizableSplit.jsx';
import { play } from '../sounds.js';

// Mirrors twilio.normalizePhone for client-side preview (no IPC needed)
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (String(raw).startsWith('+')) return String(raw).replace(/[^+\d]/g, '');
  if (digits.length > 0) return `+${digits}`;
  return null;
}

function NewConversationModal({ onClose, onCreated }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const preview = normalizePhone(phone);
  const digits = phone.replace(/\D/g, '');
  const phoneValid = digits.length >= 10;

  const handleSubmit = async () => {
    if (!phone.trim()) { setError('Enter a phone number.'); return; }
    if (!phoneValid) { setError('Need at least 10 digits.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const conv = await window.api.startManualConversation({ phone: phone.trim(), name: name.trim() || null });
      play('buddyin');
      onCreated(conv);
    } catch (e) {
      setError(e.message || 'Failed to start conversation.');
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 360 }}>
        <div className="modal-header">
          <span className="modal-title">💬 New Conversation</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}

          <div className="form-group">
            <label className="form-label">Phone Number</label>
            <input
              className="form-input"
              value={phone}
              onChange={e => { setPhone(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              placeholder="(727) 412-0832 or 7274120832"
              autoFocus
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            {phone && (
              <div className="form-hint" style={{ color: phoneValid ? '#006600' : '#886600', fontFamily: 'var(--font-mono)' }}>
                {phoneValid ? `→ ${preview}` : `${digits.length}/10 digits`}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Name <span style={{ color: 'var(--win-dark)', fontWeight: 'normal' }}>(optional)</span></label>
            <input
              className="form-input"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="John Smith"
            />
            <div className="form-hint">Can be added or edited later. Defaults to the phone number.</div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !phoneValid}
          >
            {submitting ? 'Starting...' : '💬 Start Conversation'}
          </button>
        </div>
      </div>
    </div>
  );
}

const CATEGORIES = {
  new:            { label: 'NEW',          color: 'var(--title-b)' },
  hot_lead:       { label: 'HOT LEADS',    color: '#cc4400'        },
  follow_up:      { label: 'FOLLOW UPS',   color: '#886600'        },
  callback:       { label: 'CALLBACKS',    color: '#553388'        },
  not_interested: { label: 'COLD',         color: 'var(--win-dark)'},
};

const CAT_ORDER = ['new', 'hot_lead', 'follow_up', 'callback', 'not_interested'];

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function ConversationsTab({ onReadUpdate }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [collapsed, setCollapsed] = useState(new Set());
  const [dragOverGroup, setDragOverGroup] = useState(null);
  const [showNewConv, setShowNewConv] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const draftsRef = useRef({});
  const dragConvId = useRef(null);
  const selectedRef = useRef(null);
  const archivedIds = useRef(new Set());

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const loadConversations = useCallback(async () => {
    const data = await window.api.getConversations();
    setConversations(data.filter(c => !archivedIds.current.has(c.id)));
  }, []);

  useEffect(() => {
    window.api.getSettings().then(s => setAiEnabled(s.aiEnabled === 'true'));
  }, []);

  useEffect(() => {
    loadConversations();
    const cleanup = window.api.onNewMessages(async () => {
      play('imrcv');
      await loadConversations();
      if (selectedRef.current) {
        await window.api.markRead(selectedRef.current.id);
        loadConversations();
        onReadUpdate?.();
      }
    });
    const interval = setInterval(loadConversations, 30000);
    return () => { cleanup(); clearInterval(interval); };
  }, []);

  const handleSelect = async (conv) => {
    setSelected(conv);
    if (conv.unread_count > 0) {
      await window.api.markRead(conv.id);
      loadConversations();
      onReadUpdate?.();
    }
  };

  const handleArchive = async (convId) => {
    archivedIds.current.add(convId);
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (selected?.id === convId) setSelected(null);
    await window.api.archiveConversation(convId);
    // DB committed — future getConversations won't include it, safe to remove from guard set
    archivedIds.current.delete(convId);
  };

  const handleCategoryChange = async (convId, category) => {
    // Auto-advance to next conversation when categorizing the selected one
    if (selected?.id === convId) {
      const allFlat = CAT_ORDER.flatMap(cat => conversations.filter(c => (c.category || 'new') === cat));
      const idx = allFlat.findIndex(c => c.id === convId);
      const next = allFlat[idx + 1] || allFlat[idx - 1] || null;
      await window.api.updateCategory({ convId, category });
      setConversations(prev => prev.map(c => c.id === convId ? { ...c, category } : c));
      if (next) handleSelect(next);
      else setSelected(prev => ({ ...prev, category }));
    } else {
      await window.api.updateCategory({ convId, category });
      setConversations(prev => prev.map(c => c.id === convId ? { ...c, category } : c));
    }
    if (category === 'not_interested') play('buddyout');
    else if (category === 'hot_lead') play('buddyin');
  };

  const toggleCollapse = (catKey) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(catKey) ? next.delete(catKey) : next.add(catKey);
      return next;
    });
  };

  // Drag handlers
  const onDragStart = (e, convId) => {
    dragConvId.current = convId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(convId));
  };

  const onDragOver = (e, catKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverGroup(catKey);
  };

  const onDragLeave = (e) => {
    // Only clear if leaving the group header entirely
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverGroup(null);
    }
  };

  const onDrop = async (e, catKey) => {
    e.preventDefault();
    setDragOverGroup(null);
    const convId = dragConvId.current;
    if (convId) await handleCategoryChange(convId, catKey);
    dragConvId.current = null;
  };

  const handleToggleAi = async () => {
    const next = !aiEnabled;
    setAiEnabled(next);
    await window.api.saveSettings({ aiEnabled: next ? 'true' : 'false' });
  };

  // Group conversations by category
  const groups = {};
  conversations.forEach(conv => {
    const cat = conv.category || 'new';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(conv);
  });

  return (
    <>
      <div className="tab-header">
        <div className="tab-title">Conversations</div>
        <div className="tab-toolbar">
          <span style={{ fontSize: 10, color: 'var(--win-dark)' }}>
            {conversations.length} active · auto-refreshes every 30s
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowNewConv(true)} title="Start a new conversation with any number">
            + New
          </button>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 4 }}
            onClick={() => window.api.pollNow().then(loadConversations)}>
            ↻ Refresh
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 4 }}
            onClick={handleToggleAi}
            title="Auto-sort incoming 'no' replies to Cold when enabled"
          >
            AI: {aiEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <ResizableSplit
        defaultLeftWidth={210}
        minLeft={140}
        minRight={300}
        storageKey="conversations"
        left={
          <div className="buddy-list">
            <div className="buddy-list-header">
              <span>🏃</span>
              <span>Agent List ({conversations.length})</span>
            </div>

            <div style={{ padding: '3px 4px', borderBottom: '1px solid var(--border-sh)', background: 'var(--win-gray)' }}>
              <input
                className="search-input"
                style={{ width: '100%', fontSize: 11 }}
                placeholder="🔍 Search agents & messages..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
            {conversations.length === 0 ? (
              <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--win-dark)', fontSize: 11 }}>
                No responses yet.<br />Replies from your campaigns will appear here.
              </div>
            ) : searchQuery.trim() ? (() => {
              const q = searchQuery.trim().toLowerCase();
              const filtered = conversations.filter(c =>
                (c.name || '').toLowerCase().includes(q) ||
                (c.phone || '').toLowerCase().includes(q) ||
                (c.brokerage || '').toLowerCase().includes(q) ||
                (c.last_message || '').toLowerCase().includes(q)
              );
              if (filtered.length === 0) return (
                <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--win-dark)', fontSize: 11 }}>
                  No results for "{searchQuery}"
                </div>
              );
              return filtered.map(conv => (
                <div
                  key={conv.id}
                  className={`buddy-item${selected?.id === conv.id ? ' active' : ''}`}
                  onClick={() => handleSelect(conv)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="buddy-icon">🏃</span>
                  <div className="buddy-info">
                    <div className="buddy-name">{conv.name || conv.phone}</div>
                    <div className="buddy-preview">{conv.last_message || conv.brokerage || '...'}</div>
                  </div>
                  <div className="buddy-meta">
                    <span className="buddy-time">{timeAgo(conv.last_message_at)}</span>
                    {conv.unread_count > 0 && <span className="buddy-unread">{conv.unread_count}</span>}
                  </div>
                </div>
              ));
            })() : CAT_ORDER.map(catKey => {
              const convs = groups[catKey];
              if (!convs || convs.length === 0) return null;
              const catInfo = CATEGORIES[catKey];
              const isCollapsed = collapsed.has(catKey);
              const isDropTarget = dragOverGroup === catKey;

              return (
                <div
                  key={catKey}
                  onDragOver={e => onDragOver(e, catKey)}
                  onDragLeave={onDragLeave}
                  onDrop={e => onDrop(e, catKey)}
                  style={{
                    outline: isDropTarget ? '2px dashed #0066cc' : undefined,
                    background: isDropTarget ? 'rgba(0,80,180,0.07)' : undefined,
                  }}
                >
                  <div
                    className="buddy-group-header"
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleCollapse(catKey)}
                  >
                    <span style={{ fontSize: 9, color: catInfo.color, transition: 'transform 0.15s', display: 'inline-block', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▼</span>
                    <span style={{ color: catInfo.color }}>{catInfo.label}</span>
                    <span className="buddy-group-count">({convs.length})</span>
                    {isDropTarget && (
                      <span style={{ marginLeft: 4, fontSize: 10, color: '#0066cc', fontWeight: 'normal' }}>drop here</span>
                    )}
                  </div>

                  {!isCollapsed && convs.map(conv => (
                    <div
                      key={conv.id}
                      className={`buddy-item${selected?.id === conv.id ? ' active' : ''}`}
                      draggable
                      onDragStart={e => onDragStart(e, conv.id)}
                      onClick={() => handleSelect(conv)}
                      title="Drag to move to a different category"
                      style={{ cursor: 'grab' }}
                    >
                      <span className="buddy-icon">🏃</span>
                      <div className="buddy-info">
                        <div className="buddy-name">{conv.name || conv.phone}</div>
                        <div className="buddy-preview">{conv.last_message || conv.brokerage || '...'}</div>
                      </div>
                      <div className="buddy-meta">
                        <span className="buddy-time">{timeAgo(conv.last_message_at)}</span>
                        {conv.unread_count > 0 && (
                          <span className="buddy-unread">{conv.unread_count}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            </div>
          </div>
        }
        right={
          selected ? (
            <ChatWindow
              key={selected.id}
              conversation={selected}
              onCategoryChange={handleCategoryChange}
              onMessageSent={loadConversations}
              onArchive={handleArchive}
              draft={draftsRef.current[selected.id] || ''}
              onDraftChange={(text) => { draftsRef.current[selected.id] = text; }}
            />
          ) : (
            <div className="chat-empty" style={{ flex: 1 }}>
              <div className="chat-empty-icon">💬</div>
              <div className="chat-empty-text">Select a conversation</div>
              <div style={{ fontSize: 11, color: 'var(--win-dark)', marginTop: 4, fontFamily: 'var(--font-ui)' }}>
                Drag contacts between groups · Click ▼ to collapse
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 16 }}
                onClick={() => setShowNewConv(true)}
              >
                + New Conversation
              </button>
            </div>
          )
        }
      />

      {showNewConv && (
        <NewConversationModal
          onClose={() => setShowNewConv(false)}
          onCreated={async (conv) => {
            setShowNewConv(false);
            await loadConversations();
            setSelected(conv);
          }}
        />
      )}
    </>
  );
}
