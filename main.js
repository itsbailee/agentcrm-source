const { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItem } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const db = require('./database.js');
const twilio = require('./twilio.js');
const updater = require('./updater.js');
const { Anthropic } = require('@anthropic-ai/sdk');

function sanitizeForGSM7(text) {
  if (!text) return text;
  return text
    .replace(/[''‚′ʼ]/g, "'")
    .replace(/[""„″]/g, '"')
    .replace(/[—―‒–]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/•/g, '*')
    .replace(/·/g, '.')
    .replace(/[‐‑]/g, '-');
}
const { version: CURRENT_VERSION } = require('./package.json');

// Single-instance lock — if another instance is already running, focus it and quit
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;
let blastCancelled = false;
let pollInterval = null;

const MEDIA_DIR = path.join(app.getPath('userData'), 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function guessMediaExtension(contentType) {
  if (!contentType) return '.jpg';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('mp4')) return '.mp4';
  return '.jpg';
}

async function downloadMessageMedia(settings, messageSid) {
  const paths = [];
  try {
    const items = await twilio.fetchMedia(settings.accountSid, settings.authToken, messageSid);
    for (const item of items) {
      const ext = guessMediaExtension(item.contentType);
      const filename = `${messageSid}_${item.sid}${ext}`;
      const filePath = path.join(MEDIA_DIR, filename);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, item.data);
      paths.push(filePath);
    }
  } catch (e) {
    log('Media download error for', messageSid, ':', e.message);
  }
  return paths;
}

const SOUNDS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'sounds')
  : path.join(__dirname, 'public', 'sounds');
function playSound(name) {
  execFile('afplay', [path.join(SOUNDS_DIR, `${name}.wav`)], () => {});
}

const LOG_PATH = path.join(app.getPath('userData'), 'agent-crm-debug.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch (_) {}
}

// ── Phone Extension Filter ────────────────────────────────────────────────────
// Brokerage/office numbers often include extensions — they can't receive SMS
function hasPhoneExtension(raw) {
  return /\b(ext\.?|extension)\s*\d+|\bx\d+\b/i.test(raw);
}

// ── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuotes) { inQuotes = true; continue; }
    if (ch === '"' && inQuotes) { inQuotes = false; continue; }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function detectColumnMap(headers) {
  const lower = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const map = {};

  const find = (...patterns) => {
    for (const p of patterns) {
      const idx = lower.findIndex(h => h.includes(p));
      if (idx !== -1) return headers[idx];
    }
    return null;
  };

  map.firstName = find('firstname', 'first');
  map.lastName = find('lastname', 'last');
  map.name = map.firstName ? null : find('name', 'agentname', 'fullname', 'contact');
  map.phone = find('phone', 'cell', 'mobile', 'number', 'tel');
  map.brokerage = find('brokerage', 'company', 'office', 'firm', 'agency', 'broker');
  map.city = find('city', 'location');
  map.state = find('state', 'st');
  map.cityState = find('citystate', 'locationstate', 'market');

  return map;
}

const TITLE_CASE_PRESERVE = new Set(['III','IV','VI','VII','VIII','IX','XI','XII','LLC','INC','PA','LP','LLP','PLLC','SR','JR']);
function toTitleCase(str) {
  return str.replace(/\S+/g, w => {
    if (w !== w.toUpperCase()) return w;          // already mixed-case, leave it
    if (w.length <= 2) return w;                  // initials like JJ, DJ, AJ
    if (TITLE_CASE_PRESERVE.has(w)) return w;     // III, LLC, Inc, etc.
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function mapRow(row, columnMap) {
  let firstName = '', lastName = '', name = '';

  if (columnMap.firstName) firstName = toTitleCase((row[columnMap.firstName] || '').trim());
  if (columnMap.lastName) lastName = toTitleCase((row[columnMap.lastName] || '').trim());

  if (firstName || lastName) {
    name = [firstName, lastName].filter(Boolean).join(' ');
  } else if (columnMap.name && row[columnMap.name]) {
    name = toTitleCase(row[columnMap.name].trim());
    const parts = name.split(' ');
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  let city = '', state = '';
  if (columnMap.city) city = (row[columnMap.city] || '').trim();
  if (columnMap.state) state = (row[columnMap.state] || '').trim();
  if (!city && !state && columnMap.cityState) {
    const cs = (row[columnMap.cityState] || '').trim();
    const parts = cs.split(',');
    city = (parts[0] || '').trim();
    state = (parts[1] || '').trim();
  }

  const rawPhone = columnMap.phone ? (row[columnMap.phone] || '') : '';
  const phone = twilio.normalizePhone(rawPhone);

  return {
    name: name || 'Unknown',
    first_name: firstName,
    last_name: lastName,
    phone,
    brokerage: columnMap.brokerage ? (row[columnMap.brokerage] || '').trim() : '',
    city,
    state,
  };
}

// ── App Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 8 },
    backgroundColor: '#d4d0c8',
    icon: path.join(__dirname, 'build', 'icon.icns'),
    title: 'AgentCRM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Spell-check context menu: shows suggestions on right-click / ctrl-click
  mainWindow.webContents.on('context-menu', (e, params) => {
    const menu = new Menu();
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions) {
        menu.append(new MenuItem({
          label: s,
          click: () => mainWindow.webContents.replaceMisspelling(s),
        }));
      }
      if (params.dictionarySuggestions.length > 0) menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Add to Dictionary',
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut',   role: 'cut',   enabled: params.editFlags.canCut   }));
      menu.append(new MenuItem({ label: 'Copy',  role: 'copy',  enabled: params.editFlags.canCopy  }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    }
    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  try {
    db.init();
    log('Database initialized');
  } catch (e) {
    log('DB init error:', e.message);
  }

  // Set dock icon explicitly for dev mode
  if (app.dock) {
    const { nativeImage } = require('electron');
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.icns'));
    app.dock.setIcon(dockIcon);
  }

  createWindow();
  startPolling();
  updateBadge();
  // Poll immediately on startup to catch any messages missed during downtime
  setTimeout(pollTwilio, 5000);
  playSound('welcome');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let isQuitting = false;
app.on('before-quit', (e) => {
  if (!isQuitting) {
    e.preventDefault();
    isQuitting = true;
    const proc = execFile('afplay', [path.join(SOUNDS_DIR, 'goodbye.wav')]);
    proc.on('close', () => app.quit());
    setTimeout(() => app.quit(), 3000); // safety bail-out
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function updateBadge() {
  if (app.dock) app.dock.setBadge(String(db.getTotalUnread() || ''));
}

// ── AI Classification ────────────────────────────────────────────────────────

const SEED_NO_EXAMPLES = [
  "I do not.", "I don't have any now, thank you for checking.", "No, I do not.",
  "No, I'm sorry, I don't.", "Sorry, but no, not right now.", "Nothing, that is a fixer-upper price.",
  "Sorry, not today.", "Hi, Chris, no, I don't currently.", "No, I don't.",
  "I'm sorry, not at the moment.", "Hi, Chris, no, I don't.", "Not interested.",
  "No, no, I don't.", "Sorry, I don't.", "Not at this time, but thank you for asking.",
  "Hello, Chris, I have nothing like that right now.", "No, I don't have anything available at this time.",
  "No, not at the moment.", "Anything that's a fixer-upper will go fast.",
  "No, nope, not a thing.", "Sorry, nope.", "Not right now.", "No.", "Sorry, no.",
  "Not at the present time.", "I do not, unfortunately.", "I do not have any at this time.",
  "No, I sure don't at the moment.", "I do not.", "I'm sorry.",
  "No, we only work with our investors who relist flips with us.", "Sorry, I don't have any.",
  "I don't have any off-market.", "Sorry, none at this time, not at the moment.",
  "No, no, no, I don't.", "I don't sell off-market properties, not at this time.",
  "No off-markets.", "I don't have any off-market properties to coordinate today, but if we meet for a consult, we can plan a few out.",
  "Nothing off-market now.", "Hi Chris, unfortunately, I don't know.", "No, no, sorry, no.",
  "No, no, I do not have anything yet.", "Sorry, Chris, no.", "Nope, I don't at the moment.",
  "I'm not currently active.", "No, sir.", "Unfortunately, not at this time.", "No, not at this time.",
  "Sorry, no non-compete staff.", "Hi, no, I don't.", "No, sorry.", "I don't have anything.",
  "Nope, not right now.", "Thanks, no.", "Fixer upper should go pretty quick.",
  "Hello, no, I'm sorry, I don't.", "Not at this time.", "No, no.",
  "Stop reporting harassment on no call list.", "Please remove me from your list.",
  "Nopers.", "Nothing at the moment.",
];

async function classifyAsNoResponse(messageBody, apiKey) {
  const dbExamples = db.getColdMessageExamples();
  const client = new Anthropic({ apiKey });

  // Dedupe DB examples against seed so the prompt stays clean
  const seedSet = new Set(SEED_NO_EXAMPLES);
  const extraExamples = dbExamples.filter(ex => !seedSet.has(ex));
  const allExamples = [...SEED_NO_EXAMPLES, ...extraExamples];

  const exampleList = allExamples.map((ex, i) => `${i + 1}. "${ex}"`).join('\n');
  const userPrompt = `A wholesaler texted a real estate agent asking if they have any off-market fix-and-flip properties. Here are real examples of "not interested" replies:\n\n${exampleList}\n\nNew reply to classify: "${messageBody}"\n\nIs this clearly a "no" or "not interested" response? Reply with just YES or NO.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    system: 'You classify SMS replies from real estate agents. Determine if the reply is clearly a refusal or "not interested" response.',
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (response.content[0]?.text || '').trim().toUpperCase().startsWith('YES');
}

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling() {
  pollInterval = setInterval(pollTwilio, 30000);
}

// TCPA opt-out keywords — must be treated as immediate unsubscribe
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

async function pollTwilio() {
  const settings = db.getAllSettings();
  if (!settings.accountSid || !settings.authToken || !settings.phoneNumber) return;

  try {
    const lastPoll = settings.lastPollAt;
    const messages = await twilio.fetchInboundMessages(
      settings.accountSid, settings.authToken, settings.phoneNumber, lastPoll
    );

    log(`Poll: ${messages.length} inbound messages fetched from Twilio`);
    const myNumber = twilio.normalizePhone(settings.phoneNumber);

    // ── ISOLATION LAYER 2: batch filter before anything is processed ──────────
    // Layer 1 is the Twilio API query (To: myNumber). This is an independent
    // client-side filter that runs on the full result before any DB or contact
    // logic is touched. Any message not addressed to exactly this app's number
    // is discarded here and never enters the system.
    const blocked = messages.filter(m => twilio.normalizePhone(m.to) !== myNumber);
    if (blocked.length > 0) {
      log(`ISOLATION: Blocked ${blocked.length} message(s) addressed to wrong number: ${[...new Set(blocked.map(m => m.to))].join(', ')}`);
    }
    const safeMessages = messages.filter(m => twilio.normalizePhone(m.to) === myNumber);

    let newMessages = 0;
    for (const msg of safeMessages) {
      // ── ISOLATION LAYER 3: per-message guard inside the loop ─────────────────
      // Redundant after Layer 2 but acts as a final independent hard stop.
      if (twilio.normalizePhone(msg.to) !== myNumber) {
        log(`ISOLATION LAYER 3 TRIGGERED: Blocked SID=${msg.sid} — this should never occur`);
        continue;
      }
      // TCPA compliance: detect STOP and permanently blacklist
      const bodyClean = msg.body.trim().toUpperCase().replace(/[^A-Z]/g, '');
      if (STOP_WORDS.has(bodyClean)) {
        db.addStoppedNumber(msg.from);
        db.logAudit('opt_out', { phone: msg.from, body: msg.body });
        log(`STOP received from ${msg.from} — permanently blacklisted`);
        continue;
      }

      let contact = db.findContactByPhone(msg.from);
      if (!contact) {
        log(`Poll: unknown number ${msg.from} — auto-creating contact`);
        contact = db.findOrCreateManualContact(msg.from, null);
      }

      const conv = db.getOrCreateConversation(contact.id);
      let mediaPaths = [];
      if (parseInt(msg.num_media || '0') > 0) {
        mediaPaths = await downloadMessageMedia(settings, msg.sid);
      }
      const wasNew = db.addMessage(conv.id, msg.body, 'inbound', msg.sid, mediaPaths);
      // Auto-unarchive only when a genuinely new message arrives (not already-seen duplicates)
      if (wasNew && conv.archived) db.unarchiveConversation(conv.id);
      if (wasNew) {
        log(`Poll: new message from ${msg.from} (${contact.name})`);
        newMessages++;

        const fwdPhone = settings.forwardPhone ? twilio.normalizePhone(settings.forwardPhone) : null;
        if (db.isConversationForwarding(conv.id) && settings.accountSid && settings.authToken && settings.phoneNumber && fwdPhone) {
          const displayName = contact.name || contact.first_name || msg.from;
          const fwdBody = `[AgentCRM] ${displayName}: ${msg.body}`;
          try {
            await twilio.sendSMS(
              settings.accountSid, settings.authToken, settings.phoneNumber,
              fwdPhone, fwdBody, settings.messagingServiceSid
            );
            log(`Forwarded message from ${msg.from} to ${settings.forwardPhone}`);
          } catch (fwdErr) {
            log(`Forward SMS failed: ${fwdErr.message}`);
          }
        }

        // Whitelisted test numbers always reset to 'new' so they can be re-tested repeatedly
        if (db.isPhoneWhitelisted(msg.from) && conv.category !== 'new') {
          db.updateConversationCategory(conv.id, 'new');
          conv.category = 'new';
        }

        // AI auto-sort: classify new conversations only
        if (settings.aiEnabled === 'true' && settings.claudeApiKey && conv.category === 'new') {
          try {
            const isNo = await classifyAsNoResponse(msg.body, settings.claudeApiKey);
            if (isNo) {
              db.updateConversationCategory(conv.id, 'not_interested');
              db.markConversationRead(conv.id);
              log(`AI: auto-categorized message from ${msg.from} as cold`);
            }
          } catch (aiErr) {
            log(`AI classification error: ${aiErr.message}`);
          }
        }
      }
    }

    db.saveSetting('lastPollAt', new Date().toISOString());
    updateBadge();

    if (newMessages > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('new-messages', { count: newMessages });
    }
  } catch (e) {
    log('Poll error:', e.message);
  }
}

// ── Centralized Send Guard ────────────────────────────────────────────────────
// Every real Twilio send must pass through this. Throws with a descriptive
// error if any gate fails. Call before every individual send attempt.

function assertCanSend(phone, settings, { skipDailyCapCheck = false } = {}) {
  if (settings.liveSmsEnabled !== 'true') {
    throw new Error('LIVE SMS IS DISABLED. Enable in Settings → Send Safety.');
  }
  if (settings.a2pApproved !== 'true') {
    throw new Error('A2P/10DLC registration is not marked approved. Enable in Settings → Send Safety once Twilio confirms approval.');
  }
  if (settings.killSwitch === 'true') {
    throw new Error('Emergency kill switch is active. Disable in Settings → Send Safety.');
  }
  if (!settings.accountSid || !settings.authToken || !settings.phoneNumber) {
    throw new Error('Twilio credentials are not configured. Go to Settings.');
  }
  if (!phone) {
    throw new Error('No phone number for this contact.');
  }
  const normalized = twilio.normalizePhone(phone);
  if (!normalized) {
    throw new Error(`Phone number "${phone}" could not be normalized to E.164 format.`);
  }
  if (db.isPhoneStopped(normalized) && !db.isPhoneWhitelisted(normalized)) {
    throw new Error(`${normalized} has opted out (STOP). Permanently blocked.`);
  }
  if (!skipDailyCapCheck) {
    const hardMax = 10000;
    const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), hardMax);
    const dailyUsed = db.getDailyCount();
    if (dailyUsed >= dailyCap) {
      throw new Error(`Daily send cap of ${dailyCap} reached (${dailyUsed} sent today). Resets at midnight.`);
    }
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseCSV(content);
  const columnMap = detectColumnMap(parsed.headers);
  return { filePath, headers: parsed.headers, rows: parsed.rows.slice(0, 5), columnMap, totalRows: parsed.rows.length };
});
ipcMain.handle('dnc-add', async (_, phone, contactId) => {
  db.addToDNC(phone, contactId);
  return { success: true };
});

ipcMain.handle('dnc-list', async () => {
  return db.getDNCList();
});

ipcMain.handle('dnc-check', async (_, phone) => {
  return db.isPhoneOnDNC(phone);
});
ipcMain.handle('csv:import', async (_, { filePath, listName, columnMap }) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { rows } = parseCSV(content);
  const phoneCol = columnMap.phone;
  const extensionFiltered = phoneCol
    ? rows.filter(r => hasPhoneExtension((r[phoneCol] || '').trim())).length
    : 0;
  const filteredRows = phoneCol
    ? rows.filter(r => !hasPhoneExtension((r[phoneCol] || '').trim()))
    : rows;
  const listId = db.createLeadList(listName);
  const contacts = filteredRows.map(r => mapRow(r, columnMap)).filter(c => c.name || c.phone);
  db.insertContacts(listId, contacts);
  const exclusions = db.markImportedExclusions(listId);
  log(`Imported ${contacts.length} into "${listName}" — known:${exclusions.alreadyKnown} stopped:${exclusions.optedOut} ext-filtered:${extensionFiltered}`);
  return { listId, count: contacts.length, extensionFiltered, ...exclusions };
});

ipcMain.handle('leads:getLists', () => db.getLeadLists());
ipcMain.handle('leads:getContacts', (_, listId) => db.getContacts(listId));
ipcMain.handle('leads:deleteList', (_, listId) => { db.deleteLeadList(listId); return true; });
ipcMain.handle('leads:resetList', (_, listId) => { db.resetList(listId); db.logAudit('list_reset', { listId }); return true; });

ipcMain.handle('campaigns:getAll', () => db.getCampaigns());

ipcMain.handle('campaigns:create', (_, { name, message, listIds }) => {
  return db.createCampaign(name, message, listIds);
});

ipcMain.handle('campaigns:blast', async (_, campaignId) => {
  const settings = db.getAllSettings();
  const hardMax = 10000;
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), hardMax);

  // ── Pre-flight: all gates checked via shared guard ─────────────────────
  assertCanSend('+15550000000', settings, { skipDailyCapCheck: true }); // validate lock/A2P/kill/creds with dummy phone
  const dailyUsed = db.getDailyCount();
  if (dailyUsed >= dailyCap) {
    throw new Error(`Daily send cap of ${dailyCap} reached (${dailyUsed} sent today). Resets at midnight.`);
  }

  const contacts = db.getCampaignContacts(campaignId);
  if (contacts.length === 0) throw new Error('No eligible contacts to blast.');

  const campaign = db.getCampaigns().find(c => c.id === campaignId);
  if (campaign?.max_sends && contacts.length > campaign.max_sends) {
    throw new Error(`Campaign cap of ${campaign.max_sends} would be exceeded (${contacts.length} eligible). Adjust list or cap.`);
  }

  const firstBatchCap = parseInt(settings.firstBatchCap || '50', 10);
  const cappedContacts = contacts.slice(0, Math.min(firstBatchCap, dailyCap - dailyUsed));
  const batchCapped = cappedContacts.length < contacts.length;

  db.updateCampaignStatus(campaignId, 'running');
  db.logAudit('blast_start', { campaignId, eligible: contacts.length, capped: cappedContacts.length, dailyUsed });
  blastCancelled = false;

  const template = sanitizeForGSM7(settings.blastMessage ||
    "Hey {firstName}! I'm Chris, a local investor looking for fix and flip type properties that need a value add. Do you have anything for me to look at?");

  let sent = 0, failed = 0, consecutiveFails = 0;
  const CONSECUTIVE_FAIL_LIMIT = 5;
  const FAILURE_RATE_CHECK_AT = 25;
  const FAILURE_RATE_MAX = 0.10;
  const phonesSeenThisBlast = new Set(); // phone-level dedup within this blast run

  const autoPause = (reason) => {
    db.updateCampaignStatus(campaignId, 'paused');
    db.logAudit('blast_auto_paused', { campaignId, reason, sent, failed });
    log(`Auto-pausing campaign ${campaignId}: ${reason}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('blast-progress', { campaignId, sent, failed, total: cappedContacts.length, autoPaused: true, reason });
    }
  };

  for (const contact of cappedContacts) {
    if (blastCancelled) break;

    // Re-read kill switch from DB on every iteration (catches mid-blast activation)
    if (db.getSetting('killSwitch') === 'true') {
      autoPause('kill switch activated mid-blast');
      return { sent, failed, autoPaused: true };
    }

    const phone = twilio.normalizePhone(contact.phone);

    // Fast-path in-memory dedup (same phone seen earlier in this run)
    if (phone && phonesSeenThisBlast.has(phone) && !db.isPhoneWhitelisted(phone)) {
      log(`Skipping in-memory duplicate phone ${phone}`);
      db.logAudit('sms_dedup_memory', { campaignId, contactId: contact.id, phone });
      continue;
    }

    // Durable DB-level dedup: phone already sent in this campaign across any run/restart
    if (phone && db.isPhoneSentInCampaign(campaignId, phone) && !db.isPhoneWhitelisted(phone)) {
      log(`Skipping DB duplicate phone ${phone} (already sent in campaign ${campaignId})`);
      db.logAudit('sms_dedup_db', { campaignId, contactId: contact.id, phone });
      phonesSeenThisBlast.add(phone);
      continue;
    }

    if (phone) phonesSeenThisBlast.add(phone);

    // Per-contact guard: opt-out, phone validity, live lock, A2P
    try {
      assertCanSend(phone, settings, { skipDailyCapCheck: true });
    } catch (guardErr) {
      log(`Skipping ${phone}: ${guardErr.message}`);
      db.recordBlastFailed(campaignId, contact.id, guardErr.message);
      db.logAudit('sms_skipped', { campaignId, contactId: contact.id, phone, reason: guardErr.message });
      failed++;
      continue;
    }

    try {
      const body = twilio.buildBlastMessage(template, contact.first_name || contact.name.split(' ')[0]);
      const result = await twilio.sendSMS(
        settings.accountSid, settings.authToken, settings.phoneNumber, phone, body, settings.messagingServiceSid
      );
      db.recordBlastSent(campaignId, contact.id, result.sid, phone);
      db.logAudit('sms_sent', { campaignId, contactId: contact.id, phone, sid: result.sid });
      sent++;
      consecutiveFails = 0;
    } catch (e) {
      log('Blast send error:', e.message);
      db.recordBlastFailed(campaignId, contact.id, e.message);
      db.logAudit('sms_failed', { campaignId, contactId: contact.id, phone, error: e.message });
      failed++;
      consecutiveFails++;

      if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
        autoPause(`${consecutiveFails} consecutive failures`);
        return { sent, failed, autoPaused: true };
      }
    }

    // 10% failure rate check (after first 25 attempts)
    const total = sent + failed;
    if (total >= FAILURE_RATE_CHECK_AT && failed / total > FAILURE_RATE_MAX) {
      autoPause(`failure rate ${Math.round(failed / total * 100)}% exceeds 10% threshold after ${total} sends`);
      return { sent, failed, autoPaused: true };
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('blast-progress', { campaignId, sent, failed, total: cappedContacts.length });
    }

    await new Promise(r => setTimeout(r, 200));
  }

  if (batchCapped && !blastCancelled) {
    db.updateCampaignStatus(campaignId, 'paused');
    db.logAudit('blast_batch_cap', { campaignId, sent, failed, batchCap: firstBatchCap });
    log(`Blast paused at first batch cap of ${firstBatchCap}: ${sent} sent, ${failed} failed`);
    return { sent, failed, batchCapped: true, remaining: contacts.length - cappedContacts.length };
  }

  db.completeCampaign(campaignId);
  db.logAudit('blast_complete', { campaignId, sent, failed });
  log(`Blast complete: ${sent} sent, ${failed} failed`);
  return { sent, failed };
});

ipcMain.handle('campaigns:cancel', () => {
  blastCancelled = true;
  db.logAudit('blast_cancelled', {});
  return true;
});

ipcMain.handle('campaigns:getBlastPreview', (_, campaignId) => {
  const settings = db.getAllSettings();
  const preview = db.getCampaignBlastPreview(campaignId);
  const template = sanitizeForGSM7(settings.blastMessage ||
    "Hey {firstName}! I'm Chris, a local investor looking for fix and flip type properties that need a value add. Do you have anything for me to look at?");
  const sampleMsg = twilio.buildBlastMessage(template, 'Sarah');
  const segments = twilio.countSegments(sampleMsg);
  const dailyUsed = db.getDailyCount();
  const hardMax = 10000;
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), hardMax);
  const firstBatchCap = parseInt(settings.firstBatchCap || '50', 10);
  const willSend = Math.min(preview.eligibleCount, firstBatchCap, dailyCap - dailyUsed);
  return {
    totalInLists: preview.totalInLists,
    eligibleCount: preview.eligibleCount,
    blockedCount: preview.blockedCount,
    invalidCount: preview.invalidCount,
    dedupCount: preview.dedupCount,
    willSend,
    segments,
    estimatedTotalSegments: willSend * segments,
    dailyCap,
    dailyUsed,
    dailyRemaining: dailyCap - dailyUsed,
    firstBatchCap,
    campaignMax: preview.campaign?.max_sends || null,
    liveSmsEnabled: settings.liveSmsEnabled === 'true',
    a2pApproved: settings.a2pApproved === 'true',
    killSwitch: settings.killSwitch === 'true',
    messagePreview: sampleMsg,
    phoneNumber: settings.phoneNumber || '',
  };
});

ipcMain.handle('campaigns:getFollowUpPreview', (_, campaignId) => {
  const settings = db.getAllSettings();
  const contacts = db.getFollowUpContactsForCampaign(campaignId);
  const dailyUsed = db.getDailyCount();
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), 10000);
  return {
    followUpCount: contacts.length,
    contacts,
    dailyCap,
    dailyUsed,
    dailyRemaining: dailyCap - dailyUsed,
    liveSmsEnabled: settings.liveSmsEnabled === 'true',
    a2pApproved: settings.a2pApproved === 'true',
    killSwitch: settings.killSwitch === 'true',
    phoneNumber: settings.phoneNumber || '',
  };
});

ipcMain.handle('campaigns:followUpBlast', async (_, { campaignId, message }) => {
  const settings = db.getAllSettings();
  assertCanSend('+15550000000', settings, { skipDailyCapCheck: true });
  const dailyUsed = db.getDailyCount();
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), 10000);
  if (dailyUsed >= dailyCap) throw new Error(`Daily send cap of ${dailyCap} reached.`);

  const contacts = db.getFollowUpContactsForCampaign(campaignId);
  if (contacts.length === 0) throw new Error('No follow-up contacts found in this campaign.');

  const template = sanitizeForGSM7((message || '').trim() ||
    "Hey {firstName}, just checking back in with you. Do you have anything off-market I can look at?");

  blastCancelled = false;
  let sent = 0, failed = 0;
  const total = contacts.length;

  for (const contact of contacts) {
    if (blastCancelled) break;
    if (db.getSetting('killSwitch') === 'true') break;

    const phone = twilio.normalizePhone(contact.phone);
    try {
      assertCanSend(phone, settings, { skipDailyCapCheck: true });
    } catch (guardErr) {
      db.logAudit('follow_up_skipped', { campaignId, contactId: contact.id, phone, reason: guardErr.message });
      failed++;
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('blast-progress', { campaignId, sent, failed, total });
      continue;
    }

    try {
      const firstName = contact.first_name || (contact.name || '').split(' ')[0] || '';
      const body = twilio.buildBlastMessage(template, firstName);
      const result = await twilio.sendSMS(
        settings.accountSid, settings.authToken, settings.phoneNumber, phone, body, settings.messagingServiceSid
      );
      db.logAudit('follow_up_sent', { campaignId, contactId: contact.id, phone, sid: result.sid });
      sent++;
    } catch (e) {
      db.logAudit('follow_up_failed', { campaignId, contactId: contact.id, phone, error: e.message });
      failed++;
    }

    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('blast-progress', { campaignId, sent, failed, total });
    await new Promise(r => setTimeout(r, 200));
  }

  db.logAudit('follow_up_blast_complete', { campaignId, sent, failed });
  return { sent, failed };
});

ipcMain.handle('campaigns:getAllFollowUpPreview', () => {
  const settings = db.getAllSettings();
  const contacts = db.getAllFollowUpContacts();
  const dailyUsed = db.getDailyCount();
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), 10000);
  return {
    followUpCount: contacts.length,
    contacts,
    dailyCap,
    dailyUsed,
    dailyRemaining: dailyCap - dailyUsed,
    liveSmsEnabled: settings.liveSmsEnabled === 'true',
    a2pApproved: settings.a2pApproved === 'true',
    killSwitch: settings.killSwitch === 'true',
    phoneNumber: settings.phoneNumber || '',
  };
});

ipcMain.handle('campaigns:allFollowUpBlast', async (_, { message }) => {
  const settings = db.getAllSettings();
  assertCanSend('+15550000000', settings, { skipDailyCapCheck: true });
  const dailyUsed = db.getDailyCount();
  const dailyCap = Math.min(parseInt(settings.dailyCap || '10000', 10), 10000);
  if (dailyUsed >= dailyCap) throw new Error(`Daily send cap of ${dailyCap} reached.`);

  const contacts = db.getAllFollowUpContacts();
  if (contacts.length === 0) throw new Error('No follow-up contacts found across any campaign.');

  const template = sanitizeForGSM7((message || '').trim() ||
    "Hey {firstName}, just checking back in with you. Do you have anything off-market I can look at?");

  blastCancelled = false;
  let sent = 0, failed = 0;
  const total = contacts.length;

  for (const contact of contacts) {
    if (blastCancelled) break;
    if (db.getSetting('killSwitch') === 'true') break;

    const phone = twilio.normalizePhone(contact.phone);
    try {
      assertCanSend(phone, settings, { skipDailyCapCheck: true });
    } catch (guardErr) {
      db.logAudit('all_followup_skipped', { contactId: contact.id, phone, reason: guardErr.message });
      failed++;
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('blast-progress', { sent, failed, total });
      continue;
    }

    try {
      const firstName = contact.first_name || (contact.name || '').split(' ')[0] || '';
      const body = twilio.buildBlastMessage(template, firstName);
      const result = await twilio.sendSMS(
        settings.accountSid, settings.authToken, settings.phoneNumber, phone, body, settings.messagingServiceSid
      );
      db.logAudit('all_followup_sent', { contactId: contact.id, phone, sid: result.sid });
      sent++;
    } catch (e) {
      db.logAudit('all_followup_failed', { contactId: contact.id, phone, error: e.message });
      failed++;
    }

    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('blast-progress', { sent, failed, total });
    await new Promise(r => setTimeout(r, 200));
  }

  db.logAudit('all_followup_blast_complete', { sent, failed });
  return { sent, failed };
});

ipcMain.handle('campaigns:refreshStats', async (_, campaignId) => {
  const settings = db.getAllSettings();
  if (!settings.accountSid || !settings.authToken) {
    throw new Error('Twilio credentials not configured.');
  }
  const sids = db.getCampaignSids(campaignId);
  if (sids.length === 0) return { refreshed: 0 };

  const statuses = await twilio.fetchMessageStatuses(settings.accountSid, settings.authToken, sids);
  Object.entries(statuses).forEach(([sid, status]) => db.updateDeliveryStatus(sid, status));
  db.refreshCampaignDeliveredCount(campaignId);

  const optOutCount = db.getCampaignOptOutCount(campaignId);
  log(`Stats refreshed for campaign ${campaignId}: ${Object.keys(statuses).length} SIDs checked`);
  return { refreshed: Object.keys(statuses).length, optOutCount };
});

ipcMain.handle('campaigns:delete', (_, campaignId) => { db.deleteCampaign(campaignId); return true; });


ipcMain.handle('conversations:getAll', () => db.getConversations());
ipcMain.handle('conversations:getMessages', (_, convId) => db.getMessages(convId));
ipcMain.handle('conversations:markRead', (_, convId) => { db.markConversationRead(convId); updateBadge(); return true; });
ipcMain.handle('conversations:updateCategory', (_, { convId, category }) => {
  db.updateConversationCategory(convId, category);
  return true;
});

ipcMain.handle('conversations:archive', (_, convId) => {
  db.archiveConversation(convId);
  return true;
});

ipcMain.handle('conversations:setForward', (_, { convId, enabled }) => {
  db.setConversationForward(convId, enabled);
  log(`Forward ${enabled ? 'enabled' : 'disabled'} for conversation ${convId}`);
  return true;
});

ipcMain.handle('conversations:sendMessage', async (_, { convId, body }) => {
  const settings = db.getAllSettings();
  log(`sendMessage: convId=${convId} liveSms=${settings.liveSmsEnabled} a2p=${settings.a2pApproved} kill=${settings.killSwitch} hasSid=${!!settings.accountSid} hasToken=${!!settings.authToken} hasPhone=${!!settings.phoneNumber} msid=${settings.messagingServiceSid || 'none'}`);

  // Demo/offline mode — no credentials configured, save locally without sending
  if (!settings.accountSid || !settings.authToken || !settings.phoneNumber) {
    log(`sendMessage: missing credentials — saving locally only`);
    db.addMessage(convId, body, 'outbound', null);
    return true;
  }

  const conv = db.getConversations().find(c => c.id === convId);
  if (!conv) throw new Error('Conversation not found');
  log(`sendMessage: to=${conv.phone}`);

  // Shared guard — same gates as campaign blasts
  assertCanSend(conv.phone, settings);
  log(`sendMessage: guard passed — calling Twilio`);

  const result = await twilio.sendSMS(
    settings.accountSid, settings.authToken, settings.phoneNumber, conv.phone, body, settings.messagingServiceSid
  );
  log(`sendMessage: success sid=${result.sid}`);
  db.addMessage(convId, body, 'outbound', result.sid);
  db.logAudit('manual_send', { convId, phone: conv.phone, sid: result.sid });
  return true;
});

ipcMain.handle('conversations:startManual', async (_, { phone, name }) => {
  const normalized = twilio.normalizePhone(phone);
  if (!normalized) throw new Error(`"${phone}" couldn't be normalized to a valid phone number.`);
  if (db.isPhoneStopped(normalized)) throw new Error(`${normalized} has opted out (STOP) and cannot be contacted.`);
  const contact = db.findOrCreateManualContact(normalized, name || null);
  const conv = db.createManualConversation(contact.id);
  db.logAudit('manual_conv_started', { phone: normalized, contactId: contact.id, convId: conv.id });
  const full = db.getConversations().find(c => c.id === conv.id);
  return full || conv;
});

ipcMain.handle('conversations:getTotalUnread', () => db.getTotalUnread());

ipcMain.handle('twilio:poll', async () => { await pollTwilio(); return true; });

ipcMain.handle('twilio:verify', async (_, { accountSid, authToken, phoneNumber, messagingServiceSid }) => {
  const saved = db.getAllSettings();
  const sid   = accountSid        || saved.accountSid;
  const token = authToken         || saved.authToken;
  const phone = phoneNumber       || saved.phoneNumber;
  const msid  = messagingServiceSid !== undefined ? messagingServiceSid : (saved.messagingServiceSid || '');
  await twilio.verifyCredentials(sid, token, phone, msid);
  return true;
});

ipcMain.handle('twilio:getAccountBalance', async () => {
  const settings = db.getAllSettings();
  if (!settings.accountSid || !settings.authToken) throw new Error('No Twilio credentials configured');
  return await twilio.fetchAccountBalance(settings.accountSid, settings.authToken);
});

ipcMain.handle('twilio:getBlastCostEstimate', async (_, { segments, willSend }) => {
  const settings = db.getAllSettings();
  if (!settings.accountSid || !settings.authToken) throw new Error('No Twilio credentials configured');

  const [pricing, usage, convDepth] = await Promise.all([
    twilio.fetchSmsPricing(settings.accountSid, settings.authToken),
    twilio.fetchUsageSummary(settings.accountSid, settings.authToken),
    Promise.resolve(db.getConversationDepthStats()),
  ]);

  const { outboundPricePerSegment, currency, carrierCount } = pricing;

  // Carrier surcharge: the Twilio Pricing API only returns Twilio's base fee.
  // Carrier surcharges (A2P 10DLC) are flat-per-message fees NOT per-segment.
  // We derive them from Usage Records: all-in rate minus the base Twilio rate.
  // Usage Records "this month" reflect 1-seg messages (user confirmed fix),
  // so: carrier_fee = all_in_per_msg - (1 × base_rate_per_seg).
  // Fallbacks from 18k-message log analysis if no usage data available.
  const FALLBACK_CARRIER_OUT = 0.00452; // derived from logs: $0.01282 - $0.00830
  const FALLBACK_CARRIER_IN  = 0.00157; // derived from logs: $0.00987 - $0.00830
  const FALLBACK_ALLIN_IN    = 0.00987;

  let carrierFeePerOutboundMsg, allInInboundPerMsg, usagePeriod, usageMsgCount;
  if (usage.allInOutboundPerMsg !== null) {
    // carrier surcharge = all-in rate (from usage records) minus Twilio's base rate (1-seg)
    carrierFeePerOutboundMsg = Math.max(usage.allInOutboundPerMsg - outboundPricePerSegment, 0);
    allInInboundPerMsg = usage.allInInboundPerMsg ?? FALLBACK_ALLIN_IN;
    usagePeriod = usage.period;
    usageMsgCount = usage.outboundCount;
  } else {
    carrierFeePerOutboundMsg = FALLBACK_CARRIER_OUT;
    allInInboundPerMsg = FALLBACK_ALLIN_IN;
    usagePeriod = 'fallback';
    usageMsgCount = 0;
  }

  // All-in cost per outbound message = (segments × Twilio base rate) + flat carrier fee
  const allInOutboundPerMsg = segments * outboundPricePerSegment + carrierFeePerOutboundMsg;

  // Conversation depth defaults from 18k-message log analysis:
  //   Response rate: 6.7–9.2% → 8%
  //   Avg inbound msgs per engaged contact: 2.0
  //   Avg inbound segments per msg: 1.2 (replies are longer than "Yes" but shorter than blasts)
  //   Avg outbound follow-up replies per engaged contact: 1.2 (beyond the blast)
  const hasHistory = convDepth.conversationCount >= 5;
  const responseRate         = 0.08;
  const avgInboundMsgs       = hasHistory ? convDepth.avgInbound              : 2.0;
  const avgOutboundFollowups = hasHistory ? Math.max(convDepth.avgOutbound - 1, 0) : 1.2;

  const estimatedReplies   = Math.round(willSend * responseRate);

  // Outbound blast: (Twilio base × segments) + flat carrier fee per message
  const outboundTwilioCost  = willSend * segments * outboundPricePerSegment;
  const outboundCarrierCost = willSend * carrierFeePerOutboundMsg;
  const outboundBlastCost   = outboundTwilioCost + outboundCarrierCost;

  // Inbound replies: use all-in rate from usage records (already includes carrier fees)
  const inboundReplyCost = estimatedReplies * avgInboundMsgs * allInInboundPerMsg;

  // Our follow-up outbound replies (manual, 1-segment each)
  const replyTwilioCost  = estimatedReplies * avgOutboundFollowups * outboundPricePerSegment;
  const replyCarrierCost = estimatedReplies * avgOutboundFollowups * carrierFeePerOutboundMsg;
  const outboundReplyCost = replyTwilioCost + replyCarrierCost;

  const totalEstimate = outboundBlastCost + inboundReplyCost + outboundReplyCost;

  return {
    // Rates
    outboundPricePerSegment,
    carrierFeePerOutboundMsg,
    allInOutboundPerMsg,
    allInInboundPerMsg,
    currency,
    carrierCount,
    usagePeriod,
    usageMsgCount,
    // Blast params
    willSend,
    segments,
    responseRate,
    estimatedReplies,
    avgInboundMsgs,
    avgOutboundFollowups,
    conversationSampleSize: convDepth.conversationCount,
    // Cost breakdown
    outboundTwilioCost,
    outboundCarrierCost,
    outboundBlastCost,
    inboundReplyCost,
    replyTwilioCost,
    replyCarrierCost,
    outboundReplyCost,
    totalEstimate,
  };
});

ipcMain.handle('claude:verify', async (_, apiKey) => {
  const key = apiKey || db.getSetting('claudeApiKey');
  if (!key) throw new Error('No API key provided.');
  const client = new Anthropic({ apiKey: key });
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return true;
});

ipcMain.handle('updater:getVersion', () => CURRENT_VERSION);

ipcMain.handle('updater:check', async () => {
  return await updater.checkForUpdate(CURRENT_VERSION);
});

ipcMain.handle('updater:install', async (_, { downloadUrl }) => {
  await updater.installUpdate(downloadUrl, (pct) => {
    mainWindow?.webContents.send('update-progress', pct);
  });
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('settings:get', () => {
  const s = db.getAllSettings();
  if (s.authToken) s.authToken = '••••••••••••••••••••••••••••••••';
  if (s.claudeApiKey) s.claudeApiKey = '••••••••••••••••••••••••••••••••';
  return s;
});
ipcMain.handle('settings:save', (_, settings) => {
  if (!settings.authToken || settings.authToken.startsWith('••')) {
    delete settings.authToken;
  }
  if (!settings.claudeApiKey || settings.claudeApiKey.startsWith('••')) {
    delete settings.claudeApiKey;
  }
  db.saveSettings(settings);
  if (settings.blastMessage) {
    db.syncAllCampaignMessages(settings.blastMessage);
  }
  return true;
});

ipcMain.handle('overview:getStats', (_, period) => db.getOverviewStats(period));
ipcMain.handle('dnc-add', async (_, phone, contactId) => {
  db.addToDNC(phone, contactId);
  return { success: true };
});
ipcMain.handle('contacts:rename', (_, { contactId, name }) => {
  db.renameContact(contactId, name);
  return true;
});

ipcMain.handle('contacts:searchAll', (_, query) => {
  return db.searchAllContacts(query || '');
});

ipcMain.handle('notes:getAll', () => db.getNotes());
ipcMain.handle('notes:create', (_, { title, body }) => db.createNote(title, body));
ipcMain.handle('notes:update', (_, { id, title, body }) => db.updateNote(id, title, body));
ipcMain.handle('notes:delete', (_, id) => { db.deleteNote(id); return true; });
ipcMain.handle('notes:incrementCopy', (_, id) => db.incrementNoteCopyCount(id));
ipcMain.handle('notes:reorder', (_, orderedIds) => { db.reorderNotes(orderedIds); return true; });

ipcMain.handle('shell:openExternal', (_, url) => { shell.openExternal(url); return true; });

ipcMain.handle('audit:getLog', () => db.getAuditLog());
ipcMain.handle('campaigns:resume', (_, campaignId) => {
  db.updateCampaignStatus(campaignId, 'draft');
  db.logAudit('blast_resumed', { campaignId });
  return true;
});

ipcMain.handle('campaigns:reset', (_, campaignId) => {
  db.resetCampaign(campaignId);
  db.logAudit('campaign_reset', { campaignId });
  return true;
});

// ── Lead Submissions ──────────────────────────────────────────────────────────
const CHRIS_PHONE = '+17274120832';

ipcMain.handle('lead-submit:getAll', () => db.getLeadSubmissions());
ipcMain.handle('lead-submit:create', () => db.createLeadSubmission());
ipcMain.handle('lead-submit:update', (_, { id, fields }) => db.updateLeadSubmission(id, fields));
ipcMain.handle('lead-submit:delete', (_, id) => { db.deleteLeadSubmission(id); return true; });
ipcMain.handle('lead-submit:getConvMedia', () => db.getConversationMedia());
ipcMain.handle('lead-submit:setOutcome', (_, { id, outcome }) => db.updateLeadSubmission(id, { outcome }));
ipcMain.handle('lead-submit:setContact', (_, { id, contactId }) => db.updateLeadSubmission(id, { contact_id: contactId }));
ipcMain.handle('campaigns:getLeadKPIs', (_, campaignId) => db.getLeadKPIsByCampaign(campaignId));
ipcMain.handle('campaigns:getConvStats', (_, campaignId) => db.getCampaignConversationStats(campaignId));

ipcMain.handle('lead-submit:pickPhoto', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Photos',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('lead-submit:send', async (_, { id }) => {
  const settings = db.getAllSettings();
  if (!settings.accountSid || !settings.authToken || !settings.phoneNumber) {
    throw new Error('Twilio not configured. Go to Settings first.');
  }
  const sub = db.getLeadSubmission(id);
  if (!sub) throw new Error('Submission not found');
  if (!sub.address || !sub.asking_price) throw new Error('Address and asking price are required.');

  const isUpdate = Boolean(sub.tier1_sent_at);
  const addr = sub.address;
  const photos = JSON.parse(sub.photo_paths || '[]');

  const lines = [];

  // Header
  lines.push(isUpdate ? `🔄 LEAD UPDATE — ${addr}` : `🏠 NEW LEAD — ${addr}`);

  // T1 block — always included (it's the gate)
  lines.push(`Asking: ${sub.asking_price} | Off-Market: ${sub.is_off_market ? '✅ Yes' : '❌ No'}`);
  if (sub.extra1) lines.push(`Notes: ${sub.extra1}`);

  // T2 block — include if any data
  const hasBeds = sub.beds || sub.baths || sub.sqft;
  if (hasBeds || sub.extra2) {
    lines.push('---');
    const parts = [];
    if (sub.beds)  parts.push(`Beds: ${sub.beds}`);
    if (sub.baths) parts.push(`Baths: ${sub.baths}`);
    if (sub.sqft)  parts.push(`Sqft: ${sub.sqft}`);
    if (parts.length) lines.push(parts.join(' | '));
    if (sub.extra2) lines.push(`Notes: ${sub.extra2}`);
  }

  // Upload photos sequentially to avoid rate-limiting on the hosting service
  const mediaUrls = [];
  for (const p of photos) {
    try {
      const url = await twilio.uploadPhotoForMMS(p);
      mediaUrls.push(url);
    } catch (e) {
      log('Photo upload failed:', e.message);
    }
  }

  // T3 block — include if any data
  if (sub.description || sub.extra3 || photos.length > 0) {
    lines.push('---');
    if (sub.description) lines.push(`Condition: ${sub.description}`);
    if (sub.extra3) lines.push(`Notes: ${sub.extra3}`);
    const failed = photos.length - mediaUrls.length;
    if (failed > 0) lines.push(`Photos: ${mediaUrls.length} attached, ${failed} failed to upload`);
  }

  // Send text first, then photos in batches of 3 (carrier MMS size limit)
  await twilio.sendSMS(settings.accountSid, settings.authToken, settings.phoneNumber, CHRIS_PHONE, lines.join('\n'), settings.messagingServiceSid, []);
  for (let i = 0; i < mediaUrls.length; i += 3) {
    const batch = mediaUrls.slice(i, i + 3);
    await twilio.sendSMS(settings.accountSid, settings.authToken, settings.phoneNumber, CHRIS_PHONE, '', settings.messagingServiceSid, batch);
  }

  const now = new Date().toISOString();
  db.updateLeadSubmission(id, {
    tier1_sent_at: sub.tier1_sent_at || now,
    final_sent_at: now,
  });
  db.logAudit(isUpdate ? 'lead_update_sent' : 'lead_submitted', { id, address: sub.address });
  return db.getLeadSubmission(id);
});
