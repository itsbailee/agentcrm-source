import React, { useState, useEffect, useRef, useCallback } from 'react';
import { play } from '../sounds.js';

const CATEGORY_OPTIONS = [
  { value: 'new',            label: '🔵 New'            },
  { value: 'hot_lead',       label: '🔥 Hot Lead'       },
  { value: 'follow_up',      label: '⏰ Follow Up'       },
  { value: 'callback',       label: '📞 Callback'        },
  { value: 'not_interested', label: '❄️ Not Interested'  },
];

function formatTime(dateStr) {
  if (!dateStr) return '';
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const msgET = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayStart = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate());
  const msgStart  = new Date(msgET.getFullYear(), msgET.getMonth(), msgET.getDate());
  const daysDiff  = Math.round((todayStart - msgStart) / 86400000);

  if (daysDiff === 0) return time;

  const mm = String(msgET.getMonth() + 1).padStart(2, '0');
  const dd = String(msgET.getDate()).padStart(2, '0');
  const dateLabel = `${mm}/${dd}`;
  const relLabel  = daysDiff === 1 ? 'Yesterday' : `${daysDiff} Days Ago`;

  return `${dateLabel} · ${relLabel} · ${time}`;
}

// Classic AIM warning meter (green bars)
function WarningMeter() {
  return (
    <div className="warning-meter" title="Signal strength">
      <div style={{ fontSize: 9, color: '#808080', fontFamily: 'var(--font-ui)', marginBottom: 1 }}>
        ||||||||||||
      </div>
      <div className="warning-bar">
        {[1,2,3,4,5,6,7,8,9,10].map(i => (
          <div key={i} className="warning-segment" style={{ height: 4 + i }} />
        ))}
      </div>
    </div>
  );
}

export default function ChatWindow({ conversation, onCategoryChange, onMessageSent, onArchive, draft, onDraftChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(draft || '');
  const [sending, setSending] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [forwardEnabled, setForwardEnabled] = useState(!!conversation.forward_enabled);
  const messagesEndRef = useRef(null);
  const messagesListRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  const displayName = conversation.name || conversation.phone;
  const isPhoneOnly = !conversation.name || conversation.name === conversation.phone;
  const agentFirst = conversation.first_name || conversation.name?.split(' ')[0] || 'Agent';
  const location = [conversation.city, conversation.state].filter(Boolean).join(', ');

  const startRename = () => {
    setNameInput(isPhoneOnly ? '' : displayName);
    setEditingName(true);
  };

  const commitRename = async () => {
    const trimmed = nameInput.trim();
    if (trimmed) {
      await window.api.renameContact({ contactId: conversation.contact_id, name: trimmed });
      conversation.name = trimmed;
      conversation.first_name = trimmed.split(' ')[0];
      onMessageSent?.();
    }
    setEditingName(false);
  };

  const handleNameKey = (e) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') setEditingName(false);
  };

  useEffect(() => {
    setForwardEnabled(!!conversation.forward_enabled);
  }, [conversation.id, conversation.forward_enabled]);

  const toggleForward = async () => {
    const next = !forwardEnabled;
    setForwardEnabled(next);
    await window.api.setConversationForward({ convId: conversation.id, enabled: next });
  };

  const loadMessages = useCallback(async () => {
    const data = await window.api.getMessages(conversation.id);
    setMessages(data);
  }, [conversation.id]);

  useEffect(() => {
    loadMessages();
    const cleanup = window.api.onNewMessages(() => loadMessages());
    const interval = setInterval(loadMessages, 30000);
    return () => { cleanup(); clearInterval(interval); };
  }, [loadMessages]);

  // Reset auto-scroll when switching conversations
  useEffect(() => { shouldAutoScrollRef.current = true; }, [conversation.id]);

  const handleMessagesScroll = () => {
    const el = messagesListRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages]);

  const handleSend = async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setInput('');
    onDraftChange?.('');
    try {
      await window.api.sendMessage({ convId: conversation.id, body });
      play('imsend');
      shouldAutoScrollRef.current = true;
      await loadMessages();
      onMessageSent?.();
    } catch (e) {
      alert('Send failed: ' + e.message);
      setInput(body);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="chat-window">
      {/* AIM "Instant Message" title bar */}
      <div className="chat-header">
        <span className="chat-header-icon">💬</span>
        {editingName ? (
          <input
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleNameKey}
            placeholder="Enter name..."
            style={{
              fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 'bold',
              background: 'transparent', border: 'none', borderBottom: '1px solid #fff',
              color: '#fff', outline: 'none', width: 180,
            }}
          />
        ) : (
          <span
            className="chat-header-title"
            onClick={startRename}
            title={isPhoneOnly ? 'Click to add name' : 'Click to rename'}
            style={{ cursor: 'pointer', borderBottom: isPhoneOnly ? '1px dashed rgba(255,255,255,0.5)' : 'none' }}
          >
            {displayName} – Instant Message
            {isPhoneOnly && <span style={{ fontSize: 10, marginLeft: 6, opacity: 0.7 }}>✎ add name</span>}
          </span>
        )}
        <div className="chat-header-controls">
          {onArchive && (
            <button
              onClick={() => onArchive(conversation.id)}
              title="Archive this conversation"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 10,
                fontFamily: 'var(--font-ui)',
                color: 'rgba(255,255,255,0.6)',
                padding: '0 4px',
                letterSpacing: '0.02em',
              }}
            >
              delete
            </button>
          )}
          <button
            onClick={toggleForward}
            title={forwardEnabled ? 'Forwarding to your cell — click to disable' : 'Forward messages to your cell when away (set Forward-to number in Settings first)'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              padding: '0 4px',
              opacity: forwardEnabled ? 1 : 0.55,
              filter: forwardEnabled ? 'none' : 'grayscale(1)',
              transition: 'opacity 0.15s, filter 0.15s',
            }}
          >
            🔔
          </button>
          <select
            className="category-select"
            value={conversation.category || 'new'}
            onChange={e => onCategoryChange(conversation.id, e.target.value)}
          >
            {CATEGORY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Sub-header: brokerage / location — like AIM's "warning level" bar */}
      <div className="chat-sub-header">
        <span>
          {[conversation.brokerage, location].filter(Boolean).join(' · ') || conversation.phone}
        </span>
        <span style={{ color: '#808080' }}>Agent's Warning Level: 0%</span>
      </div>

      {/* Chat area — white, Times New Roman, "Name: message" format */}
      <div className="messages-list" ref={messagesListRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 ? (
          <div style={{ color: '#808080', fontSize: 11, fontFamily: 'var(--font-ui)' }}>
            No messages yet.
          </div>
        ) : (
          messages.map(msg => {
            const isOutbound = msg.direction === 'outbound';
            const senderLabel = isOutbound ? 'You' : agentFirst;
            const mediaUrls = msg.media_urls ? JSON.parse(msg.media_urls) : [];
            return (
              <div key={msg.id} className="chat-msg">
                <span className={`chat-msg-sender ${isOutbound ? 'me' : 'them'}`}>
                  {senderLabel}:
                </span>{' '}
                {msg.body && <span className="chat-msg-body">{msg.body}</span>}
                {mediaUrls.map((filePath, i) => (
                  <div key={i} style={{ marginTop: 4 }}>
                    <img
                      src={`file://${filePath}`}
                      alt="MMS"
                      style={{ maxWidth: '100%', maxHeight: 280, border: '1px solid var(--border-sh)', cursor: 'pointer', display: 'block' }}
                      onClick={() => window.api.shellOpenExternal(`file://${filePath}`)}
                    />
                  </div>
                ))}
                <span className="chat-msg-time">({formatTime(msg.created_at)})</span>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* AIM formatting toolbar */}
      <div className="chat-toolbar">
        <button className="toolbar-btn" title="Font size up" style={{ fontWeight: 'bold', fontSize: 13 }}>A</button>
        <button className="toolbar-btn" title="Font size down" style={{ fontSize: 9 }}>A</button>
        <div className="toolbar-sep" />
        <button className="toolbar-btn" style={{ fontWeight: 'bold' }}>B</button>
        <button className="toolbar-btn" style={{ fontStyle: 'italic' }}>I</button>
        <button className="toolbar-btn" style={{ textDecoration: 'underline' }}>U</button>
        <div className="toolbar-sep" />
        <button className="toolbar-btn" style={{ color: '#0000cc', textDecoration: 'underline', fontSize: 10 }}>link</button>
        <button className="toolbar-btn" title="Emoji">🙂</button>
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          className="message-input"
          placeholder={`Message ${agentFirst}...`}
          value={input}
          onChange={e => { setInput(e.target.value); onDraftChange?.(e.target.value); }}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
      </div>

      {/* AIM-style action button row */}
      <div className="chat-actions">
        <button className="aim-btn" style={{ flex: 1 }} title="Add to follow-up list"
          onClick={() => onCategoryChange(conversation.id, 'follow_up')}>
          <span className="aim-btn-icon">⏰</span>
          <span className="aim-btn-label">Follow Up</span>
        </button>
        <button className="aim-btn" style={{ flex: 1 }} title="Mark as hot lead"
          onClick={() => onCategoryChange(conversation.id, 'hot_lead')}>
          <span className="aim-btn-icon">🔥</span>
          <span className="aim-btn-label">Hot Lead</span>
        </button>
        <button className="aim-btn" style={{ flex: 1 }} title="Schedule callback"
          onClick={() => onCategoryChange(conversation.id, 'callback')}>
          <span className="aim-btn-icon">📞</span>
          <span className="aim-btn-label">Callback</span>
        </button>
        <button className="aim-btn" style={{ flex: 1 }} title="Mark not interested"
          onClick={() => onCategoryChange(conversation.id, 'not_interested')}>
          <span className="aim-btn-icon">🚫</span>
          <span className="aim-btn-label">Cold</span>
        </button>
<button className="aim-btn" style={{ flex: 1, color: '#cc0000' }} title="Add to DNC list"
          onClick={async () => {
            if (!window.confirm(`Add ${conversation.name || conversation.phone} to DNC?\n\nThis will:\n• Block all future SMS\n• Remove from all campaigns\n• Prevent reimport`)) return;
            await window.api.dncAdd(conversation.phone, conversation.contact_id);
            onArchive?.(conversation.id);
          }}>
          <span className="aim-btn-icon">⛔</span>
          <span className="aim-btn-label">DNC</span>
        </button>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
          <WarningMeter />
          <button
            className="aim-btn aim-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{ flexShrink: 0 }}
          >
            <span className="aim-btn-icon">📨</span>
            <span className="aim-btn-label">{sending ? '...' : 'Send'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
