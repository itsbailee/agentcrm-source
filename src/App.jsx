import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar.jsx';
import LeadsTab from './components/LeadsTab.jsx';
import CampaignsTab from './components/CampaignsTab.jsx';
import ConversationsTab from './components/ConversationsTab.jsx';
import NotesTab from './components/NotesTab.jsx';
import SubmitLeadTab from './components/SubmitLeadTab.jsx';
import SettingsTab from './components/SettingsTab.jsx';

const MENU_ITEMS = [
  { id: 'leads',         label: 'Leads'         },
  { id: 'campaigns',     label: 'Campaigns'     },
  { id: 'conversations', label: 'Conversations' },
  { id: 'submit-lead',   label: 'Submit a Lead' },
  { id: 'notes',         label: 'Notes'         },
  { id: 'settings',      label: 'Settings'      },
];

export default function App() {
  const [tab, setTab] = useState('leads');
  const [unreadCount, setUnreadCount] = useState(0);
  const [twilioStatus, setTwilioStatus] = useState('unknown');
  const [settings, setSettings] = useState({});
  const [campaignsReloadKey, setCampaignsReloadKey] = useState(0);
  const [showWelcome, setShowWelcome] = useState(false);

  const refreshUnread = useCallback(async () => {
    try {
      const count = await window.api.getTotalUnread();
      setUnreadCount(count);
    } catch (_) {}
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await window.api.getSettings();
      setSettings(s);
      setTwilioStatus(s.accountSid && s.authToken && s.phoneNumber ? 'online' : 'offline');
    } catch (_) {
      setTwilioStatus('offline');
    }
  }, []);

  useEffect(() => {
    loadSettings();
    refreshUnread();
    setShowWelcome(true);
    const hideTimer = setTimeout(() => setShowWelcome(false), 2500);
    const cleanup = window.api.onNewMessages(() => refreshUnread());
    return () => { cleanup(); clearTimeout(hideTimer); };
  }, []);

  return (
    <div className="app-shell">
      {/* AIM-style blue gradient title bar */}
      <div className="title-bar">
        <span className="title-bar-icon">🏃</span>
        <span className="title-bar-logo">AgentCRM</span>
        <span className="title-bar-tagline">— Real Estate Outreach Tool</span>
        <div className="title-bar-status">
          <span className={`status-dot ${twilioStatus === 'online' ? 'online' : 'offline'}`} />
          <span>Twilio: {twilioStatus === 'online' ? 'Connected' : 'Offline'}</span>
        </div>
      </div>

      {/* Windows-style menu bar */}
      <div className="menu-bar">
        {MENU_ITEMS.map(item => (
          <div
            key={item.id}
            className={`menu-item${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'conversations' && unreadCount > 0 && (
              <span style={{
                marginLeft: 4,
                background: '#ff8000',
                color: 'white',
                fontSize: 9,
                fontWeight: 'bold',
                padding: '0 3px',
                borderRadius: 1,
              }}>
                {unreadCount}
              </span>
            )}
          </div>
        ))}
        <div className="menu-bar-right">
          {twilioStatus === 'online'
            ? '● Online'
            : '○ Configure Twilio in Settings'}
        </div>
      </div>

      {showWelcome && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, pointerEvents: 'none',
        }}>
          <div style={{
            background: 'var(--bg2)',
            border: '2px solid',
            borderTopColor: 'var(--border-hi)',
            borderLeftColor: 'var(--border-hi)',
            borderRightColor: 'var(--border-sh)',
            borderBottomColor: 'var(--border-sh)',
            padding: '18px 36px',
            textAlign: 'center',
            boxShadow: '4px 4px 0 #000',
          }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>🏃</div>
            <div style={{
              fontFamily: 'var(--font-ui)', fontSize: 22, fontWeight: 'bold',
              color: 'var(--title-b)', letterSpacing: 1,
            }}>
              Welcome!
            </div>
          </div>
        </div>
      )}

      <div className="main-body">
        <Sidebar
          activeTab={tab}
          onTabChange={setTab}
          unreadCount={unreadCount}
          twilioStatus={twilioStatus}
        />
        <div className="main-content">
          {tab === 'leads' && <LeadsTab />}
          {tab === 'campaigns' && (
            <CampaignsTab
              settings={settings}
              onBlastComplete={refreshUnread}
              onNavigate={setTab}
              reloadKey={campaignsReloadKey}
            />
          )}
          {tab === 'conversations' && (
            <ConversationsTab onReadUpdate={refreshUnread} />
          )}
          {tab === 'notes' && <NotesTab />}
          {tab === 'submit-lead' && <SubmitLeadTab />}
          {tab === 'settings' && (
            <SettingsTab onSave={() => { loadSettings(); setCampaignsReloadKey(k => k + 1); }} />
          )}
        </div>
      </div>
    </div>
  );
}
