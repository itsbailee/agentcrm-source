# AgentCRM — Claude Instructions

## After every code change
Always run `node deploy.js` from `/Users/seymorecash/agent-crm/`. Do NOT run `npm run dist` or open DMGs. Deploy script handles everything:
- Auto-bumps patch version
- Rebuilds React bundle
- Packs and installs new app.asar directly to /Applications/AgentCRM.app
- Publishes to GitHub (partner's Update Now button)
- Kills old app and relaunches

Never tell the user to drag a DMG or delete an old app. The deploy script is the only step needed after any change.

## Build commands
- `node build.js` — rebuild React bundle only (no install)
- `node deploy.js` — full deploy: build + install + GitHub + relaunch
- `npm run dist` — only used when generating a first-time DMG for a new user

## Stack
Electron 33, React 19, better-sqlite3, axios (Twilio REST), esbuild

## Key files
- `main.js` — Electron main process, all IPC handlers
- `database.js` — SQLite operations
- `twilio.js` — Twilio REST API
- `updater.js` — GitHub release update checker/installer
- `preload.js` — contextBridge API
- `src/App.jsx` — tab routing
- `src/components/` — all UI components
- `deploy.js` — post-change deploy script
- `release.js` — legacy, use deploy.js instead
