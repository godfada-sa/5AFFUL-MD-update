/* Safful-Md protected-release integrity guard.
 * Runs once at plugin load (startup). Hashes every runtime code file
 * (*.js / *.smd) listed in RELEASE-MANIFEST.json and refuses to start the
 * bot if any file was modified or removed since the release was built.
 * Bypass with the environment variable SAFFUL_SKIP_INTEGRITY_CHECK=1.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (global.__saffulIntegrityChecked) {
  // Already verified this session — skip duplicate runs from plugin loader.
} else {
  global.__saffulIntegrityChecked = true;

  function findReleaseRoot() {
    let dir = __dirname;
    for (let depth = 0; depth < 4; depth++) {
      if (fs.existsSync(path.join(dir, 'RELEASE-MANIFEST.json'))) return dir;
      dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '..');
  }

  const skip = String(process.env.SAFFUL_SKIP_INTEGRITY_CHECK || '').toLowerCase();
  if (skip === '1' || skip === 'true') {
    // guard disabled
  } else {
    const root = findReleaseRoot();
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
    } catch (error) {
      console.error('[integrity] FATAL: cannot read RELEASE-MANIFEST.json (' + (error && error.message) + ')');
      process.exit(1);
    }
    const tracked = (manifest.protectedFiles || []).filter((entry) => /\.(js|smd)$/.test(entry.file));
    const bad = [];
    for (const entry of tracked) {
      let actual;
      try {
        actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.file))).digest('hex');
      } catch (error) {
        bad.push(entry.file + ' (missing or unreadable)');
        continue;
      }
      if (actual !== entry.sha256) bad.push(entry.file);
    }
    if (bad.length === 0) {
      console.log('[integrity] protected runtime files verified (' + tracked.length + ' files, sha256)');
    } else {
      console.error('');
      console.error('  ============================================================');
      console.error('  !  SAFFUL-MD RELEASE INTEGRITY CHECK FAILED               !');
      console.error('  !  Runtime files were modified or removed:                !');
      bad.slice(0, 25).forEach((file) => console.error('  !    - ' + file));
      console.error('  !  The bot will not start. Restore the original files or  !');
      console.error('  !  set SAFFUL_SKIP_INTEGRITY_CHECK=1 to bypass this guard.!');
      console.error('  ============================================================');
      console.error('');
      process.exit(1);
    }
  }
}
