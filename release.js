#!/usr/bin/env node
// Usage: node release.js 1.2
// Builds the app, extracts app.asar, and publishes a GitHub release.
// Requires: gh CLI installed and authenticated (gh auth login)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GITHUB_REPO = 'sockhead360/agentcrm-releases';
const newVersion = process.argv[2];

if (!newVersion) {
  console.error('\nUsage: node release.js <version>  (e.g. node release.js 1.2)\n');
  process.exit(1);
}

const pkgPath = path.join(__dirname, 'package.json');
const asarSrc  = path.join(__dirname, 'dist/mac/AgentCRM.app/Contents/Resources/app.asar');
const asarTmp  = path.join(__dirname, '_release_app.asar');

// 1. Bump version (package.json needs semver x.y.z, so pad if needed)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const prevVersion = pkg.version;
const semverVersion = newVersion.split('.').length === 2 ? newVersion + '.0' : newVersion;
pkg.version = semverVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n✓ Version: ${prevVersion} → ${newVersion}`);

// 2. Build
console.log('Building (this takes ~30 seconds)...\n');
try {
  execSync('npm run dist', { stdio: 'inherit', cwd: __dirname });
} catch (e) {
  console.error('\n✗ Build failed. Reverting version.\n');
  pkg.version = prevVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  process.exit(1);
}

// 3. Copy app.asar out to a temp file
fs.copyFileSync(asarSrc, asarTmp);
console.log(`\n✓ Extracted app.asar (${(fs.statSync(asarTmp).size / 1024 / 1024).toFixed(1)} MB)`);

// 4. Create GitHub release with app.asar
console.log(`\nPublishing release v${newVersion} to github.com/${GITHUB_REPO}...`);
try {
  execSync(
    `gh release create v${newVersion} "${asarTmp}#app.asar" ` +
    `--repo ${GITHUB_REPO} ` +
    `--title "AgentCRM v${newVersion}" ` +
    `--notes "AgentCRM v${newVersion}"`,
    { stdio: 'inherit', cwd: __dirname }
  );
} catch (e) {
  console.error('\n✗ GitHub release failed.');
  console.error('Make sure you have the gh CLI installed: https://cli.github.com');
  console.error('And authenticated: gh auth login\n');
  fs.unlinkSync(asarTmp);
  process.exit(1);
}

// 5. Clean up
fs.unlinkSync(asarTmp);

console.log(`
✅ Done! AgentCRM v${newVersion} is live.
   Your partner can now open Settings → Check for Updates and hit Update Now.
`);
