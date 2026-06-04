const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;

function getDbPath() {
  return path.join(app.getPath('userData'), 'agent-crm.db');
}

function init() {
  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER REFERENCES lead_lists(id) ON DELETE CASCADE,
      name TEXT,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      brokerage TEXT,
      city TEXT,
      state TEXT,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      response_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS campaign_lists (
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      list_id INTEGER REFERENCES lead_lists(id) ON DELETE CASCADE,
      PRIMARY KEY (campaign_id, list_id)
    );

    CREATE TABLE IF NOT EXISTS campaign_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER REFERENCES campaigns(id),
      contact_id INTEGER REFERENCES contacts(id),
      status TEXT DEFAULT 'pending',
      sent_at DATETIME,
      twilio_sid TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER REFERENCES contacts(id) UNIQUE,
      category TEXT DEFAULT 'new',
      last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      unread_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id),
      twilio_sid TEXT UNIQUE,
      body TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS excluded_phones (
      phone TEXT PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id),
      excluded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stopped_numbers (
      phone TEXT PRIMARY KEY,
      stopped_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations for existing DBs
  const ccCols = db.prepare("PRAGMA table_info(campaign_contacts)").all().map(r => r.name);
  if (!ccCols.includes('delivery_status')) {
    db.prepare("ALTER TABLE campaign_contacts ADD COLUMN delivery_status TEXT").run();
  }
  if (!ccCols.includes('normalized_phone')) {
    db.prepare("ALTER TABLE campaign_contacts ADD COLUMN normalized_phone TEXT").run();
  }
  const campaignCols = db.prepare("PRAGMA table_info(campaigns)").all().map(r => r.name);
  if (!campaignCols.includes('delivered_count')) {
    db.prepare("ALTER TABLE campaigns ADD COLUMN delivered_count INTEGER DEFAULT 0").run();
  }
  if (!campaignCols.includes('max_sends')) {
    db.prepare("ALTER TABLE campaigns ADD COLUMN max_sends INTEGER").run();
  }

  // DB-level duplicate send protection — by contact_id (existing) and by normalized phone (durable)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique ON campaign_contacts(campaign_id, contact_id)`);
  // Partial index: only enforced when normalized_phone is set (i.e., successful sends only)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_phone_dedup ON campaign_contacts(campaign_id, normalized_phone) WHERE normalized_phone IS NOT NULL`);

  // Audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Whitelisted phones always bypass exclusion/blast/stopped checks
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelisted_phones (
      phone TEXT PRIMARY KEY
    )
  `);
  db.prepare('INSERT OR IGNORE INTO whitelisted_phones (phone) VALUES (?)').run('+17274120832');

  // Category change history — tracks every hot→follow-up style transition per conversation
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_category_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      from_category TEXT,
      to_category TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: per-conversation message forwarding
  const convCols2 = db.prepare("PRAGMA table_info(conversations)").all().map(r => r.name);
  if (!convCols2.includes('forward_enabled')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN forward_enabled INTEGER DEFAULT 0").run();
  }
  if (!convCols2.includes('archived')) {
    db.prepare("ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0").run();
  }

  // Migration: MMS media storage
  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(r => r.name);
  if (!msgCols.includes('media_urls')) {
    db.prepare("ALTER TABLE messages ADD COLUMN media_urls TEXT").run();
  }

  // Lead submissions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT DEFAULT '',
      asking_price TEXT DEFAULT '',
      is_off_market INTEGER DEFAULT 0,
      beds TEXT DEFAULT '',
      baths TEXT DEFAULT '',
      sqft TEXT DEFAULT '',
      description TEXT DEFAULT '',
      photo_paths TEXT DEFAULT '[]',
      extra1 TEXT DEFAULT '',
      extra2 TEXT DEFAULT '',
      extra3 TEXT DEFAULT '',
      tier1_sent_at DATETIME,
      tier2_sent_at DATETIME,
      tier3_sent_at DATETIME,
      final_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: extra details columns on existing lead_submissions
  const lsCols = db.prepare("PRAGMA table_info(lead_submissions)").all().map(r => r.name);
  if (!lsCols.includes('extra1')) db.prepare("ALTER TABLE lead_submissions ADD COLUMN extra1 TEXT DEFAULT ''").run();
  if (!lsCols.includes('extra2')) db.prepare("ALTER TABLE lead_submissions ADD COLUMN extra2 TEXT DEFAULT ''").run();
  if (!lsCols.includes('extra3')) db.prepare("ALTER TABLE lead_submissions ADD COLUMN extra3 TEXT DEFAULT ''").run();
  if (!lsCols.includes('contact_id')) db.prepare("ALTER TABLE lead_submissions ADD COLUMN contact_id INTEGER REFERENCES contacts(id)").run();
  if (!lsCols.includes('outcome')) db.prepare("ALTER TABLE lead_submissions ADD COLUMN outcome TEXT DEFAULT NULL").run();

  // Migration: notes sort_order and copy_count
  const noteCols = db.prepare("PRAGMA table_info(notes)").all().map(r => r.name);
  if (!noteCols.includes('sort_order')) {
    db.prepare("ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0").run();
    db.prepare("UPDATE notes SET sort_order = id").run();
  }
  if (!noteCols.includes('copy_count')) {
    db.prepare("ALTER TABLE notes ADD COLUMN copy_count INTEGER DEFAULT 0").run();
  }

  // Crash recovery: any campaign stuck in 'running' gets paused on startup
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE status = 'running'").run();

  // Default safety settings (only written if not already set)
  const defaults = {
    liveSmsEnabled: 'false',
    a2pApproved: 'false',
    killSwitch: 'false',
    dailyCap: '10000',
    firstBatchCap: '50',
  };
  const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    Object.entries(defaults).forEach(([k, v]) => insertDefault.run(k, v));
  })();

  return db;
}

// ── Settings ────────────────────────────────────────────────────────────────

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function saveSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}

function saveSettings(settings) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const saveMany = db.transaction((s) => {
    Object.entries(s).forEach(([k, v]) => stmt.run(k, v || ''));
  });
  saveMany(settings);
}

// ── Audit Log ───────────────────────────────────────────────────────────────

function logAudit(action, details) {
  try {
    db.prepare('INSERT INTO audit_log (action, details) VALUES (?, ?)').run(action, details ? JSON.stringify(details) : null);
  } catch (_) {}
}

function getAuditLog(limit = 200) {
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── Daily Cap ────────────────────────────────────────────────────────────────

function getDailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  const dateRow = getSetting('dailySendDate');
  if (dateRow !== today) return 0;
  return parseInt(getSetting('dailySendCount') || '0', 10);
}

function incrementDailyCount(n = 1) {
  const today = new Date().toISOString().slice(0, 10);
  const dateRow = getSetting('dailySendDate');
  const current = dateRow === today ? parseInt(getSetting('dailySendCount') || '0', 10) : 0;
  db.transaction(() => {
    saveSetting('dailySendDate', today);
    saveSetting('dailySendCount', String(current + n));
  })();
}

// ── Lead Lists ───────────────────────────────────────────────────────────────

function getLeadLists() {
  return db.prepare(`
    SELECT ll.*, COUNT(c.id) as contact_count
    FROM lead_lists ll
    LEFT JOIN contacts c ON c.list_id = ll.id
    GROUP BY ll.id
    ORDER BY ll.created_at DESC
  `).all();
}

function createLeadList(name) {
  const result = db.prepare('INSERT INTO lead_lists (name) VALUES (?)').run(name);
  return result.lastInsertRowid;
}

function deleteLeadList(listId) {
  db.prepare('DELETE FROM lead_lists WHERE id = ?').run(listId);
}

// ── Contacts ─────────────────────────────────────────────────────────────────

function getContacts(listId) {
  return db.prepare(`
    SELECT * FROM contacts WHERE list_id = ? ORDER BY name ASC
  `).all(listId);
}

function insertContacts(listId, contacts) {
  const stmt = db.prepare(`
    INSERT INTO contacts (list_id, name, first_name, last_name, phone, brokerage, city, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    rows.forEach(r => {
      stmt.run(listId, r.name, r.first_name, r.last_name, r.phone, r.brokerage, r.city, r.state);
    });
  });
  insertMany(contacts);
}

function searchAllContacts(query) {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT c.id, c.name, c.first_name, c.phone, c.brokerage, c.city, c.state, ll.name AS list_name
    FROM contacts c
    JOIN lead_lists ll ON ll.id = c.list_id
    WHERE c.name LIKE ? OR c.first_name LIKE ?
    ORDER BY c.name ASC
    LIMIT 100
  `).all(like, like);
}

function isPhoneExcluded(phone) {
  return !!db.prepare('SELECT 1 FROM excluded_phones WHERE phone = ?').get(phone);
}

function isPhoneWhitelisted(phone) {
  if (!phone) return false;
  return !!db.prepare('SELECT 1 FROM whitelisted_phones WHERE phone = ?').get(phone);
}

function addExcludedPhone(phone, contactId) {
  db.prepare('INSERT OR IGNORE INTO excluded_phones (phone, contact_id) VALUES (?, ?)').run(phone, contactId);
}

function updateContactStatus(contactId, status) {
  db.prepare('UPDATE contacts SET status = ? WHERE id = ?').run(status, contactId);
}

function findContactByPhone(phone) {
  return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

function getCampaigns() {
  return db.prepare(`
    SELECT c.*,
      GROUP_CONCAT(ll.name, ', ') as list_names,
      (
        SELECT COUNT(*) FROM campaign_contacts cc
        JOIN contacts co ON co.id = cc.contact_id
        WHERE cc.campaign_id = c.id AND co.phone IN (SELECT phone FROM stopped_numbers)
      ) as opt_out_count
    FROM campaigns c
    LEFT JOIN campaign_lists cl ON cl.campaign_id = c.id
    LEFT JOIN lead_lists ll ON ll.id = cl.list_id
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC
  `).all();
}

function createCampaign(name, message, listIds) {
  const insertCampaign = db.prepare('INSERT INTO campaigns (name, message) VALUES (?, ?)');
  const insertList = db.prepare('INSERT INTO campaign_lists (campaign_id, list_id) VALUES (?, ?)');

  let campaignId;
  db.transaction(() => {
    campaignId = insertCampaign.run(name, message).lastInsertRowid;
    listIds.forEach(lid => insertList.run(campaignId, lid));
  })();
  return campaignId;
}

function getCampaignContacts(campaignId) {
  return db.prepare(`
    SELECT c.*, cc.status as blast_status, cc.id as cc_id
    FROM contacts c
    JOIN campaign_lists cl ON cl.list_id = c.list_id
    LEFT JOIN campaign_contacts cc ON cc.contact_id = c.id AND cc.campaign_id = ?
    WHERE cl.campaign_id = ?
    AND (
      c.phone IN (SELECT phone FROM whitelisted_phones)
      OR (
        c.status NOT IN ('excluded', 'blasted')
        AND (c.phone IS NULL OR c.phone NOT IN (SELECT phone FROM excluded_phones))
        AND (c.phone IS NULL OR c.phone NOT IN (SELECT phone FROM stopped_numbers))
      )
    )
    AND (cc.status IS NULL OR cc.status = 'pending')
    ORDER BY c.id ASC
  `).all(campaignId, campaignId);
}

function addStoppedNumber(phone) {
  db.prepare('INSERT OR IGNORE INTO stopped_numbers (phone) VALUES (?)').run(phone);
  db.prepare('INSERT OR IGNORE INTO excluded_phones (phone) VALUES (?)').run(phone);
  // Mark any contact with this number as excluded
  db.prepare("UPDATE contacts SET status = 'excluded' WHERE phone = ?").run(phone);
}

function isPhoneStopped(phone) {
  return !!db.prepare('SELECT 1 FROM stopped_numbers WHERE phone = ?').get(phone);
}

function markImportedExclusions(listId) {
  const known = db.prepare(`
    UPDATE contacts SET status = 'excluded'
    WHERE list_id = ? AND phone IN (SELECT phone FROM excluded_phones) AND status = 'new'
      AND phone NOT IN (SELECT phone FROM whitelisted_phones)
  `).run(listId).changes;

  const stopped = db.prepare(`
    UPDATE contacts SET status = 'excluded'
    WHERE list_id = ? AND phone IN (SELECT phone FROM stopped_numbers)
      AND phone NOT IN (SELECT phone FROM whitelisted_phones)
  `).run(listId).changes;

  // Mark contacts whose phone was already successfully blasted in any prior campaign
  const alreadyBlasted = db.prepare(`
    UPDATE contacts SET status = 'blasted'
    WHERE list_id = ?
      AND phone IS NOT NULL
      AND phone IN (
        SELECT DISTINCT normalized_phone FROM campaign_contacts
        WHERE normalized_phone IS NOT NULL AND status = 'sent'
      )
      AND status = 'new'
      AND phone NOT IN (SELECT phone FROM whitelisted_phones)
  `).run(listId).changes;

  return { alreadyKnown: known, optedOut: stopped, alreadyBlasted };
}

function isPhoneSentInCampaign(campaignId, normalizedPhone) {
  if (!normalizedPhone) return false;
  return !!db.prepare(
    "SELECT 1 FROM campaign_contacts WHERE campaign_id = ? AND normalized_phone = ?"
  ).get(campaignId, normalizedPhone);
}

function recordBlastSent(campaignId, contactId, twilioSid, normalizedPhone) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status, sent_at, twilio_sid, normalized_phone)
    VALUES (?, ?, 'sent', datetime('now'), ?, ?)
  `).run(campaignId, contactId, twilioSid, normalizedPhone || null);
  if (result.changes > 0) {
    db.prepare("UPDATE contacts SET status = 'blasted' WHERE id = ?").run(contactId);
    db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId);
    incrementDailyCount(1);
  }
}

function recordBlastFailed(campaignId, contactId, error) {
  // INSERT OR IGNORE: never overwrite a 'sent' record with a failure
  // normalized_phone intentionally omitted — only successful sends set it
  const result = db.prepare(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status, error)
    VALUES (?, ?, 'failed', ?)
  `).run(campaignId, contactId, error);
  if (result.changes > 0) {
    db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId);
  }
}

function getCampaignSids(campaignId) {
  return db.prepare(`
    SELECT twilio_sid FROM campaign_contacts
    WHERE campaign_id = ? AND twilio_sid IS NOT NULL AND twilio_sid NOT LIKE 'DEMO-%'
  `).all(campaignId).map(r => r.twilio_sid);
}

function updateDeliveryStatus(twilioSid, deliveryStatus) {
  db.prepare(`
    UPDATE campaign_contacts SET delivery_status = ? WHERE twilio_sid = ?
  `).run(deliveryStatus, twilioSid);
}

function refreshCampaignDeliveredCount(campaignId) {
  const { delivered } = db.prepare(`
    SELECT COUNT(*) AS delivered FROM campaign_contacts
    WHERE campaign_id = ? AND delivery_status = 'delivered'
  `).get(campaignId);
  db.prepare('UPDATE campaigns SET delivered_count = ? WHERE id = ?').run(delivered, campaignId);
}

function getCampaignOptOutCount(campaignId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM campaign_contacts cc
    JOIN contacts co ON co.id = cc.contact_id
    WHERE cc.campaign_id = ? AND co.phone IN (SELECT phone FROM stopped_numbers)
  `).get(campaignId);
  return row.cnt;
}

function getCampaignBlastPreview(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);

  // All contacts in campaign lists (before exclusion filtering)
  const allContacts = db.prepare(`
    SELECT c.phone FROM contacts c
    JOIN campaign_lists cl ON cl.list_id = c.list_id
    WHERE cl.campaign_id = ?
  `).all(campaignId);

  const totalInLists = allContacts.length;
  let blockedCount = 0, invalidCount = 0, dedupCount = 0;
  const seenPhones = new Set();

  for (const { phone } of allContacts) {
    const n = phone;
    if (!n) { invalidCount++; continue; }
    if (seenPhones.has(n)) { dedupCount++; continue; }
    seenPhones.add(n);
    const isStopped = !!db.prepare('SELECT 1 FROM stopped_numbers WHERE phone = ?').get(n);
    const isExcluded = !!db.prepare('SELECT 1 FROM excluded_phones WHERE phone = ?').get(n);
    if (isStopped || isExcluded) blockedCount++;
  }

  const eligibleContacts = getCampaignContacts(campaignId);
  return {
    campaign,
    totalInLists,
    eligibleCount: eligibleContacts.length,
    blockedCount,
    invalidCount,
    dedupCount,
  };
}

function deleteCampaign(campaignId) {
  db.transaction(() => {
    db.prepare('DELETE FROM campaign_contacts WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM campaign_lists WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
  })();
}

function resetList(listId) {
  db.prepare(`
    UPDATE contacts SET status = 'new'
    WHERE list_id = ?
    AND status = 'blasted'
    AND phone NOT IN (SELECT phone FROM stopped_numbers)
  `).run(listId);
}

function resetCampaign(campaignId) {
  db.transaction(() => {
    // Reset contacts in this campaign's lists from 'blasted' → 'new' so they're eligible again.
    // Safe: other campaigns keep their own campaign_contacts records, which still exclude these contacts there.
    db.prepare(`
      UPDATE contacts SET status = 'new'
      WHERE status = 'blasted'
      AND phone NOT IN (SELECT phone FROM stopped_numbers)
      AND id IN (
        SELECT c.id FROM contacts c
        JOIN campaign_lists cl ON cl.list_id = c.list_id
        WHERE cl.campaign_id = ?
      )
    `).run(campaignId);
    // Clear all send records for this campaign
    db.prepare('DELETE FROM campaign_contacts WHERE campaign_id = ?').run(campaignId);
    // Reset stats and status
    db.prepare(`
      UPDATE campaigns
      SET status = 'draft', sent_count = 0, failed_count = 0,
          delivered_count = 0, response_count = 0, completed_at = NULL
      WHERE id = ?
    `).run(campaignId);
  })();
}

function completeCampaign(campaignId) {
  db.prepare(`
    UPDATE campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?
  `).run(campaignId);
}

function updateCampaignStatus(campaignId, status) {
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, campaignId);
}

// ── Conversations ─────────────────────────────────────────────────────────────

function getConversations() {
  return db.prepare(`
    SELECT cv.*, c.name, c.first_name, c.last_name, c.phone, c.brokerage, c.city, c.state,
      (SELECT body FROM messages WHERE conversation_id = cv.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT direction FROM messages WHERE conversation_id = cv.id ORDER BY created_at DESC LIMIT 1) as last_direction
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    WHERE cv.archived = 0
    ORDER BY cv.last_message_at DESC
  `).all();
}

function archiveConversation(convId) {
  db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(convId);
}

function unarchiveConversation(convId) {
  db.prepare('UPDATE conversations SET archived = 0 WHERE id = ?').run(convId);
}

function getOrCreateConversation(contactId) {
  let conv = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contactId);
  if (!conv) {
    const result = db.prepare(`
      INSERT INTO conversations (contact_id, last_message_at)
      VALUES (?, datetime('now'))
    `).run(contactId);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    // Auto-exclude this number from future blasts
    const contact = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(contactId);
    if (contact) addExcludedPhone(contact.phone, contactId);
    updateContactStatus(contactId, 'responded');
    db.prepare('UPDATE campaigns SET response_count = response_count + 1 WHERE id IN (SELECT campaign_id FROM campaign_contacts WHERE contact_id = ?)').run(contactId);
  }
  return conv;
}

function getMessages(conversationId) {
  return db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversationId);
}

function addMessage(conversationId, body, direction, twilioSid, mediaUrls) {
  const mediaJson = (mediaUrls && mediaUrls.length > 0) ? JSON.stringify(mediaUrls) : null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages (conversation_id, body, direction, twilio_sid, media_urls)
    VALUES (?, ?, ?, ?, ?)
  `).run(conversationId, body || '', direction, twilioSid || null, mediaJson);

  if (result.changes > 0) {
    db.prepare(`
      UPDATE conversations SET last_message_at = datetime('now'),
        unread_count = CASE WHEN ? = 'inbound' THEN unread_count + 1 ELSE unread_count END
      WHERE id = ?
    `).run(direction, conversationId);
  }
  return result.changes > 0; // true = new insert, false = already existed
}

function markConversationRead(conversationId) {
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
}

function updateConversationCategory(conversationId, category) {
  const current = db.prepare('SELECT category FROM conversations WHERE id = ?').get(conversationId);
  if (current && current.category !== category) {
    db.prepare(`
      INSERT INTO conversation_category_log (conversation_id, from_category, to_category)
      VALUES (?, ?, ?)
    `).run(conversationId, current.category, category);
  }
  db.prepare('UPDATE conversations SET category = ? WHERE id = ?').run(category, conversationId);
}

function setConversationForward(convId, enabled) {
  db.prepare('UPDATE conversations SET forward_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, convId);
}

function isConversationForwarding(convId) {
  const row = db.prepare('SELECT forward_enabled FROM conversations WHERE id = ?').get(convId);
  return row ? !!row.forward_enabled : false;
}

function getTotalUnread() {
  const row = db.prepare('SELECT SUM(unread_count) as total FROM conversations').get();
  return row ? (row.total || 0) : 0;
}

function getContactById(id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function findOrCreateManualContact(normalizedPhone, name) {
  let contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(normalizedPhone);
  if (!contact) {
    const trimmed = (name || '').trim();
    const parts = trimmed.split(' ');
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';
    const result = db.prepare(`
      INSERT INTO contacts (name, first_name, last_name, phone, status)
      VALUES (?, ?, ?, ?, 'new')
    `).run(trimmed || normalizedPhone, firstName, lastName, normalizedPhone);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
  } else if (name && name.trim() && !contact.name) {
    const trimmed = name.trim();
    const firstName = trimmed.split(' ')[0];
    db.prepare('UPDATE contacts SET name = ?, first_name = ? WHERE id = ?').run(trimmed, firstName, contact.id);
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  }
  return contact;
}

function createManualConversation(contactId) {
  let conv = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contactId);
  if (!conv) {
    const result = db.prepare(`
      INSERT INTO conversations (contact_id, category, last_message_at)
      VALUES (?, 'new', datetime('now'))
    `).run(contactId);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    const contact = db.prepare('SELECT phone FROM contacts WHERE id = ?').get(contactId);
    if (contact?.phone) addExcludedPhone(contact.phone, contactId);
  }
  return conv;
}

// ── Demo Runner (all logic here so it has access to the raw db connection) ──

const DEMO_AGENTS = [
  { name: 'Sarah Mitchell',  first_name: 'Sarah',    last_name: 'Mitchell',  brokerage: 'Keller Williams',    city: 'Charlotte',    state: 'NC', phone: '+15550100001' },
  { name: 'Bobby Johnson',   first_name: 'Bobby',    last_name: 'Johnson',   brokerage: 'RE/MAX',             city: 'Charlotte',    state: 'NC', phone: '+15550100002' },
  { name: 'Diane Carter',    first_name: 'Diane',    last_name: 'Carter',    brokerage: 'Coldwell Banker',    city: 'Matthews',     state: 'NC', phone: '+15550100003' },
  { name: 'Marcus Webb',     first_name: 'Marcus',   last_name: 'Webb',      brokerage: 'EXP Realty',         city: 'Concord',      state: 'NC', phone: '+15550100004' },
  { name: 'Linda Torres',    first_name: 'Linda',    last_name: 'Torres',    brokerage: 'Century 21',         city: 'Gastonia',     state: 'NC', phone: '+15550100005' },
  { name: 'Kevin Park',      first_name: 'Kevin',    last_name: 'Park',      brokerage: 'Compass',            city: 'Charlotte',    state: 'NC', phone: '+15550100006' },
  { name: 'Jennifer Oaks',   first_name: 'Jennifer', last_name: 'Oaks',      brokerage: 'Berkshire Hathaway', city: 'Huntersville', state: 'NC', phone: '+15550100007' },
  { name: 'Tom Briggs',      first_name: 'Tom',      last_name: 'Briggs',    brokerage: 'Howard Hanna',       city: 'Rock Hill',    state: 'SC', phone: '+15550100008' },
  { name: 'Ashley Monroe',   first_name: 'Ashley',   last_name: 'Monroe',    brokerage: 'RE/MAX',             city: 'Mooresville',  state: 'NC', phone: '+15550100009' },
  { name: 'Ray Donovan',     first_name: 'Ray',      last_name: 'Donovan',   brokerage: 'Keller Williams',    city: 'Charlotte',    state: 'NC', phone: '+15550100010' },
  { name: 'Patricia Lee',    first_name: 'Patricia', last_name: 'Lee',       brokerage: 'Allen Tate',         city: 'Charlotte',    state: 'NC', phone: '+15550100011' },
  { name: 'Steve Nguyen',    first_name: 'Steve',    last_name: 'Nguyen',    brokerage: 'EXP Realty',         city: 'Mint Hill',    state: 'NC', phone: '+15550100012' },
  { name: 'Carla Reeves',    first_name: 'Carla',    last_name: 'Reeves',    brokerage: 'Coldwell Banker',    city: 'Charlotte',    state: 'NC', phone: '+15550100013' },
  { name: 'Mike Sampson',    first_name: 'Mike',     last_name: 'Sampson',   brokerage: 'Compass',            city: 'Pineville',    state: 'NC', phone: '+15550100014' },
  { name: 'Gloria Simmons',  first_name: 'Gloria',   last_name: 'Simmons',   brokerage: 'Century 21',         city: 'Fort Mill',    state: 'SC', phone: '+15550100015' },
  { name: 'Derek Young',     first_name: 'Derek',    last_name: 'Young',     brokerage: 'Keller Williams',    city: 'Kannapolis',   state: 'NC', phone: '+15550100016' },
  { name: 'Helen Ford',      first_name: 'Helen',    last_name: 'Ford',      brokerage: 'RE/MAX',             city: 'Charlotte',    state: 'NC', phone: '+15550100017' },
  { name: 'Carl Hudson',     first_name: 'Carl',     last_name: 'Hudson',    brokerage: 'EXP Realty',         city: 'Ballantyne',   state: 'NC', phone: '+15550100018' },
  { name: 'Nancy Wright',    first_name: 'Nancy',    last_name: 'Wright',    brokerage: 'Howard Hanna',       city: 'Charlotte',    state: 'NC', phone: '+15550100019' },
  { name: 'James Odom',      first_name: 'James',    last_name: 'Odom',      brokerage: 'Allen Tate',         city: 'Cornelius',    state: 'NC', phone: '+15550100020' },
];

const DEMO_BLAST_MSG = "Hey {firstName}! I'm Chris, a local investor looking for fix and flip type properties that need a value add. Do you have anything for me to look at?";

const DEMO_RESPONSES = [
  "Hey Chris! Yeah actually I have a couple off-markets right now. One on Brookshire Freeway that needs a full gut. Seller wants out quick.",
  "I do! Got a 3/2 ranch on Beatties Ford Rd with foundation issues. Seller is motivated, hasn't had much interest. Wanna take a look?",
  "Hey! Yes I've got something in Gaston County. 4BR, needs everything — roof, HVAC, kitchen. What price range are you in?",
  "Good timing. I have a pocket listing in Concord that just came to me. 1960s ranch, needs updating. Seller wants a cash offer.",
  "Chris yes! I have a tired landlord with a duplex in Gastonia. Ready to exit. Both units occupied but rough condition.",
  "I do have one in Huntersville. Owner is going through a divorce, they just want it gone. Priced below market.",
  "Sure! Got a probate property in South End — heirs just want to liquidate. Needs cosmetics mostly, solid bones.",
  "Yeah I've been sitting on a vacant house in Rock Hill for 6 months. Seller is becoming flexible. Worth a look.",
  "Perfect timing! I have a pre-foreclosure situation in Mooresville. Owner has about 60 days, needs to be cash.",
  "I actually have 3 right now. Wanna hop on a quick call? Easier to walk you through them verbally.",
];

const DEMO_FOLLOWUP_OUT = [
  "That sounds great! Can you shoot me the address and what they're asking?",
  "Interesting — what's the foundation situation? Pier and beam or slab? And what are they looking for?",
  "Perfect. Send me the address and I'll drive by this week. What's the seller's timeline?",
];

const DEMO_FOLLOWUP_IN = [
  "Sure! It's 4821 Brookshire Freeway Dr. Asking $115k as-is. ARV probably $195–210k. Let me know if you want to walk it.",
  "Pier and beam, one corner dropped about 3 inches. Asking $89k. Maybe $15k in foundation work plus full rehab. ARV around $180k.",
  "Absolutely. 310 Overlook Ridge Rd, Concord 28027. Seller wants $95k cash, can close in 2 weeks. ARV comps $190–200k.",
];

const DEMO_CATEGORIES = ['new','new','new','new','new','new','new','new','new','new'];

function runDemo() {
  const ts = Date.now();

  // Clean up any previous demo contacts by phone number
  db.transaction(() => {
    DEMO_AGENTS.forEach(a => {
      const existing = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(a.phone);
      if (!existing) return;
      const conv = db.prepare('SELECT id FROM conversations WHERE contact_id = ?').get(existing.id);
      if (conv) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
      }
      db.prepare('DELETE FROM excluded_phones WHERE phone = ?').run(a.phone);
      db.prepare('DELETE FROM campaign_contacts WHERE contact_id = ?').run(existing.id);
      db.prepare('DELETE FROM contacts WHERE id = ?').run(existing.id);
    });
  })();

  // Create lead list
  const listId = db.prepare("INSERT INTO lead_lists (name) VALUES (?)").run('Demo — Charlotte Agents').lastInsertRowid;

  // Insert agents
  const insertContact = db.prepare(`
    INSERT INTO contacts (list_id, name, first_name, last_name, phone, brokerage, city, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    DEMO_AGENTS.forEach(a => insertContact.run(listId, a.name, a.first_name, a.last_name, a.phone, a.brokerage, a.city, a.state));
  })();

  const contacts = db.prepare('SELECT * FROM contacts WHERE list_id = ? ORDER BY id ASC').all(listId);

  // Create campaign
  const campaignId = db.prepare("INSERT INTO campaigns (name, message, status) VALUES (?, ?, 'completed')").run('Demo Campaign', DEMO_BLAST_MSG).lastInsertRowid;
  db.prepare('INSERT INTO campaign_lists (campaign_id, list_id) VALUES (?, ?)').run(campaignId, listId);

  // Mark all 20 as blasted
  const insertCC = db.prepare("INSERT INTO campaign_contacts (campaign_id, contact_id, status, sent_at, twilio_sid) VALUES (?, ?, 'sent', datetime('now'), ?)");
  db.transaction(() => {
    contacts.forEach(c => {
      insertCC.run(campaignId, c.id, `DEMO-SID-${ts}-${c.id}`);
      db.prepare("UPDATE contacts SET status = 'blasted' WHERE id = ?").run(c.id);
    });
    db.prepare('UPDATE campaigns SET sent_count = ? WHERE id = ?').run(contacts.length, campaignId);
  })();

  // Simulate 10 replies (first 10 contacts)
  db.transaction(() => {
    contacts.slice(0, 10).forEach((contact, i) => {
      // Create conversation & auto-exclude
      const convId = db.prepare(`
        INSERT INTO conversations (contact_id, category, last_message_at)
        VALUES (?, ?, datetime('now'))
      `).run(contact.id, DEMO_CATEGORIES[i] || 'new').lastInsertRowid;

      db.prepare("INSERT OR IGNORE INTO excluded_phones (phone, contact_id) VALUES (?, ?)").run(contact.phone, contact.id);
      db.prepare("UPDATE contacts SET status = 'responded' WHERE id = ?").run(contact.id);
      db.prepare('UPDATE campaigns SET response_count = response_count + 1 WHERE id = ?').run(campaignId);

      // Outbound blast
      const blastBody = DEMO_BLAST_MSG.replace(/\{firstName\}/gi, contact.first_name);
      db.prepare("INSERT INTO messages (conversation_id, body, direction, twilio_sid) VALUES (?, ?, 'outbound', ?)").run(convId, blastBody, `DEMO-BLAST-${ts}-${contact.id}`);

      // Their reply
      db.prepare("INSERT INTO messages (conversation_id, body, direction, twilio_sid) VALUES (?, ?, 'inbound', ?)").run(convId, DEMO_RESPONSES[i], `DEMO-REPLY-${ts}-${contact.id}`);

      // Follow-up exchange for first 3
      if (i < 3) {
        db.prepare("INSERT INTO messages (conversation_id, body, direction, twilio_sid) VALUES (?, ?, 'outbound', ?)").run(convId, DEMO_FOLLOWUP_OUT[i], `DEMO-FU1-${ts}-${contact.id}`);
        db.prepare("INSERT INTO messages (conversation_id, body, direction, twilio_sid) VALUES (?, ?, 'inbound', ?)").run(convId, DEMO_FOLLOWUP_IN[i],  `DEMO-FU2-${ts}-${contact.id}`);
      }

      db.prepare("UPDATE conversations SET last_message_at = datetime('now'), unread_count = ? WHERE id = ?").run(i < 3 ? 2 : 1, convId);
    });
  })();

  return { listId, campaignId };
}

// ── Notes ─────────────────────────────────────────────────────────────────────

function getNotes() {
  return db.prepare('SELECT * FROM notes ORDER BY sort_order ASC, id ASC').all();
}

function createNote(title, body) {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM notes').get().m;
  const result = db.prepare('INSERT INTO notes (title, body, sort_order) VALUES (?, ?, ?)').run(title, body, maxOrder + 1);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
}

function updateNote(id, title, body) {
  db.prepare("UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?").run(title, body, id);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
}

function deleteNote(id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

function incrementNoteCopyCount(id) {
  db.prepare('UPDATE notes SET copy_count = copy_count + 1 WHERE id = ?').run(id);
  return db.prepare('SELECT copy_count FROM notes WHERE id = ?').get(id)?.copy_count ?? 0;
}

function reorderNotes(orderedIds) {
  const update = db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    orderedIds.forEach((id, idx) => update.run(idx, id));
  })();
}

function getColdMessageExamples() {
  return db.prepare(`
    SELECT DISTINCT m.body FROM messages m
    JOIN conversations cv ON cv.id = m.conversation_id
    WHERE cv.category = 'not_interested'
      AND m.direction = 'inbound'
      AND m.id = (
        SELECT MIN(id) FROM messages
        WHERE conversation_id = cv.id AND direction = 'inbound'
      )
      AND cv.id NOT IN (
        SELECT DISTINCT conversation_id FROM conversation_category_log
        WHERE to_category IN ('hot_lead', 'follow_up', 'callback')
      )
    ORDER BY RANDOM()
  `).all().map(r => r.body);
}

function renameContact(contactId, name) {
  const trimmed = (name || '').trim();
  const parts = trimmed.split(' ');
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  db.prepare('UPDATE contacts SET name = ?, first_name = ?, last_name = ? WHERE id = ?')
    .run(trimmed, firstName, lastName, contactId);
}

function syncAllCampaignMessages(blastMessage) {
  db.prepare('UPDATE campaigns SET message = ?').run(blastMessage);
}

function getOverviewStats(period) {
  const filters = {
    '6months':  `AND created_at >= datetime('now', '-180 days')`,
    '3months':  `AND created_at >= datetime('now', '-90 days')`,
    'thismonth': `AND created_at >= datetime('now', 'start of month')`,
    'thisweek': `AND created_at >= datetime('now', 'weekday 0', '-7 days')`,
    'today':    `AND created_at >= datetime('now', 'start of day')`,
  };
  const dateFilter = filters[period] || '';

  const sending = db.prepare(`
    SELECT
      COALESCE(SUM(sent_count), 0)      AS total_sent,
      COALESCE(SUM(delivered_count), 0) AS total_delivered,
      COALESCE(SUM(failed_count), 0)    AS total_failed,
      COALESCE(SUM(response_count), 0)  AS total_replies,
      COUNT(*)                          AS total_campaigns
    FROM campaigns WHERE 1=1 ${dateFilter}
  `).get();

  const categoryRows = db.prepare(`
    SELECT category, COUNT(*) as count FROM conversations GROUP BY category
  `).all();
  const leads = {};
  categoryRows.forEach(r => { leads[r.category] = r.count; });

  // Initial category breakdown (first non-'new' category each conversation was ever put in)
  const initCatRows = db.prepare(`
    SELECT initial_cat, COUNT(*) as count FROM (
      SELECT COALESCE(
        (SELECT l.to_category FROM conversation_category_log l
         WHERE l.conversation_id = cv.id AND l.to_category != 'new'
         ORDER BY l.changed_at ASC LIMIT 1),
        CASE WHEN cv.category != 'new' THEN cv.category ELSE NULL END
      ) as initial_cat
      FROM conversations cv
      WHERE COALESCE(cv.archived, 0) = 0
    ) WHERE initial_cat IS NOT NULL
    GROUP BY initial_cat
  `).all();
  const initialLeads = {};
  initCatRows.forEach(r => { initialLeads[r.initial_cat] = r.count; });

  const newReplies = db.prepare(`
    SELECT COUNT(DISTINCT cv.id) as count
    FROM conversations cv
    WHERE cv.category = 'new'
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = cv.id AND m.direction = 'inbound'
      )
  `).get();

  const optOuts = db.prepare(`SELECT COUNT(*) as count FROM stopped_numbers`).get();
  const leadPipeline = getLeadPipelineStats();
  return { ...sending, leads, initialLeads, newRepliesPending: newReplies.count, leadPipeline, total_optouts: optOuts.count };
}

// ── Lead Submissions ─────────────────────────────────────────────────────────

function createLeadSubmission() {
  const result = db.prepare(`INSERT INTO lead_submissions (photo_paths) VALUES ('[]')`).run();
  return db.prepare('SELECT * FROM lead_submissions WHERE id = ?').get(result.lastInsertRowid);
}

function getLeadSubmissions() {
  return db.prepare(`
    SELECT ls.*, c.name as agent_name, c.phone as agent_phone
    FROM lead_submissions ls
    LEFT JOIN contacts c ON c.id = ls.contact_id
    ORDER BY ls.updated_at DESC
  `).all();
}

function getLeadSubmission(id) {
  return db.prepare(`
    SELECT ls.*, c.name as agent_name, c.phone as agent_phone
    FROM lead_submissions ls
    LEFT JOIN contacts c ON c.id = ls.contact_id
    WHERE ls.id = ?
  `).get(id);
}

function updateLeadSubmission(id, fields) {
  const allowed = ['address', 'asking_price', 'is_off_market', 'beds', 'baths', 'sqft', 'description', 'photo_paths', 'extra1', 'extra2', 'extra3', 'tier1_sent_at', 'tier2_sent_at', 'tier3_sent_at', 'final_sent_at', 'contact_id', 'outcome'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return getLeadSubmission(id);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE lead_submissions SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  return getLeadSubmission(id);
}

function deleteLeadSubmission(id) {
  db.prepare('DELETE FROM lead_submissions WHERE id = ?').run(id);
}

function getCampaignConversationStats(campaignId) {
  // Current category counts
  const rows = db.prepare(`
    SELECT cv.category, COUNT(*) as count
    FROM conversations cv
    JOIN contacts co ON co.id = cv.contact_id
    JOIN campaign_contacts cc ON cc.contact_id = co.id
    WHERE cc.campaign_id = ? AND COALESCE(cv.archived, 0) = 0
    GROUP BY cv.category
  `).all(campaignId);
  const cats = {};
  rows.forEach(r => { cats[r.category] = r.count; });

  // Initial category counts — first non-'new' category each lead was ever assigned.
  // Falls back to current category if no log entry exists (pre-migration data).
  const initRows = db.prepare(`
    SELECT initial_cat, COUNT(*) as count FROM (
      SELECT COALESCE(
        (SELECT l.to_category FROM conversation_category_log l
         WHERE l.conversation_id = cv.id AND l.to_category != 'new'
         ORDER BY l.changed_at ASC LIMIT 1),
        CASE WHEN cv.category != 'new' THEN cv.category ELSE NULL END
      ) as initial_cat
      FROM conversations cv
      JOIN contacts co ON co.id = cv.contact_id
      JOIN campaign_contacts cc ON cc.contact_id = co.id
      WHERE cc.campaign_id = ? AND COALESCE(cv.archived, 0) = 0
    ) WHERE initial_cat IS NOT NULL
    GROUP BY initial_cat
  `).all(campaignId);
  const initCats = {};
  initRows.forEach(r => { initCats[r.initial_cat] = r.count; });

  const newReplies = db.prepare(`
    SELECT COUNT(DISTINCT cv.id) as count
    FROM conversations cv
    JOIN contacts co ON co.id = cv.contact_id
    JOIN campaign_contacts cc ON cc.contact_id = co.id
    WHERE cc.campaign_id = ? AND cv.category = 'new'
      AND COALESCE(cv.archived, 0) = 0
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'inbound')
  `).get(campaignId);

  return {
    hot_lead:       cats.hot_lead       || 0,
    follow_up:      cats.follow_up      || 0,
    callback:       cats.callback       || 0,
    not_interested: cats.not_interested || 0,
    newReplies:     newReplies.count,
    initial_hot_lead:       initCats.hot_lead       || 0,
    initial_follow_up:      initCats.follow_up      || 0,
    initial_callback:       initCats.callback       || 0,
    initial_not_interested: initCats.not_interested || 0,
  };
}

function getLeadKPIsByCampaign(campaignId) {
  const row = db.prepare(`
    SELECT
      COUNT(*) as leads_submitted,
      SUM(CASE WHEN ls.outcome = 'contract' THEN 1 ELSE 0 END) as contracts,
      SUM(CASE WHEN ls.outcome = 'closed'   THEN 1 ELSE 0 END) as closed
    FROM lead_submissions ls
    JOIN contacts c ON c.id = ls.contact_id
    JOIN campaign_contacts cc ON cc.contact_id = c.id
    WHERE cc.campaign_id = ? AND ls.tier1_sent_at IS NOT NULL
  `).get(campaignId);
  return row || { leads_submitted: 0, contracts: 0, closed: 0 };
}

function getLeadPipelineStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                       as total,
      SUM(CASE WHEN outcome = 'no_go'   THEN 1 ELSE 0 END)         as no_go,
      SUM(CASE WHEN outcome = 'contract' THEN 1 ELSE 0 END)         as contracts,
      SUM(CASE WHEN outcome = 'closed'   THEN 1 ELSE 0 END)         as closed
    FROM lead_submissions WHERE tier1_sent_at IS NOT NULL
  `).get();
  return row || { total: 0, no_go: 0, contracts: 0, closed: 0 };
}

function getFollowUpContactsForCampaign(campaignId) {
  return db.prepare(`
    SELECT co.id, co.first_name, co.name, co.phone
    FROM contacts co
    JOIN campaign_contacts cc ON cc.contact_id = co.id AND cc.campaign_id = ?
    JOIN conversations cv ON cv.contact_id = co.id
    WHERE cv.category = 'follow_up'
    AND COALESCE(cv.archived, 0) = 0
  `).all(campaignId);
}

function getConversationMedia() {
  const rows = db.prepare(`
    SELECT cv.id as conv_id, c.name as contact_name, c.phone,
           m.id as msg_id, m.media_urls
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id
    JOIN messages m ON m.conversation_id = cv.id
    WHERE m.media_urls IS NOT NULL AND m.media_urls != 'null' AND m.media_urls != '[]'
    ORDER BY cv.id, m.created_at DESC
  `).all();

  const byConv = {};
  for (const row of rows) {
    const paths = JSON.parse(row.media_urls || '[]').filter(p => typeof p === 'string' && p.length > 0);
    if (!paths.length) continue;
    if (!byConv[row.conv_id]) {
      byConv[row.conv_id] = { convId: row.conv_id, contactName: row.contact_name || row.phone, phone: row.phone, photos: [] };
    }
    for (const p of paths) {
      byConv[row.conv_id].photos.push(p);
    }
  }
  return Object.values(byConv);
}

function getConversationDepthStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) as conversation_count,
      COALESCE(AVG(inbound_msgs), 0) as avg_inbound,
      COALESCE(AVG(outbound_msgs), 0) as avg_outbound
    FROM (
      SELECT
        m.conversation_id,
        SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) as inbound_msgs,
        SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END) as outbound_msgs
      FROM messages m
      GROUP BY m.conversation_id
      HAVING SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) > 0
    )
  `).get();
  return {
    conversationCount: row?.conversation_count || 0,
    avgInbound: row?.avg_inbound || 0,
    avgOutbound: row?.avg_outbound || 0,
  };
}

module.exports = {
  init,
  getSetting, saveSetting, getAllSettings, saveSettings,
  logAudit, getAuditLog,
  getDailyCount, incrementDailyCount,
  getLeadLists, createLeadList, deleteLeadList,
  getContacts, insertContacts, searchAllContacts, isPhoneExcluded, addExcludedPhone, isPhoneWhitelisted,
  updateContactStatus, findContactByPhone,
  getCampaigns, createCampaign, deleteCampaign, getCampaignContacts, getCampaignBlastPreview,
  isPhoneSentInCampaign, recordBlastSent, recordBlastFailed, completeCampaign, updateCampaignStatus,
  getCampaignSids, updateDeliveryStatus, refreshCampaignDeliveredCount, getCampaignOptOutCount,
  getContactById,
  findOrCreateManualContact, createManualConversation,
  resetList,
  resetCampaign,
  getConversations, getOrCreateConversation, getMessages, archiveConversation, unarchiveConversation,
  addMessage, markConversationRead, updateConversationCategory, setConversationForward, isConversationForwarding, getTotalUnread,
  addStoppedNumber, isPhoneStopped, markImportedExclusions,
  getColdMessageExamples,
  renameContact,
  getNotes, createNote, updateNote, deleteNote, incrementNoteCopyCount, reorderNotes,
  syncAllCampaignMessages,
  getOverviewStats,
  runDemo,
  createLeadSubmission, getLeadSubmissions, getLeadSubmission, updateLeadSubmission, deleteLeadSubmission, getConversationMedia,
  getFollowUpContactsForCampaign, getCampaignConversationStats, getLeadKPIsByCampaign, getLeadPipelineStats,
  getConversationDepthStats,
};
